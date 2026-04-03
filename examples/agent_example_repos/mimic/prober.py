"""Model probers for the MIMIC training pipeline."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import matplotlib.pyplot as plt
import numpy as np
import torch
from aim.sdk.agent.research_agent_logger import ResearchAgentLogger
from dataset import MIMICMortalityDataset
from torch.utils.data import DataLoader

logger = logging.getLogger(__name__)


@dataclass
class CounterfactualProberConfig:
    """Configuration shared by counterfactual probers."""

    data_dir: Path
    ckpt_path: Path
    batch_size: int
    device: torch.device
    split: str = 'test'

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        self.ckpt_path = Path(self.ckpt_path)
        if self.split not in {'train', 'val', 'test'}:
            raise ValueError(f"Unsupported split '{self.split}'.")


def _load_state_dict(path: Path, device: torch.device) -> dict[str, torch.Tensor]:
    """Load a checkpoint while remaining compatible with older torch versions."""

    kwargs = {'map_location': device}
    try:
        return torch.load(path, weights_only=True, **kwargs)
    except TypeError:
        return torch.load(path, **kwargs)


class AUROCHistoryCache:
    """Persists a short validation AUROC history for plateau detection."""

    def __init__(self, path: Path, max_length: int = 20) -> None:
        self.path = Path(path)
        self.max_length = max_length

    def load(self) -> list[float]:
        if not self.path.is_file():
            return []
        try:
            with self.path.open('r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError, json.JSONDecodeError):
            logger.warning("Failed to read AUROC history at %s; starting fresh", self.path)
            return []
        if isinstance(data, list):
            values: list[float] = []
            for item in data:
                try:
                    values.append(float(item))
                except (TypeError, ValueError):
                    continue
            return values[-self.max_length:]
        return []

    def append(self, value: float) -> list[float]:
        history = self.load()
        history.append(float(value))
        history = history[-self.max_length:]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open('w', encoding='utf-8') as f:
            json.dump(history, f)
        return history


class EthnicityCounterfactualProber:
    """Assesses counterfactual sensitivity to ethnicity one-hot swaps."""

    def __init__(
        self,
        model_factory: Callable[[], torch.nn.Module],
        agent_logger: ResearchAgentLogger,
        config: CounterfactualProberConfig,
        eth_names: Sequence[str],
    ) -> None:
        self.model_factory = model_factory
        self.agent_logger = agent_logger
        self.config = config
        self.eth_names = list(eth_names)

    @torch.no_grad()
    def run(self) -> None:
        if not self.eth_names:
            logger.warning("EthnicityCounterfactualProber: no ethnicity names provided; skipping.")
            return

        dataset = MIMICMortalityDataset(self.config.data_dir, self.config.split, use_eth=True)
        loader = DataLoader(dataset, batch_size=self.config.batch_size, shuffle=False)

        model = self.model_factory().to(self.config.device)
        state_dict = _load_state_dict(self.config.ckpt_path, self.config.device)
        model.load_state_dict(state_dict)
        model.eval()

        eth_dim = len(self.eth_names)
        per_eth_sum = {name: 0.0 for name in self.eth_names}
        gap_values: list[float] = []
        total_samples = 0

        for batch in loader:
            features = batch['features'].to(self.config.device)
            batch_size = features.shape[0]
            total_samples += batch_size
            tfidf_part = features[:, :-eth_dim]
            base_cf = torch.cat(
                [tfidf_part, torch.zeros(batch_size, eth_dim, device=self.config.device)],
                dim=1,
            )

            cf_probs: list[torch.Tensor] = []
            for idx, name in enumerate(self.eth_names):
                cf_features = base_cf.clone()
                cf_features[:, -eth_dim + idx] = 1.0
                logits = model(cf_features)
                probs = logits.sigmoid()
                cf_probs.append(probs)
                per_eth_sum[name] += probs.sum().item()

            cf_prob_tensor = torch.stack(cf_probs, dim=0)
            per_sample_gap = cf_prob_tensor.max(dim=0).values - cf_prob_tensor.min(dim=0).values
            gap_values.extend(per_sample_gap.cpu().tolist())

        if total_samples == 0:
            logger.warning("EthnicityCounterfactualProber: dataset is empty; nothing to log.")
            return

        per_eth_mean = {
            name: per_eth_sum[name] / total_samples for name in self.eth_names
        }
        gap_arr = np.asarray(gap_values, dtype=np.float32)
        mean_gap = float(gap_arr.mean()) if gap_arr.size else 0.0
        p95_gap = float(np.quantile(gap_arr, 0.95)) if gap_arr.size else 0.0

        self.agent_logger.log('agent_log_prober_eth_gap_mean', mean_gap)
        self.agent_logger.log('agent_log_prober_eth_gap_p95', p95_gap)
        self.agent_logger.log('agent_log_prober_eth_samples', float(total_samples))
        for name, mean_val in per_eth_mean.items():
            metric_name = f'agent_log_prober_eth_mean_prob_{name}'
            self.agent_logger.log(metric_name, float(mean_val))

        self._log_figure(per_eth_mean)

    def _log_figure(self, per_eth_mean: dict[str, float]) -> None:
        labels = list(per_eth_mean.keys())
        values = [per_eth_mean[name] for name in labels]
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.bar(labels, values, color='#4c72b0', alpha=0.85)
        ax.set_ylabel('Mean predicted mortality probability')
        ax.set_xlabel('Counterfactual ethnicity')
        ax.set_ylim(0.0, 1.0)
        ax.set_title('Counterfactual sensitivity by ethnicity')
        fig.tight_layout()

        figure_dir = self.config.ckpt_path.parent / 'prober_figures'
        figure_dir.mkdir(parents=True, exist_ok=True)
        figure_path = figure_dir / 'ethnicity_counterfactual.png'
        fig.savefig(figure_path, bbox_inches='tight')
        plt.close(fig)

        self.agent_logger.track_figure('agent_log_prober_ethnicity_counterfactual', str(figure_path))


class ValidationAUROCThresholdProber:
    """Detects AUROC plateaus using validation metrics and cached history."""

    def __init__(
        self,
        model: torch.nn.Module,
        val_loader: DataLoader,
        criterion: torch.nn.Module,
        device: torch.device,
        agent_logger: ResearchAgentLogger,
        evaluate_fn: Callable[[torch.nn.Module, DataLoader, torch.nn.Module, torch.device], dict[str, float]],
        history_path: Path,
        reference_auroc: float = 0.78,
        plateau_threshold: float = -0.02,
    ) -> None:
        self.model = model
        self.val_loader = val_loader
        self.criterion = criterion
        self.device = device
        self.agent_logger = agent_logger
        self.evaluate_fn = evaluate_fn
        self.reference_auroc = reference_auroc
        self.plateau_threshold = plateau_threshold
        self.history_cache = AUROCHistoryCache(Path(history_path))
        self.figure_path = self.history_cache.path.with_suffix('.png')

    @torch.no_grad()
    def run(self) -> None:
        metrics = self.evaluate_fn(self.model, self.val_loader, self.criterion, self.device)
        current_auroc = float(metrics.get('auroc', 0.0))
        history = self.history_cache.load()
        last_auroc = history[-1] if history else self.reference_auroc
        score = min(current_auroc - self.reference_auroc, current_auroc - last_auroc)
        plateau_flag = 1.0 if score < self.plateau_threshold else 0.0

        logger.info(
            "ValidationAUROCThresholdProber: current=%.4f last=%.4f score=%.4f (threshold %.2f, score >= -0.02 is good)",
            current_auroc,
            last_auroc,
            score,
            self.plateau_threshold,
        )

        self.agent_logger.log('agent_log_prober_val_auroc', current_auroc)
        self.agent_logger.log('agent_log_prober_auroc_plateau_score', score)
        self.agent_logger.log('agent_log_prober_auroc_plateau_flag', plateau_flag)

        updated_history = self.history_cache.append(current_auroc)
        self._log_history_figure(updated_history)

    def _log_history_figure(self, history: Sequence[float]) -> None:
        if not history:
            return
        trimmed = history[-20:]
        x_vals = list(range(len(trimmed)))
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.plot(x_vals, trimmed, marker='o', color='#dd8452', label='Validation AUROC')
        ax.axhline(self.reference_auroc, color='#c44e52', linestyle='--', label=f'Ref {self.reference_auroc:.2f}')
        ax.set_xlim(0, 20)
        ax.set_ylim(0.5, 1.0)
        ax.set_xlabel('Run index')
        ax.set_ylabel('Validation AUROC')
        ax.set_title('Validation AUROC history (plateau prober)')
        ax.legend(loc='lower right')
        fig.tight_layout()

        self.figure_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(self.figure_path, bbox_inches='tight')
        plt.close(fig)

        self.agent_logger.track_figure('agent_log_prober_auroc_plateau_history', str(self.figure_path))
