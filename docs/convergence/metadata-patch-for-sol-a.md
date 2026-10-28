# Capability metadata extension handoff to Sol-A (P1)

This is the exact additive type-only patch requested by B1. Sol-A owns the shared Deep file and applies the patch; B1 does not edit the Deep clone or Signals paths.

In `src/owner-tools/capability-types.ts`, extend the existing `OwnerCapabilityMetadata` type:

```diff
 export type OwnerCapabilityMetadata = {
   schema: "deep.capability.v1";
   id: string;
   owner: string;
   title: string;
   summary: string;
   order?: number;
+  component?: string;
+  formerOwner?: string;
 };
```

No existing capability ID, owner binding, receipt, route, or execution authority changes. The fields are optional, descriptive build metadata only. The current catalog eagerly loads `*.capability.json`, types them as `OwnerCapabilityMetadata`, filters its existing required fields, and ignores unknown descriptive fields; this patch therefore remains additive. It must not be used to bypass `SignalsProviderContractBinding`, alter an owner pin, or infer a route from a string.

The field values for future capabilities should be set by the contributor who authors each metadata leaf and reviewed by Sol-A at integration. B1 proposes the extension only; it does not edit shared metadata values. Existing capability IDs and capability prefixes remain unchanged.

## Sol-A exact shared change

- File: `src/owner-tools/capability-types.ts`
- Add optional `component?: string` and `formerOwner?: string` to `OwnerCapabilityMetadata` as shown above.
- No `server/main.ts` registration, manifest, pin, catalog, receipt, or package-lock line is required for this type extension.
