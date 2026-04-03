#!/usr/bin/env python3
"""Tiny linear regression training script with validation logging and probing."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from aim.sdk.agent import research_agent_logger


LOGGER = research_agent_logger.ResearchAgentLogger()
DATASET_NUM_SAMPLES = 128
DATASET_NOISE_SCALE = 0.05
PROBER_CACHE_VERSION = 2
DATA_CACHE_PATH = (
    Path(__file__).resolve().parent / ".codex" / f"prober_dataset_split_cache_v{PROBER_CACHE_VERSION}.npz"
)


@dataclass
class TrainResult:
    weight: float
    bias: float
    train_losses: list[float]
    val_losses: list[float]
    val_x: np.ndarray
    val_y: np.ndarray
    epochs: int


def generate_dataset(
    num_samples: int = DATASET_NUM_SAMPLES,
    noise_scale: float = DATASET_NOISE_SCALE,
    rng: np.random.Generator | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Create a toy dataset where y = 3x + 1 with Gaussian noise."""
    rng = rng or np.random.default_rng()
    x = np.linspace(-1.0, 1.0, num_samples)
    noise = rng.normal(scale=noise_scale, size=num_samples)
    y = 3.0 * x + 1.0 + noise
    return x.reshape(-1, 1), y.reshape(-1, 1)


def _mean_squared_error(preds: np.ndarray, targets: np.ndarray) -> float:
    return float(np.mean((preds - targets) ** 2))


def _mean_absolute_error(preds: np.ndarray, targets: np.ndarray) -> float:
    return float(np.mean(np.abs(preds - targets)))


def _dataset_cache_path() -> Path:
    override = os.getenv("PROBER_DATA_CACHE")
    return Path(override) if override else DATA_CACHE_PATH


def _dataset_metadata(seed: int | None) -> dict[str, object]:
    return {
        "version": PROBER_CACHE_VERSION,
        "seed": seed,
        "num_samples": DATASET_NUM_SAMPLES,
        "noise_scale": DATASET_NOISE_SCALE,
    }


def _load_cached_split(
    cache_path: Path, expected_metadata: dict[str, object]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None:
    if not cache_path.exists():
        return None
    try:
        with np.load(cache_path, allow_pickle=False) as data:  # type: ignore[call-arg]
            required = {"x", "y", "train_idx", "val_idx", "metadata"}
            if not required.issubset(set(data.files)):
                return None
            try:
                metadata = json.loads(str(data["metadata"]))
            except json.JSONDecodeError:
                return None
            if metadata != expected_metadata:
                return None
            return data["x"], data["y"], data["train_idx"], data["val_idx"]
    except (OSError, ValueError):
        return None


def _save_cached_split(
    cache_path: Path,
    x: np.ndarray,
    y: np.ndarray,
    train_idx: np.ndarray,
    val_idx: np.ndarray,
    metadata: dict[str, object],
) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_json = json.dumps(metadata, sort_keys=True)
    np.savez(cache_path, x=x, y=y, train_idx=train_idx, val_idx=val_idx, metadata=metadata_json)


def _least_squares_init(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Return the closed-form linear regression weights for a 1D dataset."""
    design = np.concatenate([x, np.ones_like(x)], axis=1)
    solution, *_ = np.linalg.lstsq(design, y, rcond=None)
    params = solution.squeeze()
    weight = float(params[0]) if params.ndim else float(params)
    bias = float(params[1]) if params.ndim else 0.0
    return weight, bias


def train_linear_regression(
    epochs: int = 200,
    lr: float = 0.1,
    seed: int | None = None,
    stability_tol: float = 1e-12,
    cache_dataset: bool = False,
    reset_cache: bool = False,
) -> TrainResult:
    """Train a 1D linear regression model with vanilla gradient descent."""
    rng = np.random.default_rng(seed)
    use_cached_dataset = os.getenv("PROBER_ACTIVE") == "1" or cache_dataset
    dataset_cache_path = _dataset_cache_path()
    expected_metadata = _dataset_metadata(seed)
    if use_cached_dataset and reset_cache and dataset_cache_path.exists():
        dataset_cache_path.unlink()
    cached = _load_cached_split(dataset_cache_path, expected_metadata) if use_cached_dataset else None
    if cached is not None:
        x, y, train_idx, val_idx = cached
        train_idx = train_idx.astype(np.int64)
        val_idx = val_idx.astype(np.int64)
    else:
        x, y = generate_dataset(
            num_samples=DATASET_NUM_SAMPLES,
            noise_scale=DATASET_NOISE_SCALE,
            rng=rng,
        )
        indices = rng.permutation(len(x))
        split_idx = int(0.8 * len(x))
        train_idx, val_idx = indices[:split_idx], indices[split_idx:]
        if use_cached_dataset:
            _save_cached_split(dataset_cache_path, x, y, train_idx, val_idx, expected_metadata)

    x_train, y_train = x[train_idx], y[train_idx]
    x_val, y_val = x[val_idx], y[val_idx]

    weight, bias = _least_squares_init(x_train, y_train)
    freeze_updates = False

    train_losses: list[float] = []
    val_losses: list[float] = []

    for epoch in range(1, epochs + 1):
        preds = weight * x_train + bias
        error = preds - y_train
        train_loss = _mean_squared_error(preds, y_train)

        grad_w = float((2 / len(x_train)) * np.sum(error * x_train))
        grad_b = float((2 / len(x_train)) * np.sum(error))

        grad_norm = float(np.hypot(grad_w, grad_b))
        if freeze_updates or grad_norm < stability_tol:
            freeze_updates = True  # keep optimal params stable once converged
        else:
            weight -= lr * grad_w
            bias -= lr * grad_b

        val_preds = weight * x_val + bias
        val_loss = _mean_squared_error(val_preds, y_val)

        train_losses.append(train_loss)
        val_losses.append(val_loss)
        print(
            f"epoch={epoch:03d} train_loss={train_loss:.6f} val_loss={val_loss:.6f} "
            f"w={weight:.3f} b={bias:.3f}"
        )

    return TrainResult(weight, bias, train_losses, val_losses, x_val, y_val, epochs)


def evaluate_metrics(result: TrainResult) -> dict[str, float]:
    preds = result.weight * result.val_x + result.bias
    return {
        "val_mse": _mean_squared_error(preds, result.val_y),
        "val_mae": _mean_absolute_error(preds, result.val_y),
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=200, help="number of training epochs")
    parser.add_argument("--lr", type=float, default=0.1, help="gradient descent learning rate")
    parser.add_argument("--seed", type=int, default=0, help="random seed for reproducibility")
    parser.add_argument(
        "--cache-dataset",
        action="store_true",
        help="cache dataset and split on disk for deterministic reruns even outside the prober",
    )
    parser.add_argument(
        "--reset-cache",
        action="store_true",
        help="delete any existing cached dataset before (re)creating it",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    result = train_linear_regression(
        epochs=args.epochs,
        lr=args.lr,
        seed=args.seed,
        cache_dataset=args.cache_dataset,
        reset_cache=args.reset_cache,
    )
    metrics = evaluate_metrics(result)
    for name, value in metrics.items():
        LOGGER.log(
            f"{research_agent_logger.AGENT_LOG_TEST_PREFIX}{name}",
            value,
            step=result.epochs,
            epoch=result.epochs,
        )
    print(f"final parameters -> weight={result.weight:.3f}, bias={result.bias:.3f}")

    if os.getenv("PROBER_ACTIVE") != "1":
        from prober import Prober

        prober = Prober()
        prober.run()


if __name__ == "__main__":
    main()
