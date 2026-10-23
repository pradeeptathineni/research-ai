# Citation support method

`src/grounding.mjs` reproduces ALCE `eval.py:compute_autoais` at revision
`246c476a4edfc564266b7346b6e29ef4861ae937` (Princeton NLP).
The selected implementation and root MIT license were inspected verbatim.
The method is adapted to explicit claim units, retained UTF16 spans, four-way
judgments, conflict disclosure and nullable estimates. No Python code, datasets,
NLTK, Torch, Transformers, weights or T5 judge is included.

Source: https://github.com/princeton-nlp/ALCE/blob/246c476a4edfc564266b7346b6e29ef4861ae937/eval.py

MIT License

Copyright (c) 2023 Princeton Natural Language Processing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Perspective lens method

`src/perspectives.mjs` adapts STORM's persona step,
`knowledge_storm/storm_wiki/modules/persona_generator.py` at revision
`fb951af7744dab086e34962e9bc6fe878e145f83` (Stanford OVAL), inspected verbatim
with its root MIT license. Retained ideas: a default basic-facts perspective
first, further perspectives drawn from section outlines, and STORM's excluded
outline sections. Changes: outlines come only from headings in caller-retained
sources, never from fetched Wikipedia pages or a model; lenses are question
filters rather than editor personas; each lens runs in its own bounded frozen
session. No STORM code, prompts, DSPy or network access is included.

Source: https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/persona_generator.py

MIT License

Copyright (c) 2024 Stanford Open Virtual Assistant Lab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
