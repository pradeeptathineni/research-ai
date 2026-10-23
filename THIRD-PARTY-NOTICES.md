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

# Outline refinement method

`src/outline.mjs` adapts the evidence-driven organization and refinement
approach from STORM's `StormOutlineGenerationModule` / `WriteOutline`,
`knowledge_storm/storm_wiki/modules/outline_generation.py`, revision
`fb951af7744dab086e34962e9bc6fe878e145f83` (Stanford OVAL), inspected with its
MIT license. STORM consumes curated conversation and can first draft from
parametric knowledge. This adaptation instead uses only caller-supplied frozen
captures, binds citations to exact UTF-16 spans, puts missing material in gaps,
and supports validated user edits. No STORM code, DSPy, Wikipedia fetching, or
unconstrained initial outline is included.

Source: https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/outline_generation.py

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

# Guided investigation method

`src/investigation.mjs` adapts bounded question-frontier generation,
continuation from retained learnings/follow-up questions, explicit clarification,
deduplication of retained source identities, and cited report synthesis from
`dzhng/deep-research`, revision
`1f8f3e285bbc23e80b98a66a64effab9069f3ad4`, inspected from its
`src/deep-research.ts` and `src/feedback.ts`. The adaptation uses caller-owned
resumable state and the existing restricted native executor; it does not include
Firecrawl, recursive execution, concurrency, provider setup or donor dependencies.
Failure is retained as failure rather than converted to an empty result. The
donor package manifest says ISC, while its inspected LICENSE is MIT; this MIT
notice is preserved for adapted portions. Its test script declares no usable
tests; no donor tests were ported.

Source: https://github.com/dzhng/deep-research/tree/1f8f3e285bbc23e80b98a66a64effab9069f3ad4

MIT License

Copyright (c) 2025 David Zhang

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
