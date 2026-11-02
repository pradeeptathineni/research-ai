# Public-data preview and reviewed local export

The public-data writer derives `corpus.json`, `entities.json`, `library.json`,
and exact public bundle bytes plus digest sidecars. Withdrawn admission records
remain available through the loader for historical readers, but are omitted
from public bundle files and download sidecars as well as the public option
index. The preview path shows the same emitted bytes before export and binds
review to their revision.

```sh
npm run corpus -- preview > public-preview.json
npm run corpus -- build-reviewed --review-sha256=PREVIEW_SHA256 --reviewer="human review label"
npx vite build --config apps/corpus/vite.config.ts
npm run corpus -- verify-reviewed-site --preview-sha256=PREVIEW_SHA256
```

Inspect every `artifacts[]` entry in the preview. It contains the relative path,
exact UTF-8 `bytes`, `byteLength`, SHA-256, source references and a qualification.
The preview-level SHA-256 binds the ordered artifact paths, artifact digests and
lengths, source references, qualifications, and global privacy/coverage
qualifications. The second command reloads the public Corpus and saved entities,
recomputes the preview, and refuses if the supplied digest no longer matches.
The reviewed export writes to `dist/public-data` through the existing staging
directory and atomic symlink-pointer rename. It returns the exact artifact paths
and digests written. If staging fails before the pointer rename, the writer
attempts to remove that attempt's temporary directory and leaves the prior
pointer intact.

`verify-reviewed-site` reloads those same public inputs, checks that their
preview digest still matches, and compares every public JSON/bundle artifact
copied into `dist/public-site` byte-for-byte. It also rejects extra top-level
JSON or bundle files, symlinks and missing artifacts. The Pages workflow uploads
only after this check passes.

The callable workflow is `previewPublicData(corpus, entities)`,
`reviewPublicDataPreview(preview, { confirmedSha256, reviewer, reviewedAt })`,
then `exportReviewedPublicData(corpus, directory, entities, review)`. Review is
a caller assertion labelled with the supplied reviewer text; it does not
authenticate a person or certify truth, source freshness, or legal publication
rights. Only the validated public Corpus and the explicit closed-schema saved
entity records are inputs. The CLI reads its saved entities from public
`signals/entities`; the workflow does not read private annotations, project
records, credentials, caches, or the `.signals` private collection.

`publishPublicData(corpus, directory, entities)` and the legacy `corpus build`
command retain their existing direct-export behavior for compatibility; they do
not acquire a review gate from this API. Neither export function performs Git
operations or publishes to the remote Pages site. External publication remains
a separate action-time reviewed operation. The package Pages workflow is
manual-dispatch only: the operator supplies the exact preview digest, the
workflow uses the authenticated GitHub actor as its reviewer label, exports
that preview, builds the site and verifies copied bytes before upload. Local
`build` and `dev` retain the direct compatibility build. In the converged
Research workspace this workflow remains under `packages/library/.github`; it
is not a root GitHub Actions workflow until an owner explicitly integrates it
at the repository root.
