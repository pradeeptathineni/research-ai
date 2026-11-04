# Screen saved topic references

First select exact owner records in a private topic and save bibliographic
references for them. A screening protocol states the human review question and
short inclusion and exclusion criteria. Saving a changed protocol retains the
older version and all earlier decisions. It does not edit the original owner
record or start research.

Use `knowledge screenings TOPIC_UUID` to read the topic revision, saved
reference IDs and current metadata digests. Then explicitly save a protocol:

```text
knowledge screening-protocol TOPIC_UUID '{"revision":3,"question":"Which records describe the method?","include_criteria":["Describes the method"],"exclude_criteria":["Does not describe the method"]}'
```

The returned protocol revision and SHA, current reference metadata revision
and SHA, and new topic revision bind each decision. A person
can then record one `include`, `exclude` or `uncertain` decision and a reason:

```text
knowledge screening-decision TOPIC_UUID '{"revision":4,"reference_id":"ref-...","protocol_revision":1,"protocol_sha256":"...","metadata_revision":1,"metadata_sha256":"...","decision":"uncertain","reason":"The saved abstract is insufficient; inspect the full source."}'
```

Use `knowledge screenings TOPIC_UUID` again to cold-open the protocol versions,
all decisions and each reference's latest state. `current` means only that the
saved protocol and metadata digests still match. A changed protocol or edited
reference is marked for fresh review; a detached reference stays visible. An
identical resubmission is idempotent. Existing topic and reference exports keep
their previous formats. The guarded local API offers `GET
topics/{id}/screening`, `POST topics/{id}/screening/protocol` and `POST
topics/{id}/screening/decision` with the same inputs.

This is human screening of caller-supplied bibliographic metadata. It does not
check the current owner source, infer a paper's findings, prove recall or add a
paper to a Methods Literature Set. Unscreened records remain visible. Review
the underlying source before making a research or publication decision.
