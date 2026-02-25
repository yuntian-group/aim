TEMPLATE = """\
You are going to analyze the modeling training result based on trainig output and a \
model prober output and update existing code to improve the metrics of the model prober.

A prober is one or some evaluation protocol or metrics that may indicate the a \
problem of a trained model. The prober is will be a class or function that generate \
metrics, charts or figures that indicate the problem given the trained model and \
test dataset in `prober.py`. 

You may refer to `.codex/prober_design_idea.md` for the guidance of generating prober.

# Current Model Prober Result

{prober_result}

# Current Evaluation Result

{eval_result}

# Instruction

- Read the training code and prober in `prober.py`, understand the model problem \
it cares about.
- Examine the prober figures listed above to understand the visual diagnostics.
- Make update to the model to alleviate the problem while maintain the model \
performance. You can make modification to
    a. dataloader
    b. data sampling
    c. model architecture
    d. loss function
    e. other parts
    f. combination of above may lead to the problem indicated by prober

# Requirements

- Make no change to `prober.py`, only make change to training code
- Make sure you fully reuse the existing components of existing code.
- Make sure you apply the best software engieering pratice.
- Make sure you make minimum change to the code.
- Make sure you the modified training repo is easy to understand.
- You MUST not modify the test data and test code in `prober.py`.

Now perform update\
"""


def render(*, prober_result: str, eval_result: str) -> str:
    return TEMPLATE.format(prober_result=prober_result, eval_result=eval_result)
