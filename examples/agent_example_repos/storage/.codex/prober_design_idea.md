# Prober Design Idea

## Ethnicity-Specific AUC Audit

**Probe Type:** Bias Probe

## Design Details

Split the evaluation set by each of the six ethnicity one-hot bins and compute AUC, PR-AUC, recall@0.5, and Brier score per group to flag mortality-risk disparities tied to demographic inputs.
