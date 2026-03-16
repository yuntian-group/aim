# Prober Design Idea

## Counterfactual Ethnicity Swap

**Probe Type:** Causality

## Design Details

For each test sample keep TF-IDF features fixed, clone the 6-d ethnicity vector and swap it to every other group before running inference; record the distribution of probability shifts per swap to see if ethnicity alone flips decisions.
