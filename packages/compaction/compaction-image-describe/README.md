---
description: "The durable image-description executor for text-only model routes: what to configure when the selected route cannot accept images and a vision chain should describe them instead."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-describe

English | [中文](README.zh.md)

## Summary

Text-only model routes stop losing image content. The plugin describes every retained image on the conversation surface through a chain of vision-capable routes you configure, records each description as a durable `image/describe` decision, and every later request carries that text in the image's place — across steps, resume, and replay. One attachment is described once and its occurrences share the text. A route that fails, stalls, or answers nothing yields to the next chain entry, and a chain with no answer leaves the deterministic placeholder.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in compositions whose selected model route can accept text only while another configured route can see images. It is opt-in: the shipped `dsh` base does not mount it.

### When to choose it

Choose it when images must keep informing a text-only selection — the deterministic placeholder names an attachment but carries no content. Mount [compaction-image-offload](../compaction-image-offload/README.md) as well when an image-capable route can exceed its image budget; the two executors mark disjoint occurrences. Without a reachable vision route the plugin appends nothing, so mounting it is safe but inert.

### Minimal configuration

The `visionRoutes` entries name the chain in try order; the route pair below is a shape template, not a known model.

```yaml
- name: '@deepseek-ai/dsh-compaction-image-describe'
  config:
    visionRoutes:
      - provider: <provider>
        model: <vision-model>
```

| Field | Default | Meaning |
|---|---|---|
| `visionRoutes` | required | The describe chain in try order: one `provider`/`model` pair per entry, at least one |
| `routeStrategy` | `chain` | `chain` keeps the configured order; `same-provider` fronts the selected route's own provider's routes |
| `describePrompt` | the instruction quoted under [Model Experience](#model-experience) | Sent beside each described image |
| `maxDescriptionChars` | `2048` | Cap on one description's character count |
| `describeTimeoutMs` | `45000` | Per-route budget for one description before the route yields to the next |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-image-describe) is the exhaustive source for every accepted field.

### What you can observe

Each description batch appends one `image/describe` event identifying every described occurrence by message-event sequence and image index; message events and surface node identities stay unchanged. The description becomes part of the next derived request, which logs a fresh `request/header` because the surface content changed. The describe call itself is one ordinary model request on the chain route.

### Failures and recovery

The plugin walks the current surface in model-request order, skips assistant nodes and images already described or offloaded, and describes each attachment once. Each route gets one attempt bounded by `describeTimeoutMs`; a failed finish, an empty answer, a stall past the budget, or an unresolvable route yields to the next entry. A chain with no answer appends nothing, so those occurrences keep the deterministic placeholder and the next request tries again. Route admission consults each model's declared input modalities and never sends an image to a route that declares none.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This package owns the event declaration, target validation, the immutable image-description projection, the chain ordering, and the per-request walk. It registers `imageDescribeProjection` with Session before accepting image/describe events. The same browser-safe definition is exported from `./projection` for detached replay; the installed format catalog assembles it for offline readers. Missing registration rejects live restore, and unloading a used definition blocks further message derivation. Token measurement folds recorded descriptions into the same surface pricing the offload marks use.

The `agent/request` listener resolves the call config first, then checks the resolved route's declared input modalities and runs the walk only for text-only routes. The vision inventory is rebuilt lazily and dropped on every `llm/adapters-updated` event; a configured route the registry does not advertise as vision-capable logs a warning and is still tried per request.

The pure projection rejects invalid, repeated, offloaded, or shadowed targets before Session commits the event, and the executor keeps no separate mutable description state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Acknowledged image-description persistence change](../../../docs/persistence-changes/2026-10-14-image-description.md) — the optional `ImageBlock.description` field and its compatibility acknowledgement.
- [dsh-llm](../../llm/llm/README.md) — `ImageBlock.description`, `isRetainedImage`, and the text-only projection that prefers a description.
- [compaction-image-offload](../compaction-image-offload/README.md) — the sibling executor that omits over-budget images on image-capable routes.
- [compaction seam](../compaction/README.md) — the neighboring summary and text-pruning operations.

-----

<a id="model-experience"></a>
## Model Experience

### Described request images

#### What the model sees

Every described occurrence reaches a text-only route as text naming the attachment and the recorded description (`describedImageText`); an occurrence without a recorded description keeps the deterministic text-only placeholder (`textOnlyImageText`). Descriptions persist across requests, resume, and replay. The describe request itself carries the raw image beside the verbatim instruction below.

##### Verbatim describe instruction

```markdown
Describe this image completely and precisely for a text-only model that will never see it. Transcribe every piece of visible text verbatim, then name the layout, objects, people, colors, and any UI elements, diagrams, or annotations.
```

#### Token effect

A described occurrence costs its description text instead of the placeholder text. The token meter applies logged descriptions when pricing each node, and route pricing prices the description text on text-only and image-capable routes alike. Reference-only heuristic counts exclude description metadata.

#### KV Cache effect

The description replaces the placeholder text at the described occurrence, so provider cache reuse ends at the first message whose image was described. Later requests keep the same text and stay prefix-stable. The describe call itself is an independent model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A turn's incoming batch is described at the next request boundary** — the loop commits the accepted user batch after the `agent/request` waterfall, so the images a turn brings are first served as the deterministic placeholder; the recorded description applies from the next request onward. Describing at admission is the planned follow-up.
- **Descriptions are permanent** — a recorded description never reverts and is never re-described, matching the offload marks; a poor description stays for the session's lifetime.
- **Only routes that declare text-only input trigger descriptions** — unlisted modalities pass image bytes through to the adapter; a route that misdeclares its modalities is not corrected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked persistence-change record.

- Describing a turn's incoming batch before its first request is the planned second piece of the GitHub discussion this package implements; the walk already handles every surface node generically, so the change is confined to the trigger.

</details>
