"""Model reproducibility prober."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import matplotlib.pyplot as plt

from aim.sdk.agent import research_agent_logger


class _ResearchAgentLogger(research_agent_logger.ResearchAgentLogger):
    def log_text(self, name: str, text: str) -> None:
        research_agent_logger._emit(  # pylint: disable=protected-access
            {
                "type": research_agent_logger.TYPE_LOG,
                "name": name,
                "text": text,
            }
        )


LOGGER = _ResearchAgentLogger()

VAL_LOSS_PATTERN = re.compile(
    r"epoch=(?P<epoch>\d+)\s+train_loss=(?P<train>[0-9eE+\-.]+)\s+val_loss=(?P<val>[0-9eE+\-.]+)"
)

RUN_CMD = ["python", "train.py", "--epochs=5", "--seed=0"]
DRIFT_THRESHOLD = 0.02


@dataclass
class RunResult:
    run_id: int
    epochs: Sequence[int]
    val_losses: Sequence[float]
    raw_stdout: str

    @property
    def final_loss(self) -> float:
        return self.val_losses[-1]


class Prober:
    """Runs deterministic training replicas and logs drift artifacts."""

    def __init__(self, working_dir: str | os.PathLike[str] | None = None):
        self.working_dir = Path(working_dir or Path(__file__).resolve().parent)

    def run(self) -> None:
        run_results = [self._run_and_parse(1), self._run_and_parse(2)]
        self._log_drift(run_results)

    def _run_and_parse(self, run_id: int) -> RunResult:
        env = os.environ.copy()
        env["PROBER_ACTIVE"] = "1"
        process = subprocess.run(
            RUN_CMD,
            cwd=self.working_dir,
            text=True,
            capture_output=True,
            check=True,
            env=env,
        )
        stdout = process.stdout
        epochs: list[int] = []
        val_losses: list[float] = []
        for line in stdout.splitlines():
            match = VAL_LOSS_PATTERN.search(line)
            if not match:
                continue
            epoch = int(match.group("epoch"))
            val_loss = float(match.group("val"))
            epochs.append(epoch)
            val_losses.append(val_loss)
            LOGGER.log(
                f"{research_agent_logger.AGENT_LOG_TEST_PREFIX}prober_run{run_id}_val_loss_epoch{epoch}",
                val_loss,
                step=epoch,
                epoch=epoch,
            )
        if len(epochs) != 5:
            raise RuntimeError(
                f"Expected 5 epochs worth of validation losses, got {len(epochs)} for run {run_id}"
            )
        LOGGER.log(
            f"{research_agent_logger.AGENT_LOG_TEST_PREFIX}prober_run{run_id}_val_loss_final",
            val_losses[-1],
            step=epochs[-1],
            epoch=epochs[-1],
        )
        return RunResult(run_id, epochs, val_losses, stdout)

    def _log_drift(self, runs: Sequence[RunResult]) -> None:
        final_losses = [run.final_loss for run in runs]
        drift = abs(final_losses[1] - final_losses[0])
        LOGGER.log(
            f"{research_agent_logger.AGENT_LOG_PROBER_PREFIX}loss_drift_final",
            drift,
            step=runs[-1].epochs[-1],
            epoch=runs[-1].epochs[-1],
        )
        LOGGER.log(
            f"{research_agent_logger.AGENT_LOG_PROBER_PREFIX}loss_drift_threshold",
            DRIFT_THRESHOLD,
        )
        figure_path = self._plot_runs(runs)
        LOGGER.track_figure(
            f"{research_agent_logger.AGENT_LOG_PROBER_PREFIX}loss_drift_plot",
            str(figure_path),
        )
        summary = self._build_summary(runs, drift)
        LOGGER.log_text(
            f"{research_agent_logger.AGENT_LOG_PROBER_PREFIX}loss_drift_summary",
            summary,
        )

    def _plot_runs(self, runs: Sequence[RunResult]) -> Path:
        fig, ax = plt.subplots(figsize=(6, 4))
        max_loss = max(max(run.val_losses) for run in runs)
        scale = max(1.0, max_loss)
        for run in runs:
            normalized = [val / scale for val in run.val_losses]
            ax.plot(run.epochs, normalized, marker="o", label=f"Run {run.run_id}")
        ax.set_title("Deterministic Validation Loss Drift (normalized)")
        ax.set_xlabel("Epoch")
        ax.set_ylabel("Normalized Validation Loss")
        ax.set_xlim(1, 5)
        ax.set_ylim(0, 1)
        ax.set_xticks(list(range(1, 6)))
        ax.grid(True, linestyle="--", linewidth=0.5)
        ax.legend()
        tmp_dir = Path(tempfile.mkdtemp(prefix="prober_"))
        fig_path = tmp_dir / "loss_drift.png"
        fig.tight_layout()
        fig.savefig(fig_path)
        plt.close(fig)
        return fig_path

    def _build_summary(self, runs: Sequence[RunResult], drift: float) -> str:
        status = "bad" if drift > DRIFT_THRESHOLD else "good"
        return (
            "Deterministic reruns finished with final validation losses "
            f"{runs[0].final_loss:.6f} and {runs[1].final_loss:.6f}; "
            f"drift={drift:.6f} (threshold={DRIFT_THRESHOLD:.2f}) -> {status.upper()}."
        )


__all__ = ["Prober"]
