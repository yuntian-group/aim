import math
import time
import random
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from aim.sdk.agent.research_agent_logger import ResearchAgentLogger

logger = ResearchAgentLogger()

NUM_EPOCHS = 20
STEPS_PER_EPOCH = 50
BASE_LR = 0.01

for epoch in range(1, NUM_EPOCHS + 1):
    epoch_loss = 0.0
    for step in range(1, STEPS_PER_EPOCH + 1):
        global_step = (epoch - 1) * STEPS_PER_EPOCH + step

        progress = global_step / (NUM_EPOCHS * STEPS_PER_EPOCH)
        loss = 2.0 * math.exp(-3 * progress) + random.gauss(0, 0.05 * (1 - progress))
        loss = max(loss, 0.01)
        epoch_loss += loss

        accuracy = min(0.95, 0.3 + 0.65 * (1 - math.exp(-4 * progress))) + random.gauss(0, 0.02)
        accuracy = max(0.0, min(1.0, accuracy))

        lr = BASE_LR * (1 - progress)

        logger.log({
            "epoch": epoch,
            "step": global_step,
            "loss": round(loss, 5),
            "accuracy": round(accuracy, 5),
            "learning_rate": round(lr, 6),
        })

        time.sleep(0.05)

    avg_loss = epoch_loss / STEPS_PER_EPOCH
    logger.log({
        "epoch": epoch,
        "step": epoch * STEPS_PER_EPOCH,
        "epoch_avg_loss": round(avg_loss, 5),
    })
