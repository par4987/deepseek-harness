---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-14-image-description

English | [中文](2026-10-14-image-description.zh.md)

## Summary

Adds the optional ImageBlock description field recorded by a durable image-description decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-14-image-description
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "09fdba5615bf09865b5c0569c64a9d5f8b8d7f7a315d591686f3495119194b15"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "21d434c5f164dbd02772c610d40a5b3c42b484a36289449260df18c4d9351bfe"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "a162feda732ed237f47a6163850ddb3ff604af2d4bbb06f4ef69974383f66702"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "cf600e4f521fce739144a2ac96625ea48e1ad85dc052918aab98953fba2da58b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "f7bb240d008660d396f2b2b67e135940f426207289d4756e591a70ea13ca6188"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "6a4d4927928104a4057f6183376161dffb2e7e6b1579cab71dc5b8183254fe12"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "2416c5c23985e1959aa46bf407b3c036ef3b3d757617ef4ce45a54a7a484b5c8"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-16-session-format-v4"
    after: "68d04fabfe08a0aae00867abf504532aa5d6c535e0d6c5586383326b566bb365"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-10-05-ptc-operation-metadata"
    after: "f3653caca44545c5097c1d5ad0d76aab1ec4b7a756f0814d3be68eaa72ca19f6"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "97d2120392ad8096f93223ff30bd8099d81ddbfce3ce011b3c7391ceb89ae703"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "eb8623dc27a9c8bb2c0fef6080e6eded7b5f40c5438f33cfceebb7f84bdd0eb8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs remain valid: an old reader sees image blocks without a description and projects the existing deterministic placeholders, so an old harness reads a new log without behavior change. A new reader on an old log sees no descriptions and behaves identically. The field is optional on every affected root, presence alone marks the occurrence described, and no discriminator changes, so the change stays same-version.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm/tests/content.spec.ts: 37 tests passed, covering the described preference in projectImagesForTextModel, the described rendering in projectOffloadedImages, the budget skip through isRetainedImage, and the retained truth table.

<a id="dev-note"></a>
## Dev Note

None.
