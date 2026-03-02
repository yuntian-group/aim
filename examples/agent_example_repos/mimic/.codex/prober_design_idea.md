# Prober Design Idea

## Counterfactual Ethnicity Swap

**Probe Type:** bias

## Design Details

For each note feature vector, swap the ethnicity one-hot to every other group while keeping TF-IDF fixed; measure the maximum probability change per sample to expose undue sensitivity to group identity.
