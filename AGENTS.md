# Research AI authoring

Read [README.md](README.md) for the workspace entrypoint and owner boundaries.
Research Methods owns bounded research execution and source-grounded methods;
Research Library owns saved entities, sources, interests and Briefing. Workbench
is Library's local interface. Keep one owner for each record and do not add a
second research executor or store at the workspace root.

- For Methods changes, read [Methods instructions](packages/methods/AGENTS.md)
  and its [task context](packages/methods/.meta/context/README.md).
- For Library or Workbench changes, read [Library instructions](packages/library/AGENTS.md)
  and its [task context](packages/library/.meta/context/README.md).
- For a cross-package change, read both routes and check the exact consumer
  contract before editing. Keep historical `signals-ai` IDs and paths readable
  until their supported replacement is verified.

Write user-facing text plainly. State what a command or result does, where its
evidence comes from and what remains unknown. Preserve exact source references,
privacy boundaries and required notices. Run the checks relevant to the changed
owner; local checks do not establish live-provider quality or Deep deployment.

These project files are the portable authoring entrypoint. Personal instruction
files, global hooks and sibling planning folders may add host-specific context,
but they are not required to read, build or test this workspace. Do not install
or change hooks as part of an ordinary project edit.
