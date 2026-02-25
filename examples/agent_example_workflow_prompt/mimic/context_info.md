We study ICU in-hospital mortality prediction from unstructured clinical notes and analyze whether a pretrained clinical language model exhibits systematic performance disparities across ethnicity groups. 

# Input data:

1. Clinical notes of ICU, converted into 10000 dim TF-IDF feature.
2. Ethnical information, a 6 dim one-hot vector that indicate the ethnical group of the patient. 

# Output: 

A real number indicate the mortality probabilities. 