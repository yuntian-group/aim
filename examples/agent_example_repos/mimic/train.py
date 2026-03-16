"""Train a logistic regression model for ICU mortality prediction (MIMIC-III).

Expects pre-computed TF-IDF feature files produced by preprocess.py:
    {split}_tfidf.npz, {split}_meta.npz

Usage (pre-processed data gets stored in ./data by preprocess.py):
    python train.py --data_dir examples/agent_example_repos/mimic/data
"""

from __future__ import annotations
import argparse
import logging

from pathlib import Path

import torch
import torch.nn as nn

from aim.sdk.agent.research_agent_logger import AGENT_LOG_TEST_PREFIX, ResearchAgentLogger
from dataset import MIMICMortalityDataset
from prober import CounterfactualProberConfig, EthnicityCounterfactualProber
from sklearn.metrics import f1_score, roc_auc_score
from torch.utils.data import DataLoader
from tqdm import tqdm


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BATCH_SIZE = 256
LEARNING_RATE = 2
NUM_EPOCHS = 50
SEED = 42

# Penalty applied to the ethnicity feature weights to discourage
# counterfactual sensitivity without removing the features entirely.
ETH_WEIGHT_PENALTY = 0.02

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = SCRIPT_DIR / 'data'
CKPT_DIR = SCRIPT_DIR / 'checkpoint'

ETH_NAMES = ['white', 'black', 'hispanic', 'asian', 'other']


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
        return torch.device('cuda')
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps')
    return torch.device('cpu')


# ---------------------------------------------------------------------------
# Train / eval
# ---------------------------------------------------------------------------
def train_one_epoch(
    model: nn.Module,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    criterion: nn.Module,
    device: torch.device,
    eth_start_idx: int,
    eth_weight_penalty: float,
) -> float:
    model.train()
    running_loss = 0.0
    for batch in tqdm(loader, desc='  Train', leave=False):
        features = batch['features'].to(device)
        labels = batch['label'].to(device)

        logits = model(features)
        loss = criterion(logits, labels)

        if eth_weight_penalty > 0 and hasattr(model, 'linear'):
            eth_weights = model.linear.weight[:, eth_start_idx:]
            if eth_weights.numel() > 0:
                loss = loss + eth_weight_penalty * eth_weights.pow(2).sum()

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

    for batch in tqdm(loader, desc='  Eval ', leave=False):
        features = batch['features'].to(device)
        labels = batch['label'].to(device)

        logits = model(features)
        total_loss += criterion(logits, labels).item()

        all_probs.append(logits.sigmoid().cpu())
        all_labels.append(labels.cpu())

    probs = torch.cat(all_probs).numpy()
    labels = torch.cat(all_labels).numpy()
    preds = (probs >= 0.5).astype(int)

    return {
        'loss': total_loss / len(loader),
        'auroc': roc_auc_score(labels, probs),
        'f1': f1_score(labels, preds, zero_division=0),
        'acc': float((preds == labels).mean()),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(data_dir: str) -> None:
    torch.manual_seed(SEED)
    device = select_device()
    agent_logger = ResearchAgentLogger()

    # ---- Load pre-computed features ----
    data_path = Path(data_dir)
    train_ds = MIMICMortalityDataset(data_path, 'train')
    val_ds = MIMICMortalityDataset(data_path, 'val')

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, shuffle=False)

    # ---- Class imbalance weight ----
    n_pos = int(train_ds.labels.sum().item())
    n_neg = len(train_ds) - n_pos
    pos_weight = torch.tensor(n_neg / n_pos, dtype=torch.float32, device=device)

    # ---- Model, loss, optimizer ----
    tfidf_dim = train_ds.tfidf.shape[1]
    input_dim = train_ds[0]['features'].shape[0]
    eth_start_idx = tfidf_dim if train_ds.use_eth else input_dim
    model = LogisticRegression(input_dim).to(device)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.SGD(model.parameters(), lr=LEARNING_RATE)

    # ---- Checkpoint directory ----
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    ckpt_path = CKPT_DIR / 'best_model.pt'

    # ---- Training loop ----
    best_auroc = 0.0
    for epoch in range(1, NUM_EPOCHS + 1):
        train_loss = train_one_epoch(
            model,
            train_loader,
            optimizer,
            criterion,
            device,
            eth_start_idx,
            ETH_WEIGHT_PENALTY,
        )
        val_metrics = evaluate(model, val_loader, criterion, device)
        agent_logger.log('train_loss', train_loss, step=None, epoch=epoch)
        agent_logger.log('val_loss', val_metrics['loss'], step=None, epoch=epoch)
        agent_logger.log('val_auroc', val_metrics['auroc'], step=None, epoch=epoch)
        agent_logger.log('val_f1', val_metrics['f1'], step=None, epoch=epoch)
        agent_logger.log('val_acc', val_metrics['acc'], step=None, epoch=epoch)
        if val_metrics['auroc'] > best_auroc:
            best_auroc = val_metrics['auroc']
            torch.save(model.state_dict(), ckpt_path)
            logger.info('  -> Saved best model (AUROC=%.4f) to %s', best_auroc, ckpt_path)

    # ---- Test with best checkpoint ----
    logger.info('Loading best checkpoint for test evaluation ...')
    model.load_state_dict(torch.load(ckpt_path, map_location=device, weights_only=True))

    test_ds = MIMICMortalityDataset(data_path, 'test')
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE, shuffle=False)
    logger.info('Test: %d samples', len(test_ds))

    test_metrics = evaluate(model, test_loader, criterion, device)
    for key, value in test_metrics.items():
        agent_logger.log(AGENT_LOG_TEST_PREFIX + key, value, step=None, epoch=None)

    prober = EthnicityCounterfactualProber(
        model_factory=lambda: LogisticRegression(input_dim),
        agent_logger=agent_logger,
        config=CounterfactualProberConfig(
            data_dir=data_path,
            ckpt_path=ckpt_path,
            batch_size=BATCH_SIZE,
            device=device,
        ),
        eth_names=ETH_NAMES,
    )
    prober.run()

    logger.info('Done. Best val AUROC: %.4f | Test AUROC: %.4f', best_auroc, test_metrics['auroc'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train logistic regression for ICU mortality prediction.')
    parser.add_argument(
        '--data_dir',
        type=str,
        default=str(DEFAULT_DATA_DIR),
        help='Directory with pre-computed feature .npz files',
    )
    args = parser.parse_args()
    main(args.data_dir)
