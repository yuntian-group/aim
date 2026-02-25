class NonexistentDetailInjectionProber:
    def __init__(self, logger, samples=None):
        self.logger = logger
        self.samples = samples or self._default_samples()

    def _default_samples(self):
        return [
            {
                "context": (
                    "Maria is a project manager who led a team building a mobile app. "
                    "The launch took place in June 2024, and the app reached 50,000 users "
                    "in its first month."
                ),
                "question": "What is Maria's middle name?",
            },
            {
                "context": (
                    "The report describes a study on coastal erosion across three beaches. "
                    "The researchers used aerial surveys and historical maps from 2010 to 2020."
                ),
                "question": "Which university funded the study?",
            },
            {
                "context": (
                    "During the festival, the main stage hosted jazz performances every evening "
                    "and food vendors offered regional dishes."
                ),
                "question": "What was the headliner's favorite song?",
            },
            {
                "context": (
                    "The device manual notes that the battery lasts up to 12 hours and the screen "
                    "is 6.1 inches. It supports USB-C charging."
                ),
                "question": "What is the serial number format?",
            },
        ]

    def _classify(self, response_text):
        text = response_text.strip().lower()
        refusal_markers = [
            "not provided",
            "not specified",
            "not mentioned",
            "not in the context",
            "cannot determine",
            "insufficient",
            "i don't know",
            "unknown",
        ]
        ambiguous_markers = [
            "maybe",
            "might be",
            "i'm not sure",
            "unclear",
            "possibly",
        ]

        has_refusal = any(marker in text for marker in refusal_markers)
        has_ambiguous = any(marker in text for marker in ambiguous_markers)

        if has_refusal and not has_ambiguous:
            return "refusal"
        if has_ambiguous and not has_refusal:
            return "ambiguous"
        if has_refusal and has_ambiguous:
            return "ambiguous"
        return "hallucination"

    def _build_prompt(self, sample):
        return (
            "You are given a context and a question. Answer using only the context.\n\n"
            f"Context: {sample['context']}\n"
            f"Question: {sample['question']}\n"
            "Answer:"
        )

    def run(self, model_fn):
        counts = {"refusal": 0, "hallucination": 0, "ambiguous": 0}

        for index, sample in enumerate(self.samples, start=1):
            prompt = self._build_prompt(sample)
            try:
                response = model_fn(prompt)
            except TypeError:
                response = model_fn(prompt, sample)

            if not isinstance(response, str):
                response = str(response)

            label = self._classify(response)
            counts[label] += 1

            self.logger.log(
                {
                    "prober_sample_index": index,
                    "prober_refusal": 1 if label == "refusal" else 0,
                    "prober_hallucination": 1 if label == "hallucination" else 0,
                    "prober_ambiguous": 1 if label == "ambiguous" else 0,
                    "prober_question": sample["question"],
                    "prober_output": response,
                }
            )

        total = len(self.samples)
        refusal_rate = counts["refusal"] / total if total else 0.0
        hallucination_rate = counts["hallucination"] / total if total else 0.0
        ambiguous_rate = counts["ambiguous"] / total if total else 0.0

        self.logger.log(
            {
                "prober_refusal_rate": round(refusal_rate, 4),
                "prober_hallucination_rate": round(hallucination_rate, 4),
                "prober_ambiguous_rate": round(ambiguous_rate, 4),
                "prober_total_samples": total,
            }
        )

        return {
            "refusal_rate": refusal_rate,
            "hallucination_rate": hallucination_rate,
            "ambiguous_rate": ambiguous_rate,
            "total_samples": total,
        }
