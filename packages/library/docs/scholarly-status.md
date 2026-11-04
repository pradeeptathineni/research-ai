# Publication updates for saved references

First save a bibliographic reference with a DOI against an exact topic member.
Then explicitly supply the JSON response for that DOI from Crossref's production
`https://api.crossref.org/works/{DOI}` endpoint. Library does not fetch it in
the background. The standalone `knowledge reference-status TOPIC_UUID -`
command reads the bounded request JSON from stdin; it also accepts inline JSON.
Prepare a private JSON request containing `revision`, `reference_id` and
`crossref_response`, then pipe that file to the command. The guarded local
`POST topics/{id}/references/status` route takes the same input. Both take
`{ "revision": topicRevision, "reference_id": savedReferenceId,
"crossref_response": workResponse }`. The command uses the normal `--root`
option. `knowledge references-status TOPIC_UUID` and the corresponding local
GET route cold-read all retained observations for that topic.

Import checks the work DOI against the current saved reference DOI and rejects
malformed responses or those over 120,000 bytes. It retains a SHA-256 digest of the canonicalized supplied
response, the import time, Crossref's indexed time when present, and bounded
`updated-by` entries with their reported type, source, DOI and update date.
Importing identical bytes for the same metadata version is idempotent.
Changing bibliographic metadata keeps earlier observations and marks their
metadata binding as historical. The old reference, source selection and
metadata versions are never rewritten by a status observation.

`retraction-reported` means the supplied Crossref response contains a
retraction update. `other-update-reported` preserves other update types.
`unknown` means this snapshot reported no `updated-by` entries; it does **not**
mean the work is unretracted. Earlier retraction reports remain visible even
if a later snapshot reports no update. This is caller-supplied metadata, not
independent verification or a judgment about the paper's findings. It does
not automatically change a Research Literature Set, a citation, or a public
export. Review any reported update and its source before making those decisions.

Crossref documents the production [Retraction Watch data route](https://www.crossref.org/labs/retraction-watch/)
and [registration of corrections and retractions](https://www.crossref.org/documentation/register-maintain-records/maintaining-your-metadata/registering-updates/).
The old Labs endpoint is stale; this workflow does not use it.
