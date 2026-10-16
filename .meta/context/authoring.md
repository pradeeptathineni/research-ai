# Change research-ai

Keep one owner per rule. Add capability only when a real consumer needs it.
Avoid provider registries, stores, orchestrators or crawlers built for
hypothetical consumers. A second provider belongs here only once it is
implemented and tested with the same restrictions.

Preserve consumer contracts. Signals pins an exact public commit, so changing
outcome fields, message categories, limits, lease names or argument vectors
needs a coordinated Signals change and a new version.

Cover denied access, malformed events, cancellation, deadlines, byte caps,
lease conflicts and a missing CLI where affected. Use only synthetic fixtures.
Never include private research, transcripts, account data, personal paths or
credentials.

Docs should help someone run or change the package. They cover purpose,
commands, ownership, failures and limits. Keep implemented scope separate from
proposed next seams.
