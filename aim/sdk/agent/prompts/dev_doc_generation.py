TEMPLATE = """\
You task is to generate the development plan of a given probe design text over a \
model training repo.

A prober is one or some evaluation protocol or metrics that may indicate the a \
problem of a trained model. The prober is will be a class or function that generate \
metrics, charts or figures that indicate the problem given the trained model and \
eval dataset.

your prober must includes such factors: the conclusion of your evalutation must be numerical, \
and you should states clearly how it get computed. \
also, you should give a threshold of this numerical result to indicate is this result good or bad for \
probing our model. And you should use figures to clearly visualize this result. and all these \
(threshold, numerical result) will be called together as prober conclusion or just result in after context.


# Instructions

- Read the prober design idea in `.codex/prober_design_idea.md`, give **3** possible \
different design plan of the given prober design idea.
- if in `.codex/prober_design_idea.md` says 'iterate all 10 hypothesis', \
    you will find the all 10 hypothesis in  .codex/all_generated_probe.md\
    and in this case you just return 3 dev plans for the first hypothesis. 


# Requirement 

- The result MUST state that the prober must use the tracking API in \
`aim.sdk.agent.research_agent_logger` so that the result can be captured by the \
research agent.
- The result MUST state that the prefix of the test result metric name is `agent_log_test_`.
- The result MUST state that the prefix of the prober result metric name is `agent_log_prober_`.
- The result MUST state that the prober must be in a separate file named `prober.py`.
- For figures and charts in results, you should keep axis range fixed across all the time. 
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
