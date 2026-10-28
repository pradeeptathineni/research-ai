---
name: repo-squash
description: Reconcile accumulated implementation, documentation, guidance and local artifacts into one small current product; use for repo cleanup or semantic squashing, not Git history rewriting.
---

# Reconcile the repository

Treat the repository as one current implementation. Preserve useful behavior and
knowledge while removing the scaffolding of how it was built. This procedure does
not authorize rewriting Git history, deleting user data, publishing or spending.
Follow the user's scope and repository instructions; inspect dirty work first.

1. Read the product intent and current contracts. Name the observable improvement:
   fewer competing owners, clearer commands, smaller context or less obsolete state.
   Record branch, HEAD, dirty files and a recoverable baseline before broad changes.
2. Audit tracked files and ignored local trees. Trace actual imports, commands,
   readers, writers and external consumers. Labels such as old, legacy, retired,
   logs or tests are clues, not automatic deletion criteria.
3. Give each artifact a purpose and owner. Keep canonical knowledge, current
   behavior, necessary recovery and evidence bindings. Rehome useful history and
   implementation receipts outside the active product. Remove reproducible output
   and mechanisms whose capability has a verified current owner. Preserve unknown
   user-authored material until its purpose is resolved.
4. Consolidate by responsibility. Describe present behavior in compact contracts;
   let Git retain superseded prose. Route AI guidance through `.meta/context/` with
   thin host discovery adapters. Keep planning and evaluation evidence separate.
   Generalize repeated real boundaries; avoid hypothetical adapters and code golf.
5. Remove retired readers, flags, dependencies, fixtures and documentation together.
   Preserve historical decoders when active records still need them. Immutability
   requires retaining evidence and its meaning, not every former implementation or
   keeping archives in the runtime tree. Corrections remain successors.
6. Archive valuable local state with a manifest of original paths, sizes and hashes.
   Verify every archived member before removing its active copy. Keep provenance
   and a recovery instruction in the archive; never put private bytes into public
   records or fixtures. Distinguish caches from saved answers and source evidence.
7. Test the remaining capability and meaningful denials, including privacy, malformed
   input, authority, concurrency and historical replay where affected. Remove tests
   that only assert a deleted implementation; retain the underlying safety checks.
   Review the integrated diff and check archive conservation before delivery.
8. Measure before/after by group: tracked files, source lines, local files and bytes,
   or the same tokenizer and source-map selection. Distinguish relocation from disk
   savings and estimates from measured tokens. Fewer lines or green tests do not
   prove faster execution, better research or lower model cost.

Finish at the authorized delivery boundary. Report what changed, the surviving
capabilities, verification, archive location and measured reductions. A clean tree
means deliberate tracked state and generated output handled by its documented owner.
