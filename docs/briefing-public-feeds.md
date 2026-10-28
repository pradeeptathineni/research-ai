# Lobsters feeds in Briefing

Following accepts one exact Lobsters RSS collection URL. Add it through the existing Following source workflow, associate it with an interest, and start a manual refresh. Refresh remains request-identified and uses the existing source-policy block, conditional request state, source health, canonical item/story records, ranking, and cold-read APIs. Nothing is subscribed automatically and no timer is added.

Lobsters supports these exact public RSS collection forms:

```text
https://lobste.rs/rss
https://lobste.rs/newest.rss
```

The adapter rejects search/tag feeds, query strings, alternate hosts and HTTP. The public repository documents `/newest.rss` and reports anonymous successful requests to `/rss`; the newest list is bounded to the 25 entries exposed by Lobsters' current pagination. Each retained item keeps its source URL and feed identity, plus available author and publication time. A public feed response does not establish permission to republish its content; `termsRef` remains null until a source policy is explicitly recorded. See [Lobsters](https://lobste.rs/), [the newest-feed discussion](https://github.com/lobsters/lobsters/issues/2106), and [maintainer feed request logs](https://github.com/lobsters/lobsters/issues/1238).

The YouTube channel Atom topic is not enabled as a polling adapter. Google's [push-notification guide](https://developers.google.com/youtube/data/guides/push_notifications) documents `https://www.youtube.com/xml/feeds/videos.xml?channel_id=…` as a WebSub topic and says push avoids repeated polling. It does not promise direct unauthenticated reads as a bounded client workflow; this project also cannot add the notification listener here. No YouTube Data API key/OAuth call, listener, or undocumented direct-poll assumption is introduced.

Lobsters uses the existing bounded RSS extraction and Briefing owner. The extractor limits each document to 100 feed entries and the existing fetcher bounds response bodies. Per-entry identity metadata is optional in stored document material so older cached records remain readable; unrelated sources keep their previous item digest and metadata projection. No search endpoint is guessed, and no platform metrics or content rights are inferred.
