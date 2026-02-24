"""Train a logistic regression model for ICU mortality prediction (MIMIC-III).

Expects pre-computed TF-IDF feature files produced by preprocess.py:
    {split}_tfidf.npz, {split}_meta.npz

Usage:
    python train.py --data_dir examples/data/mimiciii
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import f1_score, roc_auc_score
from torch.utils.data import DataLoader
from tqdm import tqdm

from dataset import MIMICMortalityDataset

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BATCH_SIZE = 256
LEARNING_RATE = 2
NUM_EPOCHS = 50
SEED = 42

SCRIPT_DIR = Path(__file__).resolve().parent
CKPT_DIR = SCRIPT_DIR / "checkpoint"

ETH_NAMES = ["white", "black", "hispanic", "asian", "other"]


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
class LogisticRegression(nn.Module):
    """Single linear layer -> sigmoid (via BCEWithLogitsLoss)."""

    def __init__(self, input_dim: int) -> None:
        super().__init__()
        self.linear = nn.Linear(input_dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.linear(x).squeeze(-1)


# ---------------------------------------------------------------------------
# Device helper
# ---------------------------------------------------------------------------
def select_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


# ---------------------------------------------------------------------------
# Train / eval
# ---------------------------------------------------------------------------
def train_one_epoch(
    model: nn.Module,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    criterion: nn.Module,
    device: torch.device,
) -> float:
    model.train()
    running_loss = 0.0
    for batch in tqdm(loader, desc="  Train", leave=False):
        features = batch["features"].to(device)
        labels = batch["label"].to(device)

        logits = model(features)
        loss = criterion(logits, labels)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        running_loss += loss.item()
    return running_loss / len(loader)


@torch.no_grad()
def evaluate(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    device: torch.device,
) -> dict[str, float]:
    model.eval()
    total_loss = 0.0
    all_probs: list[torch.Tensor] = []
    all_labels: list[torch.Tensor] = []

    for batch in tqdm(loader, desc="  Eval ", leave=False):
        features = batch["features"].to(device)
        labels = batch["label"].to(device)

        logits = model(features)
        total_loss += criterion(logits, labels).item()

        all_probs.append(logits.sigmoid().cpu())
        all_labels.append(labels.cpu())

    probs = torch.cat(all_probs).numpy()
    labels = torch.cat(all_labels).numpy()
    preds = (probs >= 0.5).astype(int)

    return {
        "loss": total_loss / len(loader),
        "auroc": roc_auc_score(labels, probs),
        "f1": f1_score(labels, preds, zero_division=0),
        "acc": float((preds == labels).mean()),
    }


# ---------------------------------------------------------------------------
# Bias analysis
# ---------------------------------------------------------------------------
@torch.no_grad()
def bias_analysis(
    model: nn.Module,
    dataset: MIMICMortalityDataset,
    loader: DataLoader,
    device: torch.device,
    save_path: Path,
) -> None:
    """Compute per-ethnicity error rates on the given split and save a bar chart."""
    model.eval()
    all_probs: list[torch.Tensor] = []
    for batch in tqdm(loader, desc="  Bias ", leave=False):
        logits = model(batch["features"].to(device))
        all_probs.append(logits.sigmoid().cpu())

    probs = torch.cat(all_probs).numpy()
    preds = (probs >= 0.5).astype(int)
    labels = dataset.labels.numpy().astype(int)
    eth = dataset.eth.numpy()  # (n, 5) one-hot

    error_rates: dict[str, float] = {}
    counts: dict[str, int] = {}
    for i, name in enumerate(ETH_NAMES):
        mask = eth[:, i] == 1
        n = int(mask.sum())
        if n == 0:
            continue
        errors = int((preds[mask] != labels[mask]).sum())
        error_rates[name] = errors / n
        counts[name] = n

    # Log results
    logger.info("=== Per-ethnicity error rates (test set) ===")
    for name in error_rates:
        logger.info("  %-10s  n=%5d  error_rate=%.4f", name, counts[name], error_rates[name])

    # Bar chart
    groups = list(error_rates.keys())
    rates = [error_rates[g] for g in groups]
    ns = [counts[g] for g in groups]

    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(groups, rates, color="#4C72B0", edgecolor="white", linewidth=0.8)

    for bar, rate, n in zip(bars, rates, ns):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.005,
            f"{rate:.2%}\n(n={n})",
            ha="center", va="bottom", fontsize=10,
        )

    ax.set_xlabel("Ethnicity Group", fontsize=12)
    ax.set_ylabel("Error Rate", fontsize=12)
    ax.set_title("ICU Mortality Prediction — Error Rate by Ethnicity", fontsize=13)
    ax.set_ylim(0, max(rates) * 1.25 if rates else 1.0)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()

    chart_path = save_path / "bias_error_rate.png"
    fig.savefig(chart_path, dpi=150)
    plt.close(fig)
    logger.info("Bias analysis chart saved to %s", chart_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(data_dir: str) -> None:
    torch.manual_seed(SEED)
    device = select_device()
    logger.info("Device: %s", device)

    # ---- Load pre-computed features ----
    data_path = Path(data_dir)
    train_ds = MIMICMortalityDataset(data_path, "train")
    val_ds = MIMICMortalityDataset(data_path, "val")
    logger.info("Train: %d samples | Val: %d samples", len(train_ds), len(val_ds))

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, shuffle=False)

    # ---- Class imbalance weight ----
    n_pos = int(train_ds.labels.sum().item())
    n_neg = len(train_ds) - n_pos
    pos_weight = torch.tensor(n_neg / n_pos, dtype=torch.float32, device=device)
    logger.info("Class balance: %d neg / %d pos (pos_weight=%.2f)", n_neg, n_pos, pos_weight.item())

    # ---- Model, loss, optimizer ----
    input_dim = train_ds[0]["features"].shape[0]
    model = LogisticRegression(input_dim).to(device)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.SGD(model.parameters(), lr=LEARNING_RATE)

    logger.info("Input dim: %d | Epochs: %d | Batch size: %d | LR: %s",
                input_dim, NUM_EPOCHS, BATCH_SIZE, LEARNING_RATE)

    # ---- Checkpoint directory ----
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    ckpt_path = CKPT_DIR / "best_model.pt"

    # ---- Training loop ----
    best_auroc = 0.0
    for epoch in range(1, NUM_EPOCHS + 1):
        train_loss = train_one_epoch(model, train_loader, optimizer, criterion, device)
        val_metrics = evaluate(model, val_loader, criterion, device)

        logger.info(
            "Epoch %2d/%d  train_loss=%.4f  val_loss=%.4f  auroc=%.4f  f1=%.4f  acc=%.4f",
            epoch, NUM_EPOCHS, train_loss,
            val_metrics["loss"], val_metrics["auroc"], val_metrics["f1"], val_metrics["acc"],
        )
        if val_metrics["auroc"] > best_auroc:
            best_auroc = val_metrics["auroc"]
            torch.save(model.state_dict(), ckpt_path)
            logger.info("  -> Saved best model (AUROC=%.4f) to %s", best_auroc, ckpt_path)

    # ---- Test with best checkpoint ----
    logger.info("Loading best checkpoint for test evaluation ...")
    model.load_state_dict(torch.load(ckpt_path, map_location=device, weights_only=True))

    test_ds = MIMICMortalityDataset(data_path, "test")
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE, shuffle=False)
    logger.info("Test: %d samples", len(test_ds))

    test_metrics = evaluate(model, test_loader, criterion, device)
    logger.info(
        "Test results  loss=%.4f  auroc=%.4f  f1=%.4f  acc=%.4f",
        test_metrics["loss"], test_metrics["auroc"], test_metrics["f1"], test_metrics["acc"],
    )

    # ---- Bias analysis on test set ----
    bias_analysis(model, test_ds, test_loader, device, save_path=CKPT_DIR)

    logger.info("Done. Best val AUROC: %.4f | Test AUROC: %.4f", best_auroc, test_metrics["auroc"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train logistic regression for ICU mortality prediction.")
    parser.add_argument("--data_dir", type=str, required=True, help="Directory with pre-computed feature .npz files")
    args = parser.parse_args()
    main(args.data_dir)
