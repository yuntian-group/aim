TEMPLATE = """\
You task is to generate the development plan of a given probe design text over a \
model training repo.

A prober is one or some evaluation protocol or metrics that may indicate the a \
problem of a trained model. The prober is will be a class or function that generate \
metrics, charts or figures that indicate the problem given the trained model and \
eval dataset.

# Instructions

- Read the prober design idea in `.codex/prober_design_idea.md`, give **3** possible \
different design plan of the given prober design idea.


# Requirement

- The result MUST state that the prober must use the tracking API in \
`aim.sdk.agent.research_agent_logger` so that the result can be captured by the \
research agent.
- The result MUST state that the prefix of the test result metric name is `agent_log_test_`.
- The result MUST state that the prefix of the prober result metric name is `agent_log_prober_`.
- The result MUST state that the prober must be in a separate file named `prober.py`.
- Respond in json only with following format:

{
    "dev_plans": [
        "<dev plan 1>",
        "<dev plan 2>",
        ...
    ]
}


Now start generate\
"""
