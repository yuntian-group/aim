TEMPLATE = """\
This is optimization round {round_number} of iterative model improvement driven by \
prober diagnostics.

You are continuing to optimize the model to improve the prober metrics. You have been \
working on this model across multiple rounds within this same session — refer to \
the earlier conversation for the full history of changes and results.

You may refer to `.codex/prober_design_idea.md` for the guidance of prober.\
if it said [iteration mode] performance probe, then we are using a simple performance probe\
that only reflect the performance of the train.py with metrics like AUROC or loss.\
you must identify 10 places in train.py that need to be improved for better training quality and mark them with comment\
potential_change_1, potential_change_2, ..., potential_change_10.\
then you must remember this, everytime you can only modify up to 1 potential_change.
inspect {round_number}, if this is round 10, then you may ignore all limit and try improve train.py\
as much as possible

# Current Round {round_number} — Prober Result

{prober_result}

# Current Round {round_number} — Evaluation Result

{eval_result}

# Instruction

- Examine the current round's prober figures listed above.
- Compare the current round's results with previous rounds to identify what \
improved, what regressed, and what stayed flat.
- Focus on the prober metrics that still show the most room for improvement.
- Make targeted modifications to address remaining issues while preserving gains \
from previous rounds.
- You can modify:
    a. dataloader
    b. data sampling
    c. model architecture
    d. loss function
    e. other training components
    f. combinations of the above that address prober-indicated problems
- Do NOT revert changes from earlier rounds that led to improvements.

# Requirements

- Make no change to `prober.py`, only change training code.
- Preserve changes from previous rounds that showed improvement.
- Make sure you fully reuse the existing components of existing code.
- Apply the best software engineering practice.
- Make minimum, targeted changes.
- Ensure the modified training repo remains easy to understand.
- You MUST not modify the test data and test code in `prober.py`.

Now perform update\
"""


def render(
    *,
    round_number: int,
    prober_result: str,
    eval_result: str,
) -> str:
    return TEMPLATE.format(
        round_number=round_number,
        prober_result=prober_result,
        eval_result=eval_result,
    )
