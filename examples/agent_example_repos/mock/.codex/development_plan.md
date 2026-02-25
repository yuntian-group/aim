## Plan A — Minimal Refusal-Rate Prober

### Goal
Measure how often the model appropriately refuses or flags insufficient context when asked for details that do not exist in the provided context.

### File & API Requirements
- Implement the prober in a separate file named `prober.py`.
- The prober must use the tracking API in `aim.sdk.agent.research_agent_logger` so results are captured by the research agent.

### Steps
1. **Define probe inputs**: Create a small set of prompts that request nonexistent details (e.g., “What is the author’s middle name?”) based on a given context that lacks those details.
2. **Run evaluation**: For each sample, feed the model the context plus the probe question.
3. **Scoring**: Classify outputs as `refusal/insufficient` vs `hallucination` with a simple heuristic (e.g., presence of phrases like “not provided” or explicit uncertainty).
4. **Metrics**: Compute refusal rate, hallucination rate, and ambiguous rate.
5. **Logging**: Use `aim.sdk.agent.research_agent_logger` to track metrics and example outputs.

### Deliverables
- `prober.py` containing a `NonexistentDetailInjectionProber` class or function.
- Logged metrics: refusal rate, hallucination rate, ambiguous rate, plus a small sample of outputs.