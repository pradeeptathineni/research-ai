# GitHub public Releases and Tags in Briefing

Following can read the documented, unauthenticated public GitHub REST endpoints for a repository's published releases and regular tag names:

- `https://api.github.com/repos/{owner}/{repo}/releases`
- `https://api.github.com/repos/{owner}/{repo}/tags`

The owner must follow one exact HTTPS endpoint. Briefing always requests page 1 with `per_page=20`, sends GitHub's JSON media type and API-version headers, and sends no credentials. Private repositories, drafts, extra query parameters, redirects to another endpoint, and other GitHub API paths are outside this adapter. Refresh remains a manual, request-identified Following action; existing terms blocks, conditional validators, health and request receipts apply.

Releases and regular tags are separate source kinds and are never collapsed together. Release identity includes GitHub's release ID and tag name; tag identity includes the exact tag name and target commit SHA. Public canonical links use the repository release/tag page. The regular-tags response does not imply that a tag has an associated release. Retained items and stories are the existing Briefing owner records and use its current rank inputs, feedback, history and cold-read APIs. The feed records metadata and bounded release notes; it does not download release assets, source archives or paper/repository contents. No license or redistribution right is inferred from public availability. A null source `termsRef` remains unknown until a terms policy is explicitly recorded.

## Why this is REST, not Atom

GitHub documents its release and repository-tag collection APIs as JSON. Its documented Atom feeds concern authenticated-user timelines, not repository-specific release and tag collections. This adapter therefore uses the documented public REST routes rather than guessing repository `.atom` URLs. GitHub states that published releases and public repository tags can be fetched without authentication, and that unauthenticated REST requests are limited to 60 per hour per originating IP. See the [releases endpoint](https://docs.github.com/en/rest/releases/releases), [repository tags endpoint](https://docs.github.com/en/rest/repos/repos#list-repository-tags), [feed endpoints](https://docs.github.com/en/rest/activity/feeds), and [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## arXiv listing blocker

The official arXiv API returns Atom and the published metadata is available for reuse. Its API terms also apply to RSS and set one request every three seconds across all machines under the operator's control, with one connection at a time. The current Signals source/refresh owner only stores per-URL request health and does not provide a durable, process-independent, host-wide throttle. This bundle does not add an independent throttle store or claim compliance through an in-memory delay; therefore arXiv is not enabled here. A later addition needs a durable shared rate gate owned by the existing source owner before it can safely trigger requests. See the [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html) and [API terms](https://info.arxiv.org/help/api/tou.html).
