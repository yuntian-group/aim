"""Counterfactual probing utilities for the MIMIC mortality model."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import torch
from torch import nn
from torch.utils.data import DataLoader

from aim.sdk.agent.research_agent_logger import ResearchAgentLogger
from dataset import MIMICMortalityDataset


@dataclass(frozen=True)
class CounterfactualProberConfig:
    """Runtime configuration for the counterfactual prober."""

    data_dir: Path
    ckpt_path: Path
    batch_size: int
    device: torch.device


class EthnicityCounterfactualProber:
    """Swaps ethnicity features to quantify counterfactual sensitivity."""

    def __init__(
        self,
        model_factory: Callable[[], nn.Module],
        agent_logger: ResearchAgentLogger,
        config: CounterfactualProberConfig,
        eth_names: Sequence[str] | None = None,
    ) -> None:
        self._model_factory = model_factory
        self._agent_logger = agent_logger
        self._config = config
        self._eth_names = list(eth_names) if eth_names is not None else None

    def run(self) -> None:
        """Executes the counterfactual probing routine."""
        dataset = MIMICMortalityDataset(self._config.data_dir, 'test')
        loader = DataLoader(dataset, batch_size=self._config.batch_size, shuffle=False)

        model = self._model_factory().to(self._config.device)
        state_dict = torch.load(
            self._config.ckpt_path, map_location=self._config.device, weights_only=True
        )
        model.load_state_dict(state_dict)
        model.eval()

        tfidf_dim = dataset.tfidf.shape[1]
        eth_dim = dataset.eth.shape[1]
        eth_names = self._resolve_eth_names(eth_dim)

        # Aggregation buffers kept on CPU for numerical stability.
        sum_shift = torch.zeros(eth_dim, dtype=torch.float64)
        sum_sq_shift = torch.zeros_like(sum_shift)
        max_shift = torch.zeros(eth_dim, dtype=torch.float32)
        total_count = 0

        swap_sum = torch.zeros((eth_dim, eth_dim), dtype=torch.float64)
        swap_sum_sq = torch.zeros_like(swap_sum)
        swap_count = torch.zeros_like(swap_sum)

        all_shift_values: list[torch.Tensor] = []
        eye = torch.eye(eth_dim, dtype=torch.float32, device=self._config.device)

        with torch.no_grad():
            for batch in loader:
                features = batch['features'].to(self._config.device)
                base_probs = model(features).sigmoid()
                tfidf_features = features[:, :tfidf_dim]
                batch_size = tfidf_features.size(0)

                tfidf_expanded = tfidf_features.unsqueeze(1).expand(-1, eth_dim, -1)
                swap_eth = eye.unsqueeze(0).expand(batch_size, -1, -1)

                swapped = torch.cat([tfidf_expanded, swap_eth], dim=2).reshape(
                    batch_size * eth_dim, tfidf_dim + eth_dim
                )
                swapped_probs = model(swapped).sigmoid().view(batch_size, eth_dim)
                shift = (swapped_probs - base_probs.unsqueeze(1)).abs()

                shift_cpu = shift.detach().cpu().double()
                sum_shift += shift_cpu.sum(dim=0)
                sum_sq_shift += (shift_cpu**2).sum(dim=0)
                max_shift = torch.maximum(
                    max_shift, shift_cpu.float().max(dim=0).values.cpu()
                )
                total_count += batch_size
                all_shift_values.append(shift_cpu.reshape(-1))

                # Swap-level aggregations conditioned on the original ethnicity.
                orig_eth = features[:, tfidf_dim:].detach().cpu().double()
                swap_sum += orig_eth.T @ shift_cpu
                swap_sum_sq += orig_eth.T @ (shift_cpu**2)
                swap_count += orig_eth.T @ torch.ones_like(shift_cpu)

        if total_count == 0:
            return

        group_mean = sum_shift / total_count
        group_var = torch.clamp((sum_sq_shift / total_count) - group_mean**2, min=0.0)

        for idx, name in enumerate(eth_names):
            safe_name = self._sanitize_name(name)
            self._agent_logger.log(
                f'agent_log_prober_eth_{safe_name}_mean_shift',
                group_mean[idx].item(),
                step=None,
                epoch=None,
            )
            self._agent_logger.log(
                f'agent_log_prober_eth_{safe_name}_var_shift',
                group_var[idx].item(),
                step=None,
                epoch=None,
            )
            self._agent_logger.log(
                f'agent_log_prober_eth_{safe_name}_max_shift',
                max_shift[idx].item(),
                step=None,
                epoch=None,
            )

        # Swap-level statistics (original -> swapped target).
        swap_mean = torch.zeros_like(swap_sum)
        swap_var = torch.zeros_like(swap_sum)
        valid = swap_count > 0
        swap_mean[valid] = swap_sum[valid] / swap_count[valid]
        swap_var[valid] = torch.clamp(
            (swap_sum_sq[valid] / swap_count[valid]) - swap_mean[valid] ** 2, min=0.0
        )

        for i, src in enumerate(eth_names):
            for j, tgt in enumerate(eth_names):
                if swap_count[i, j] == 0:
                    continue
                prefix = (
                    f'agent_log_prober_swap_{self._sanitize_name(src)}_to_'
                    f'{self._sanitize_name(tgt)}'
                )
                self._agent_logger.log(
                    f'{prefix}_mean_shift',
                    swap_mean[i, j].item(),
                    step=None,
                    epoch=None,
                )
                self._agent_logger.log(
                    f'{prefix}_var_shift',
                    swap_var[i, j].item(),
                    step=None,
                    epoch=None,
                )

        self._log_distribution_artifacts(all_shift_values)

    def _log_distribution_artifacts(self, shift_chunks: Sequence[torch.Tensor]) -> None:
        """Logs aggregate distribution summaries and a histogram artifact."""
        if not shift_chunks:
            return
        shifts = torch.cat(shift_chunks).float()
        overall_mean = shifts.mean().item()
        overall_std = shifts.std(unbiased=False).item()
        overall_max = shifts.max().item()
        for name, value in (
            ('mean', overall_mean),
            ('std', overall_std),
            ('max', overall_max),
        ):
            self._agent_logger.log(
                f'agent_log_prober_shift_distribution_{name}',
                value,
                step=None,
                epoch=None,
            )

        hist_path = self._config.ckpt_path.parent / 'agent_log_prober_eth_shift_hist.png'
        hist_path.parent.mkdir(parents=True, exist_ok=True)
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.hist(shifts.numpy(), bins=40, color='tab:blue', alpha=0.85)
        ax.set_title('Counterfactual Ethnicity Shift Distribution')
        ax.set_xlabel('Absolute probability shift')
        ax.set_ylabel('Frequency')
        fig.tight_layout()
        fig.savefig(hist_path, dpi=200)
        plt.close(fig)
        self._agent_logger.track_figure(
            'agent_log_prober_eth_shift_hist', str(hist_path.resolve())
        )

    def _resolve_eth_names(self, eth_dim: int) -> list[str]:
        if self._eth_names and len(self._eth_names) == eth_dim:
            return list(self._eth_names)
        return [f'eth_{idx}' for idx in range(eth_dim)]

    @staticmethod
    def _sanitize_name(name: str) -> str:
        return name.strip().lower().replace(' ', '_')

