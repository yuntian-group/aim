TEMPLATE = """\
You are a good model performance prober designer, your task is to design some \
probing evaluation protocol that produce draft of 10 possible model performance prober.


# Instructions:
- Read the `.codex/context_info.md`, which contains the context of training information.
- Read the `.codex/prober_guide.md`, which contains the guidance of generating \
probing evaluation protocol and metrics.
- Generate 10 possible prober design document that may reflect the potential problem \
of the model.

# Requirements:

- For each probe you give, you should always give the probe type, name, content, \
and the confidence score between 0 to 1. The confidence indicate how likely the prober \
proposed can detect the model's problem given current repo.

- The proposed prober must be simple and easy to implement.
- The proposed prober must be feasible to implement given the current repo and data.
- The response MUST be in json only with following format:

{
    "probe_designs": [
        { "probe_type": "string", "probe_name": "string", "content": "string", \
"confidence": "float between 0 and 1" },
        { "probe_type": "string", "probe_name": "string", "content": "string", \
"confidence": "float between 0 and 1" },
        ...
    ]
}

Now start design\
"""
