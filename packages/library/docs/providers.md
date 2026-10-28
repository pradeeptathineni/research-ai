# Optional acquisition and extraction

Native web research and inert HTML/RSS extraction work without provider configuration.
Optional providers are selected in ignored `.signals/providers.json`, validated by
`packages/corpus/src/search-acquisition.ts`. Configuration is not runtime success.
Failures remain gaps; providers never choose scores, write the Corpus, bypass access
denials or receive ambient credentials. Public HTTPS transport retains DNS, redirect,
byte and time limits.

| Provider       | Configuration and boundary                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public APIs    | `publicApis: true` supplements native research; `--sources-only` uses model-free locators. Ranked links are unassessed.                                                                                                                                                                            |
| SearXNG        | Explicit public HTTPS JSON `endpoint`. Loopback HTTP is unsupported; denial, malformed JSON and unresponsive engines remain gaps.                                                                                                                                                                  |
| last30days     | `checkout`, `python`, optional `discovery` and `caFile`. Checkout must match `7f582ad8c2e140eca08098b245f9e31b68e28b60` (3.26.0, MIT). Only the inspected HN lane is used, with isolated configuration, Keychain/cookies disabled and no hook/update/watchlist behavior. JSON 1.3/1.1 is accepted. |
| Jina           | `jina: true` selects a public-only reader fallback for extraction failures. Denied/private access never triggers it. Final identity and truncation uncertainty remain visible.                                                                                                                     |
| Docling        | Explicit local `python`, `artifactsPath`, `version` and `modelsAuthorized`. Bridge pins 2.135.0; artifacts require separate provisioning/review. Remote services, downloads and OCR are disabled. Page/table locators remain inspectable.                                                          |
| GPT Researcher | Explicit `python`, `configPath`, `billingAuthorized` and selected `environment` references. Fixed bridge pins 0.16.0 and returns original sources. Paid entitlement and a usable budget are never assumed.                                                                                         |

`last30days.caFile` must be an absolute, regular, reviewed public PEM certificate bundle
without private keys. It supplies a trust store for the selected Python runtime;
TLS verification stays enabled. No automatic retry or private-network fallback is used.

Docling's reviewed upstream is `213288f4a81bc1f509522a854c0c807e96dbc5a3`.
Layout Heron `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` uses Apache-2.0;
table artifacts use CDLA-Permissive-2.0/Apache-2.0. Optional environments are outside npm
dependencies; check transitive runtime compatibility in the selected isolation.
GPT Researcher's reviewed upstream is `0957c301ed06c2a5857b834358c7227c739041d4`.
Package/version checks do not establish validation of every upstream behavior.
Optional conversion never expands the document transport limit.

Following → Sources shows configuration and retained health. Settings reports native
runner readiness separately. Inspect failures and funding before explicit use;
a successful locator lookup does not establish relevance or usefulness.

## Agent-Reach and direct upstream tools

[Agent-Reach 1.5.0](https://github.com/Panniantong/Agent-Reach/tree/94f06c1969dfc1834001269d79d3ad0972d9dee6)
was inspected as optional upstream-tool guidance. Its CLI installs/checks
backends; it does not provide a uniform source-reading API, and its MCP server
reports status rather than research sources. Signals therefore has no
`agentReach` provider setting. Reuse existing public APIs, RSS extraction and
explicit Jina configuration instead of wrapping the same transports again.

Review the exact official source and selected upstream dependencies before
setup; a similarly named PyPI package is not that source. System installation,
skill/MCP registration, browser sessions and authenticated channels are separate
choices. A channel's readiness label does not establish target-specific access:
the bounded public trial read RSS and web sources, but empty-profile GitHub CLI
search required login and the first selected YouTube subtitle read hit a bot
challenge. No cookie, alternate source or authentication fallback followed.

Alternate renderings can expose material omitted by a normalized projection,
including hidden content, while losing original identity or adding irrelevant
text. Keep those representations and omissions distinct. They do not expand
claim budgets, repair an old receipt or establish absence, factual support or
personal fit. External captions and artifacts need an existing supported source
contract before they can be used as checked evidence.
