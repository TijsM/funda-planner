# Making the render obey the plan

**Decision document — funda-planner render pipeline**
Written 2026-08-18. Every claim below is tagged **[verified]** (opened primary source), **[conflicting]** (two sources disagree — do not budget on it), or **[estimate]** (my inference, not sourced).

---

## 1. The finding that decides everything

**`input_image` on FLUX.2 is a semantic reference channel, not a spatial control channel. Black Forest Labs says this in their own documentation.**

From <https://docs.bfl.ai/guides/usecases_editing_controlnets> (titled "Pose & Layout Guidance"), verbatim **[verified]**:

> Instead of dedicated ControlNet inputs, FLUX.2 uses its multi-reference editing system to achieve structural control.

and

> FLUX.2 interprets structure semantically.

The `/v1/flux-2-max` request body is exactly: `prompt`, `disable_pup`, `input_image`…`input_image_8`, `seed`, `width`, `height`, `safety_tolerance`, `output_format`, `webhook_url`, `webhook_secret` **[verified]** against <https://api.bfl.ai/openapi.json> and the [max] API reference. There is no `strength`, no `guidance`, no `steps`, no `conditioning_scale`, no control map, and no negative prompt. `src/server/providers/bfl.ts` already transcribes this correctly — the file is right, the model is the constraint.

So: **the drift is not a prompting bug and cannot be fixed by better prompting.** We are asking a model to match geometry through a channel that its vendor documents as "interpreted semantically." The class of fix is one of exactly two things:

- **(A) Change the conditioning channel** — move to a model that accepts a per-pixel control map with a strength dial (`conditioning_scale`, `control_scale`) or a per-pixel change map. We are unusually well placed for this: we draw the conditioning image from vector geometry, so canny lines, straight-line-segment maps, a 1.2 m-cut depth field, per-room segmentation, and per-object masks all cost us nothing to emit.
- **(B) Make the geometry correct by construction before diffusion touches it** — extrude the plan to grey massing, render depth/normal/segmentation buffers server-side, and let the model do materials and light rather than layout. This is the only route that helps the eye-level and isometric views, where the 2D drawing simply does not contain the information needed.

Everything else on this page is a variation on A, B, or the free hygiene that should happen regardless.

### The five observed failures are not one failure

Worth separating, because they need different fixes and only three of them are geometry:

| Symptom | Actual cause | What fixes it |
|---|---|---|
| 3/4 dollhouse tilt instead of orthographic | Learned projection prior in the weights, plus seed. arXiv:2510.21763 documents FLUX "consistently fails to render 3-point perspectives" and shows "a strong prior for straight horizons… inherited from both its training data and the base FLUX model" **[verified]**. arXiv:2411.18810 finds seeds encode "patterns of camera angles and image composition" **[verified]**. | Geometry in the conditioning image (a real ortho projection), plus seed pinning. Not prompt words — `AI_VIEWS.top.cam` in `src/engine/prompt.ts` is already about as forceful as English gets. |
| Walls/proportions wander, worse for rooms described later | Positional control through text is weak. arXiv:2507.08039 measures shape-identity F1 at 96% but **quadrant F1 at 0.41 for diffusion models** (0.5 for Janus Pro) at 1024px **[verified]**. Our `LOCKED` block is ~600–900 words; BFL's own guide says "Medium (30-80 words): usually ideal" and "Word order matters — FLUX.2 pays more attention to what comes first" **[verified]**. | Delete `placeOf()` from the prompt. Position belongs in pixels. |
| Furniture moves; chair counts change | Counting is a known hard failure. arXiv:2503.06884, "Text-to-Image Diffusion Models Cannot Count, and Prompt Refinement Cannot Help" — "all state-of-the-art diffusion models fail to generate the correct number of objects" and prompt refinement "generally do not improve counting accuracy" **[verified]**. The `SEATS` paragraph in `buildPrompt` is doing work no prompt can do. | Distinct silhouettes with visible gaps in the conditioning image; then a verify-and-retry loop. |
| Our lettering bleeds into the output | Anything drawn on the conditioning PNG is geometry to the model, and FLUX.2 has **no negative prompt** to push against it **[verified]**. The InstantX Qwen ControlNet card confirms the coupling from the other side: "The model was unable to preserve some details without explicit 'TEXT' in prompt, such as small font text" **[verified]**. | **Done, 2026-08-26 — and the two-step it took is the finding.** Captions were removed for being unreadable (0.7% of the image, ~1.5 px after an 8× downsample) and replaced with numbered discs at 2%. Legible, and the next render came back with nine black roundels painted on the floor. There is no size that works: the reference is now glyph-free by rule, and identity moved into the brief's OBJECTS table as name + room + `Where`. |
| Invented title blocks and dimension captions | Learned prior about what a floor plan drawing looks like — we hand it a draughtsman's drawing, it completes the genre. | Stop handing it a drawing (buffers instead of ink), or a LoRA that never sees a title block. |

Note the existing comment in `src/shell/files.ts` about the letterbox framing already found and fixed one instance of exactly this — "the generator filled the spare bands with an invented title block." That instinct was right and generalises.

---

## 2. Ranked options

**Ranking function:** expected drift reduction ÷ (engineer-days + first-month spend). Cost per image is directly comparable across every row because `TARGET_PIXELS = 1_000_000` in `src/state/renders.ts` — we generate at ~1 MP, so a per-megapixel price *is* the per-render price. Current spend: **$0.07/render** (FLUX.2 [max], "from $0.07 per megapixel", <https://docs.bfl.ai/quick_start/pricing>) **[verified]**.

Fidelity-gain figures are **[estimate]** unless stated. Nobody has benchmarked any of this on Dutch apartment plans; that is precisely why §3 exists.

| # | Option | Days | $/render | Fidelity gain | Ratio |
|---|---|---|---|---|---|
| 0 | Evaluation harness | 3–4 | $0 | none directly | prerequisite |
| 1 | Free hygiene: kill baked labels, gut the prompt, pin seeds | 1–2 | $0.07 (unchanged) | large on text failures, small–moderate on geometry | **highest** |
| 2 | Multi-reference: use `input_image_2..8` for region masks / depth | 1 | $0.07 | unknown, possibly moderate | very high (costs an afternoon) |
| 3 | Emit control maps from `paint()`, A/B on a real ControlNet | 4–6 | $0.0065–$0.075 | **large** — the actual fix for A | high |
| 4 | Per-pixel change map (differential diffusion) | +2 on top of 3 | unpublished | large on "walls frozen, floor free" | high, cost unknown |
| 5 | Provider swap to Qwen-Image-Edit-2509 | 0.5 | $0.02–0.03 **[conflicting]** | unknown, between #1 and #3 | high but unproven |
| 6 | [flex] instead of [max] for `guidance` + `steps` | 0.5 | $0.05 | small | medium |
| 7 | Masked per-room repair pass | 3–5 | +$0.05–0.075 per room | moderate on late-room decay | medium |
| 8 | Geometry-first: 3D massing → depth/normal/seg buffers | 10–20 | $0.0065–0.075 | **largest**, and the only fix for eye-level/iso | low ratio, high ceiling |
| 9 | Paired LoRA on our own (plan, render) pairs | 15–25 | ~$0.015–0.03 | large on convention + title blocks, not on geometry | low ratio, best long game |
| 10 | Self-host FLUX.2-dev-Fun-ControlNet (MLSD) | 20+ ops | GPU-hour | best technical fit | **do not do this** (licence) |

### Option 0 — The evaluation harness (do this first; it gains nothing and everything depends on it)

Detailed in §3. Ranked above every option because the entire table's fidelity column is currently guesswork, and will stay guesswork until the harness exists. Three to four days.

### Option 1 — The free afternoon (rank 1)

Four changes, zero cost, zero architecture:

**1a. Never bake lettering into the conditioning PNG.** `src/shell/ui/RenderModal.tsx:126` passes `objectLabels: imgLabels` into `renderFloorCanvas`. Make Generate always pass `objectLabels: false`, and demote the `imgLabels` toggle to the preview/print path only. The prompt already has an elaborate mitigation for this (the `imgLabels` branch in `buildPrompt` that calls the captions "a key… draw none of the lettering") — that mitigation asks FLUX.2 to obey a negative instruction, which is the one thing BFL's guide explicitly says it is bad at: "FLUX.2 does not support negative prompts. Focus on describing what you want, not what you don't want" **[verified]**, <https://docs.bfl.ml/guides/prompting_guide_flux2>. Replace the captions with names in the prompt text and identity-by-silhouette in the drawing.

**1b. Delete `placeOf()` from the prompt.** `objRow()` in `src/engine/prompt.ts` emits a `Position` column ("against the left wall, upper", "top-right"). That is spatial information being pushed through the channel measured at 0.41 quadrant F1 **[verified]**, while the same information sits perfectly in the conditioning image. Keep `Room`, `Object`, `Notes`. Drop `Position`, and drop `Size` too when `dimensions` is on — a size in cm is unactionable and it invites the model to draw a dimension caption.

**1c. Get the constraint block under 80 words and front-load it.** BFL: "Put your most important elements at the beginning" and 30–80 words is the documented sweet spot **[verified]**. The current brief is right to put `CAMERA AND OUTPUT` first (the comment in `buildPrompt` shows that was a deliberate fix) — go further and cut the tables to names and notes. The `SEATS` chair paragraph and the `anonFitted` paragraph are load-bearing prose that arXiv:2503.06884 says will not work; keep them only until 1d/Option 3 replaces them.

**1d. Pin the seed per plan.** `nextSeed`/`seedLocked` already exist in `src/state/renders.ts`. Run 4 seeds on each fixture plan, score them with the harness, and default the plan to its best. arXiv:2411.18810 reports 29.3% relative gain on numerical composition and 60.7% on spatial composition from reliable-seed mining, and finds seeds carry camera-angle patterns **[verified]**. This is the cheapest possible attack on the dollhouse tilt.

**Risk:** none. **Expected gain [estimate]:** lettering bleed and invented title blocks largely gone; geometry maybe 10–20% better. It will not close the gap.

### Option 2 — Use the seven unused reference slots (rank 2)

`flux-2-max` accepts `input_image` through `input_image_8` **[verified]** — we use one. BFL's layout guide publishes the exact phrasing for this use case **[verified]**:

> Keep the exact spatial arrangement from image 1 — same composition, same positioning of elements.
> Maintain all proportions and positioning.

Send: image 1 = clean line drawing (no text), image 2 = per-room flat-colour region map, image 3 = 1.2 m-cut greyscale height map. Lead the prompt with the sentence above, before the `LOCKED` block.

**Honest caveat:** there is no evidence anywhere that FLUX.2 will *use* a depth map handed to it as a reference image. Its docs mention depth maps only as a generic concept. This is speculation, but it costs one afternoon and no extra money (billing is on output resolution only **[verified]**), so it should be tested before anything is built. **[estimate]**

### Option 3 — Emit control maps and move to a model with a strength dial (rank 3; this is the real fix)

Two halves. The first is ours and is reusable by every later option:

**3a. Add a `pass` discriminator to the painter.** `PaintInput` at `src/engine/render.ts:15` already documents that `paint()` "reads no globals, which is what lets the same code run in a browser and under node-canvas." Add:

```ts
pass?: 'ink' | 'line' | 'depth' | 'seg' | 'change';
```

- `line` — walls and openings as clean high-contrast strokes, thickened so they survive VAE downsampling, no furniture glyph interiors, no hatch.
- `depth` — greyscale at the 1.2 m cut: floor far, wall tops near, each object's top at its own height.
- `seg` — one flat colour per `Area`, one per catalogue `group`, from `f.areas` and `CAT_BY_KIND`.
- `change` — per-pixel denoise strength for Option 4: walls ~0.05, fitted joinery ~0.2, loose furniture ~0.4, floor ~0.9.

The only new **data** is object height. `CatalogEntry` at `src/engine/catalog.ts:8` is `{ kind, name, w, h, draw, group, alt? }` — no `z`. Adding `z` to 120 rows is an afternoon of typing, and it is the gating item for `depth`. That is genuinely most of the work here.

**Resolution note:** the conditioning canvas is 1800 px (`maxPx: 1800`, RenderModal:126) while output is ~1000 px. Published ControlNets were trained at 512 (Shakker Union Pro 2.0) and 1328 (InstantX Qwen Union) **[verified]** — on photographic content, not thin-line drawings. Generate near the control branch's native resolution and upscale; thicken lines. **[estimate on the mechanism, verified on the training resolutions]**

**3b. The endpoints.** Two, for two different jobs.

*Cheap test rig* — `fal-ai/z-image/turbo/controlnet`, <https://fal.ai/models/fal-ai/z-image/turbo/controlnet>. Z-Image Turbo, 6B, Alibaba Tongyi-MAI, `licenseType: "commercial"` on fal's own record **[verified]**. Parameters: `image_url`, `control_scale` (default 0.75, 0–1), `control_start` (default 0), `control_end` (default 0.8), `preprocess` enum `['none','canny','depth','pose']` — **`preprocess: 'none'` means our hand-authored map goes in verbatim with no detector in the path**, which is exactly what we want. `num_inference_steps` max 8. **$0.0065 per megapixel [verified]** from fal's `endpointBilling` record — about one eleventh of what we pay now. At that price a full sweep across three control signals × four strengths × ten plans is under two dollars. It will not match FLUX.2 [max] on photorealism; it is not meant to. It is how we find out *which signal locks the geometry* for the price of a coffee.

*Production candidate* — `fal-ai/flux-general/image-to-image`, <https://fal.ai/models/fal-ai/flux-general/image-to-image/api>. FLUX.1 [dev] with arbitrary ControlNet weights by URL. Verified schema: `controlnets[]` with `path`, `control_image_url`, `conditioning_scale` (default 1, 0–2), `start_percentage`, `end_percentage` (default 1), `mask_image_url`, `mask_threshold`; separate `controlnet_unions[]` where each entry carries its own `control_mode`; plus `ip_adapters[]`, `loras[]`, `strength` (default 0.85), `guidance_scale` (3.5), `num_inference_steps` (28), and a real `negative_prompt` with NAG **[verified]**. **$0.075/MP, billed rounded up to the nearest megapixel [verified]**, `~10.6 s` inference on fal's own sample. fal's spec table reads "License | Commercial use permitted" with `licenseType: "commercial"` **[verified]**.

Suggested starting weights: Shakker-Labs FLUX.1-dev-ControlNet-Union-Pro-2.0 (canny / soft-edge / depth / pose / grayscale; card recommends depth at scale 0.8, `control_guidance_end` 0.8) **[verified]**.

**Two traps.** (i) `strength` defaults to **0.85**, a creative-transformation setting that will move walls. Set it explicitly, low. (ii) The licence split: fal's *hosting* of FLUX.1 [dev] is commercially permitted per fal, but the third-party ControlNet weights you name via `path` carry their own terms — Shakker's card is `flux-1-dev-non-commercial-license` **[verified]**. Get an answer in writing before this ships. **This is a real, unresolved commercial risk and it is the main argument for Option 5.**

**Expected gain [estimate]:** this is the largest single-step improvement available at reasonable cost. Published calibration: 3DIS-FLUX (arXiv:2501.05131) reports 62.9% average instance success ratio using a coarse depth map plus depth-controlled FLUX, degrading to 58.9% at six objects **[verified]**. That is the honest ceiling for layout control on object placement — a floor with thirty catalogue items will not be perfect. Walls and room proportions should do much better than furniture, because straight lines are the easiest thing a line ControlNet can hold.

**Risk:** FLUX.1 [dev] is a generation behind FLUX.2 [max] on photorealism. We would be trading polish for geometry. The harness must score *both*, and a human has to look at the pictures.

### Option 4 — Per-pixel change map (rank 4)

`fal-ai/flux-general/differential-diffusion`, <https://fal.ai/models/fal-ai/flux-general/differential-diffusion>. Takes `image_url`, `change_map_image_url`, `strength` (default 0.85) **and** the full `controlnets` / `controlnet_unions` arrays in the same call **[verified]**. Underlying method: Levin & Fried, "Differential Diffusion: Giving Each Pixel Its Strength", arXiv:2306.00950 — inference-time only, no training **[verified]**.

This is conceptually the best fit on this page: we can say *walls may not change, floor may change completely* as a picture rather than as a sentence. And the `change` pass from 3a generates it for free.

**Blocker:** fal's billing record for this specific sub-endpoint reads `{billing_unit: "compute seconds", price: 0, enterprise_status: "pending"}` while its siblings read `{megapixels, 0.075}` **[verified]**. **There is no published price.** Do not budget it at $0.075/MP; make one metered call and read the invoice.

### Option 5 — Provider swap to Qwen-Image-Edit-2509 (rank 5)

`fal-ai/qwen-image-edit-plus`, <https://fal.ai/models/fal-ai/qwen-image-edit-plus>; also on Replicate as `qwen/qwen-image-edit-plus`. Model card: 20B, **Apache 2.0**, "Native Support for ControlNet: Including depth maps, edge maps, keypoint maps, and more", "optimal results using 1–3 input images" **[verified]**.

The appeal is that it is the only option that is simultaneously (a) commercially clean with no licence question, (b) hosted with zero ops, and (c) structure-aware. Effort is hours: `src/server/providers/bfl.ts` is already a clean single-file wire contract, and `MODEL` is one constant (its own comment notes `MODEL_LABEL` in `src/state/renders.ts` must move in the same commit).

**Be honest about what it is not:** the README describes those ControlNet conditions arriving through the ordinary multi-image `image_urls` list. There is **no separate control slot and no `conditioning_scale`** on the hosted endpoint **[verified]**. So adherence is somewhere between FLUX.2's semantic reference and a true ControlNet, and nobody has measured where. It must be A/B'd, not assumed.

**Price [conflicting]:** fal's pricing page lists a generic "Qwen" line at $0.02/MP; one verified read of the endpoint page reported $0.03/MP. Both are well under $0.07. Confirm on the endpoint page before budgeting.

### Option 6 — [max] → [flex] (rank 6)

`POST https://api.bfl.ai/v1/flux-2-flex` adds `guidance` (default 5, range 1.5–10) and `steps` (default 50, range 1–50) **[verified]**, at **$0.05/MP** vs $0.07 **[verified]**. A one-line change in `bfl.ts`.

**The trap:** [flex] uses `prompt_upsampling`, **not** `disable_pup`. Our current `disable_pup: true` has no counterpart and would be silently ignored, handing the `LOCKED` block to BFL's rewriter — the exact failure the comment in `bfl.ts` says we disabled it to prevent. **[conflicting]** on the default: one verification read `prompt_upsampling` default `false`, another read default `true`. Send `prompt_upsampling: false` explicitly and do not rely on either.

Direction to move `guidance`: **down, not up.** Kynkäänniemi et al., NeurIPS 2024 (arXiv:2404.07724) find guidance is "clearly harmful toward the beginning of the chain… largely unnecessary toward the end… only beneficial in the middle" **[verified]**. Reflexively cranking it to force adherence is likely to increase drift, not reduce it.

### Option 7 — Masked per-room repair (rank 7)

The "later rooms drift more" symptom disappears by construction if each room gets its own short prompt over its own mask. We already hold every room polygon in `f.areas`, so masks are free.

Use `fal-ai/flux-general/inpainting` (<https://fal.ai/models/fal-ai/flux-general/inpainting>), which carries `mask_url` **and** the full `controlnets` arrays **[verified]** — it is the only verified combination that keeps a global geometry lock applied *while* restricting which region may change, so a room repair cannot silently move a shared wall. $0.075/MP per pass.

The alternative, FLUX.1 Fill [pro] at BFL, is **$0.05 flat per image** (5 credits) regardless of size **[verified]** — cheaper, but it has no control signal, so nothing stops a repair nudging a party wall.

**Do not use `gpt-image-2` for this.** OpenAI's guide states: "Masking with GPT Image is entirely prompt-based. The model uses the mask as guidance, but may not follow its exact shape with complete precision" **[verified]**. An inexact mask boundary is precisely how a shared wall moves.

Cost for a 6-room plan: base render + ~$0.30–0.45, plus 6 sequential round trips of latency. Ship as a quality tier, not a default.

### Option 8 — Geometry-first (rank 8 by ratio; highest ceiling)

Extrude walls from `src/engine/geometry.ts`, cut at 1.2 m, drop box proxies per catalogue item using the new `z`, render orthographic (and perspective) depth / normal / per-instance segmentation buffers in headless three.js or Blender, and condition on those.

**Why it is worth naming despite the ratio:** it is the *only* thing that helps `eye` and `iso`. A 2D plan does not contain what an eye-level camera needs; no amount of ControlNet on a top-down drawing will. And it has the strongest literature support of anything here — four independent primary sources converge on rendered depth + semantic buffers as the conditioning signal: ControlRoom3D (arXiv:2312.05208), Ctrl-Room (arXiv:2310.03602, "a Layout Generation Stage and an Appearance Generation Stage"), SpatialGen (arXiv:2509.14981), CHOrD (arXiv:2503.11958) **[all verified]**. Autodesk's own head-to-head is the closest published analogue to our exact task: with depth/normal maps "the staircase, mezzanine railing, and hallway corridor closely match the original layout"; with only a screenshot, "the stair geometry shifts, railing styles change, and the spatial proportions are reinterpreted." Their verdict: "yes, you still need ControlNet — if the output needs to respect the geometry of your design" **[verified]**, <https://aps.autodesk.com/blog/do-you-still-need-controlnet-testing-next-gen-models-viewer-scenes>.

Compute is not the cost — a 15–30 s Cycles render is $0.005–0.009 on a Modal L40S at $0.000542/sec **[verified]**. The cost is a Python/Blender service inside a Node stack and geometry for 120 catalogue entries that today are 2D glyph functions with no meshes. Weeks.

**The question worth asking at the end of this route:** once the orthographic massing render is correct by construction, render one plan both ways and see what the diffusion pass is still doing. For the top-down view the answer may be "materials, shadows and grain" — a much cheaper problem than the one we started with.

> **Half of this shipped, 2026-08-27, and the estimate above was wrong in a useful way.**
>
> The perspective half — an eye-level camera you place on the plan, and the same five conditioning
> maps rendered from it — is in `src/engine/{camera,scene,pov}.ts`, and it took a day rather than
> weeks. Two assumptions in the paragraph above are what made it look expensive:
>
> - **"geometry for 120 catalogue entries that today are 2D glyph functions with no meshes."**
>   They do not need meshes. A box the height of the entry's `Z` carries position, size, occlusion
>   and silhouette, which is the whole of what a control encoder reads; the glyph's detail is
>   texture, and texture is the half the diffusion model is for. The `Z` table added for the
>   top-down depth pass turned out to be the entire third dimension this needed.
> - **"a Python/Blender service inside a Node stack."** Not needed either. There is no lighting to
>   solve and no material model — the output is a depth buffer, a segmentation buffer and a flat-lit
>   massing render. That is a z-buffered triangle rasteriser, about 150 lines, and it runs in the
>   browser and under `@napi-rs/canvas` on the same code path as everything else in `src/engine`.
>   A 1800 × 1200 sweep over a real Dutch ground floor is 82 ms.
>
> Cycles-quality shading and the orthographic/isometric half are still unbuilt, and the open
> question at the top of this box — what the diffusion pass is still doing once the massing is
> correct — is still open, because the eval harness (§3) sweeps `eye` against the *top-down*
> drawing and has not been repointed at the new one. That is the next measurement, not a detail.

### Option 9 — Train a LoRA on our own (plan, render) pairs (rank 9; start collecting data now)

This is the only option that teaches a model *our* drawing convention — what a 1.2 m wall cut, a door-swing arc, and a 4-seat table glyph actually mean — rather than hoping a generic edge conditioner infers it. And it is the direct kill for invented title blocks and dimension captions: they never appear in the training targets.

Two verified hosted trainers, both taking paired images:

- `fal-ai/flux-2-trainer/edit` — zip of `XXX_start.png` / `XXX_end.png`; "15-50 high-quality before/after pairs"; base FLUX.2 [dev]. Price **`0.0056 * steps * reference_multiplier`**, stated as **$11.82 for 1,000 steps with 1 reference** **[verified]**.
- `fal-ai/flux-2-klein-9b-base-trainer/edit` — same `ROOT_start.EXT` / `ROOT_end.EXT` shape; **`0.002 * steps * reference_multiplier`**, ~$2 for 1,000 steps **[verified]**. Serve on `fal-ai/flux-2/klein/9b/edit/lora`.
- Local alternative: ai-toolkit with `control_path:` alongside `folder_path:` on **FLUX.2 [klein] Base 4B, which is Apache 2.0** — BFL's own post says "~an hour on an RTX 4090, and costs roughly $0.50 if you rent the GPU", lr 1e-4, network dims 128/64/64/32, "50-200 pairs is plenty" **[verified]**, <https://huggingface.co/blog/black-forest-labs/flux-2-klein-lora>.

**Action today, costing nothing: start logging every accepted (conditioning PNG, final render) pair.** `RenderRecord` already exists; add the pair. In three months that is the dataset, and it is free.

**Caveats:** klein is 4B/9B and materially below [max] on photorealism; klein 9B weights are FLUX Non-Commercial while 4B is Apache 2.0 **[verified]**. BFL's klein docs describe uploading `.safetensors` under Customization → Finetunes and calling `-finetuned` endpoints with `finetune_id` — but that path does **not** appear in `api.bfl.ai/openapi.json` **[conflicting]**. Probe it live before planning around it.

### Option 10 — Self-hosting (do not)

`alibaba-pai/FLUX.2-dev-Fun-Controlnet-Union` is the best technical fit in existence: Canny, HED, Depth, Pose, **MLSD**, Scribble, Gray, plus inpainting on a FLUX.2 base; ControlNet on 4 double blocks; optimal `controlnet_conditioning_scale` 0.65–0.80; and its card claims it "adheres more reliably to control instructions" than native FLUX.2 editing **[verified]**. MLSD — straight line-segment detection — is the single most on-point control modality for architectural walls, and appears in no other union checkpoint.

It is **`flux-dev-non-commercial-license`**, has no hosted endpoint anywhere (three plausible fal endpoint ids all 404), and runs through Alibaba's VideoX-Fun codebase **[verified]**. That means GPU provisioning, cold starts, weight management, and our own autoscaling — a genuine step change in cost and ops for a commercial property product, plus a licence negotiation with BFL.

**Recommendation: watch list only.** The day an aggregator hosts it commercially, it becomes the best option on this page.

### Confirmed dead ends — do not spend a day discovering these

- **BFL `flux-pro-1.0-canny` / `flux-pro-1.0-depth`** — deprecated 2025-10-03, effective **2025-10-31**, "Migrate to flux-pro-1.1 or flux-kontext-pro" **[verified]**. Replicate still serves `black-forest-labs/flux-canny-pro` and `flux-depth-pro` (`control_image`, `guidance`, `steps`; $0.05/output image; republished 2025-10-31, running on `hardware: CPU`, i.e. proxies) **[verified]**. The `-dev` variants run on Replicate's own A100/H100 at $0.025/image and are the more durable bet. Either way: FLUX.1-era, no `conditioning_scale`, no timestep window. Throwaway A/B rig at best.
- **Vertex `imagen-3.0-capability-001`** (`REFERENCE_TYPE_CONTROL`, `CONTROL_TYPE_CANNY`, `CONTROL_SCALE` default 0.95) — migration deadline was 30 June 2026, **seven weeks in the past**. Imagen 4 shut down **17 August 2026 — yesterday** **[verified]**. Gone.
- **Nano Banana / Gemini 3 Pro Image, 3.1 Flash Image** — real, current, and worth one A/B for the *lettering and caption* failures (gemini-3.1-flash-image is $0.067 at 1K, cheaper than we pay now; gemini-3-pro-image $0.134) **[verified]**. But **no control-map input on any of them** — it is semantic conditioning, same class as FLUX.2. Expect help with garbled text, not with wall positions.
- **BFL FLUX 3** — video with synchronised audio, `POST /v1/flux-3-video`. Not a still-image successor. Ignore it **[verified]**.
- **InstantX/Qwen-Image-ControlNet-Union** (Apache 2.0, canny/soft-edge/depth/pose, scale 0.8–1.0) — genuinely good weights with **no hosted endpoint** (fal and WaveSpeed 404) **[verified]**. Apache 2.0 only helps if you self-host, which contradicts our constraint.

---

## 3. The evaluation harness

Build this first. Every fidelity number in §2 is a guess, and will remain one until this exists. Ship it before spending a single dollar on a migration.

### The discipline, from ControlNet++ (arXiv:2404.07987)

The paper's core method is **cycle consistency**: run a discriminative extractor on the *generated* image, recover the condition, compare it to the condition you fed in. It reports +11.1% mIoU (segmentation), +13.4% SSIM (line-art), +7.6% RMSE (depth) over vanilla ControlNet by optimising exactly this **[verified]**. We are not adopting the model — we are adopting the measurement.

The one rule to copy verbatim from their Table 7 protocol **[verified]**: **never score with the extractor you tuned against.** They tune with UperNet-R50 and evaluate with Mask2Former; tune with DPT-Hybrid, evaluate with DPT-Large. Same for us.

**Our unfair advantage:** we hold ground-truth vector geometry. We do not need to extract the condition from the input — we *have* it. Scoring is objective, not a VLM's opinion.

### Fixtures

- **10 plans**, frozen in the repo as `.fml`/serialized `Floor` JSON: two studios, four typical Dutch apartments, two open-plan, two multi-room houses. Include one with a staircase and one with ≥3 tables (the chair-count case).
- **4 seeds**, hard-coded.
- **4 views** (`top`, `eye`, `iso`, `sketch`).
- 160 renders per sweep = **~$11.20** at the current $0.07 **[verified arithmetic on a verified price]**.
- Freeze plans, seeds, extractor versions, and thresholds as repo fixtures. Pin extractor model versions — the point is reading *differences* across A/B runs, not absolute accuracy.

### Ground truth, emitted from the model we already have

Alongside each conditioning PNG, dump a JSON sidecar:

```
{ envelope: Pt[],                     // shellBBox / outer wall polygon
  rooms: [{ id, name, poly, rank }],  // rank = position in the LOCKED block
  items: [{ kind, x, y, w, h, rot }],
  openings: [{ wallId, at, type, width }],
  expectedSeats: number }             // sum over SEATS[kind]
```

`rank` is the important one — it makes "rooms described later drift more" a measurable hypothesis rather than an impression.

### The metrics, in build order

1. **`text_pixel_fraction` and `unexpected_token_rate`** — PaddleOCR or Tesseract on the render. Free, ~100 ms/image, half a day. Directly answers "does `imgLabels` cause bleed?" as a controlled A/B, and catches invented title blocks. **Highest value per hour on this list. Build it first.**
2. **`envelope_iou`** — align render→plan with a similarity transform, then IoU of the outer footprint. Field convention scores the envelope separately from partitions: FloorplanVLM (arXiv:2602.06507) headlines 92.52% external-wall IoU **[verified]**.
3. **`room_iou[rank]`** — per room, reported individually and ordered by prompt rank. Never a single blended number. Shapely + numpy over our own polygons.
4. **`count_error`** — OWLv2 or MM-Grounding-DINO with the 120-entry catalogue as the open vocabulary; compare detected counts to `expectedSeats` and per-kind counts. **Use open weights you can pin**, not Grounding DINO 1.5 Pro, which is API-gated **[verified]**. Note arXiv:2506.23751 finds open-vocabulary models on generated imagery show "a strong dependence… on object location, rather than on object semantics" **[verified]** — read this metric as a delta, not as truth.
5. **`tilt_residual`** — dense-match the render against the conditioning PNG with RoMa (arXiv:2305.15404, DINOv2 features + ConvNet fine features + transformer match decoder **[verified]**) or LightGlue for speed; fit both a similarity transform `S` (`cv2.estimateAffinePartial2D`) and a homography `H` (`cv2.findHomography`); report `||H − S||`. A true orthographic top-down should be near-affine; a dollhouse tilt will not be. **This construction is ours, not a published method — do not present it as one.**
6. **`line_f1`** — Kornia canny on the render vs our own wall raster. ControlNet++ justifies F1 over IoU here: edge detection is "a binary classification problem of 0 (non-edge) and 1 (edge) and has a serious long-tail distribution" **[verified]**.
7. **`vqa[clause]`** — VQAScore (arXiv:2404.01291), one question per constraint clause in `buildPrompt`, giving a per-sentence scoreboard of which instructions are actually obeyed. The paper's CLIPScore criticism applies exactly to our `LOCKED` tables: CLIP text encoders "can notoriously act as a bag of words, conflating prompts such as *the horse is eating the grass* with *the grass is eating the horse*" **[verified]**. Local, deterministic, free.
8. **`dreamsim`** (arXiv:2306.09344) between two same-seed renders — a regression tripwire that tells you instantly whether a prompt tweak changed anything at all. **Guardrail, never an optimisation target.**

### Judging, where numbers run out

Photorealism and "does it look like a home" need a judge. Use **pairwise A/B, both orderings to cancel position bias — never absolute 1–10 scores**. arXiv:2604.25235 measures VLM judge prediction-interval widths of 2.08 on AesBench (~52% of the score range) and 3.50 on InfographicsVQA (~88%), and concludes: "For applications requiring reliable absolute scores, wide intervals indicate that point predictions are unreliable, and pairwise comparison is preferable" **[verified]**. 160 renders × 2 orderings is well under $10 per evaluation.

### Statistics

Pair on `(plan, seed)`. Resample **plans** as the unit (bootstrap, B ≈ 2,000). Report a confidence interval on the **difference**, not two separate means. Never FID at n=160 — it is severely biased at small sample sizes. **This protocol is our own methodology; it is not prescribed by ControlNet++ or GenEval, and should not be cited to them.**

### Shipping it

`pnpm eval` → renders the grid (or reads a cached run) → writes one JSON scorecard per render next to the `RenderRecord` → prints a diff table against the last committed baseline. Commit the baseline. Any PR touching `prompt.ts`, `render.ts`, or the provider must show the table.

**One structural note:** shape the top-level function as `score(image, plan) -> {metrics, composite}`. `room_iou`, `count_error` and `tilt_residual` are all valid GRPO rewards as they stand, so if Flow-GRPO-style RL ever becomes worth it (arXiv:2505.05470 reports GenEval 63% → 95% on SD3.5-M), the door is already open. Keeping it open costs nothing.

---

## 4. Papers worth reading

| arXiv | Title | Why |
|---|---|---|
| **2404.07987** | ControlNet++: Improving Conditional Controls with Efficient Consistency Feedback | The cycle-consistency evaluation protocol. Read §Table 7 for the tune-with-one-extractor / score-with-another rule. This is the harness. |
| **2507.08039** | (spatial-control evaluation) | Measures quadrant F1 at 0.41 for diffusion vs shape-identity F1 at 96%. The single strongest justification for deleting `placeOf()` from the prompt. |
| **2503.06884** | Text-to-Image Diffusion Models Cannot Count, and Prompt Refinement Cannot Help | Closes off prompt-side fixes for chair counts. Read before writing another `SEATS` paragraph. |
| **2411.18810** | All Seeds Are Not Equal | Seeds encode camera angle and composition; +60.7% on spatial composition from seed mining. The cheapest attack on the dollhouse tilt. |
| **2510.21763** | Proportion and Perspective Control for Flow-Based Image Generation | FLUX's perspective prior is in the weights ("axis dropping", strong straight-horizon prior). Also: stacking ControlNets at 0.8 each causes "severe color artifacts and mushy textures" — drop to ~0.5 each. |
| **2501.05131** | 3DIS-FLUX | Coarse depth map → depth-controlled FLUX. 62.9% average instance success, 58.9% at six objects. The honest ceiling for what layout control buys on object placement. |
| **2306.00950** | Differential Diffusion: Giving Each Pixel Its Strength | Per-pixel change strength, inference-time only. The mechanism behind Option 4. |
| **2404.07724** | Guiding a Diffusion Model with a Bad Version of Itself | Guidance is harmful early, unnecessary late. Tells you to turn `guidance` **down** on [flex], not up. |
| **2404.01291** | Evaluating Text-to-Visual Generation with Image-to-Text Generation (VQAScore) | Per-clause prompt-adherence scoring, and why CLIPScore is useless on our `LOCKED` tables. |
| **2411.02395** | Training-free Regional Prompting for Diffusion Transformers | Binds each room's text to its own polygon mask — conceptually the cleanest fix for late-room decay. No hosted path; self-host only. On the shelf. |
| **2312.05208 / 2310.03602 / 2509.14981** | ControlRoom3D / Ctrl-Room / SpatialGen | Three independent confirmations that layout-then-appearance with rendered buffers is the field's consensus architecture. The evidence base for Option 8. |
| **2405.00666** | RGB↔X: Image Decomposition and Synthesis Using Material- and Lighting-aware Diffusion Models | Supports **partial** intrinsic specification — pin geometry channels exactly, let lighting and materials free. That is precisely the fidelity/stylability trade this product needs. Its channel set (albedo, roughness, metallicity, normal, irradiance) is the defensible basis for what to emit in Option 8. |

---

## 5. What is still unknown

**The decisive unknown:** *does a per-pixel control signal derived from our vectors actually hold walls on a photorealistic interior render, and which signal wins — line/canny, MLSD-style straight segments, a 1.2 m-cut depth field, or per-room segmentation?* Nothing published benchmarks any of this on architectural floor plans. Every recommendation in §2 above rank 3 rests on the assumption that the answer is yes.

**The one experiment that resolves it.** After the harness exists (§3), and after Option 3a gives `paint()` its `pass` discriminator:

> 10 fixture plans × 3 control signals (`line`, `depth`, `seg`) × 4 `control_scale` values {0.5, 0.65, 0.8, 1.0} × 2 seeds = **240 images** on `fal-ai/z-image/turbo/controlnet` with `preprocess: 'none'`, at $0.0065/MP = **≈ $1.56**. Plus 80 baseline FLUX.2 [max] renders at $0.07 = $5.60. **Total under $8 and one day of wall-clock.**

That produces a scored surface over (signal × strength) and tells us three things at once: whether control works at all, which map to emit, and roughly where the strength knob sits. If line control at 0.8 holds walls to >0.9 `room_iou` on a 6B turbo model, Option 3 is a clear go and we then pick the production model on photorealism alone. If nothing holds, we go straight to Option 8 and stop shopping for endpoints.

**Other open items, in rough order of how much money they can waste:**

1. **Licence on FLUX.1-dev-derived ControlNets used through fal.** fal states commercial use is permitted for the *hosted endpoint*, but Shakker's weights card is `flux-1-dev-non-commercial-license` and WaveSpeed says only "commercial usage rights depend on the model's license, set by its provider." **Get this in writing before shipping anything from Option 3's production half.** This risk does not exist for Option 5 (Qwen, Apache 2.0), which is the main argument for it.
2. **Price of `fal-ai/flux-general/differential-diffusion`.** Billing record reads compute-seconds, price 0, enterprise pending. One metered call answers it.
3. **Price of `fal-ai/qwen-image-edit-plus`** — $0.02 vs $0.03/MP, sources disagree. And whether a newer Qwen edit model (fal now lists Qwen-Image-3) supersedes 2509.
4. **`prompt_upsampling` default on `/v1/flux-2-flex`** — verified reads disagree (`false` vs `true`). Send it explicitly.
5. **Whether FLUX.2 uses a depth map at all when handed one as `input_image_2`.** Pure speculation. Option 2 resolves it in an afternoon for zero extra cost.
6. **BFL's klein `-finetuned` endpoints** — documented in the training guide, absent from `api.bfl.ai/openapi.json`. Probe live before planning Option 9 around BFL hosting; fal hosting is the verified fallback.
7. **Whether the diffusion pass is still needed for the top-down view** once an orthographic massing render exists (Option 8). Unanswerable until 8 is built, but it is the question that could make this whole problem much smaller.

---

## 6. What I would actually do

**Week 1** — Option 0 (harness: OCR metric, room IoU by rank, count error, tilt residual) and Option 1 (kill baked labels, gut `placeOf`, front-load and shorten the prompt, pin seeds). Nothing costs money. Commit a baseline scorecard.

**Week 1, one afternoon** — Option 2, because it is free and it might partially work.

**Week 2** — Option 3a: `pass` discriminator in `paint()`, `z` on 120 catalogue rows. Then run the $8 experiment.

**Week 3** — Whatever the experiment says. Most likely: production A/B of Option 3b vs Option 5 vs current, scored on the harness, with a human looking at photorealism.

**Starting now, forever, costing nothing** — log every accepted (conditioning PNG, render) pair, so Option 9 has a dataset when we want it.

**Not now** — Option 8 until the top-down case is settled, and Option 10 not at all.
---

## 7. 2026-09-03 sweep — models moved; the architecture did not

A second research pass (web, two agents, ~60 sources) six months after the document above.
Summary of what changed and what shipped from it. Claims tagged as before.

**The architecture above is now the industry pattern.** Veras — the category leader,
acquired by Chaos in Feb 2025 — conditions on depth + seg + edges extracted from the real
model with a strength slider **[verified]**, which is options 3/8 of this document. Our
advantage over every screenshot-upload tool is that our maps are ground truth from vector
geometry, not monocular estimates. SketchUp Diffusion reviews are consistently poor
("treats your model as a suggestion") **[verified]** — the SketchUp route stays rejected.

**The model landscape moved under the provider list:**

- **Gemini's image family ("Nano Banana") now leads the editing benchmarks that measure
  our exact requirement** — keep input geometry, retexture it. GEditBench v2 (Mar 2026)
  puts Gemini 3 Pro Image #1 overall and near-top on Visual Consistency; the live editing
  arenas put Gemini 3.1 Flash Image #1 **[verified, benchmark snapshots move]**. The
  archviz community converged on it for clay-render → photoreal. **Shipped:**
  `gemini-flash-image` (new default pick, ~$0.07-0.10/img, ten object-photo slots) and
  `gemini-pro-image` (quality tier, ~$0.15/img) via the Interactions API, synchronous,
  held-in-process like OpenAI.
- **GPT Image line measures WORST on structure preservation** of the frontier editors
  (GPT Image 1.5 Visual Consistency 846 vs Nano Banana Pro 1108; GPT Image 2 itself
  unmeasured — **[estimate]** by family) while being the dearest render we can ask for.
  Kept, demoted from any recommendation.
- **Qwen Image Edit 2511** replaces 2509/plus upstream: targets image drift directly,
  native depth/edge conditioning, same $0.03/MP on fal **[verified]**. **Shipped:**
  `qwen-edit` now points at `fal-ai/qwen-image-edit-2511`.
- FLUX 3 exists but only the video model is accessible; FLUX.2 [klein] is a speed play.
  Watch, don't move **[verified]**.

**Textured vs grey massing (the open question in option 8):** no controlled study exists,
but practitioner evidence is consistent that flat SEMANTIC colour coding beats bare grey
for adherence (PH's Archviz workflow feeds a per-polygon-coloured mesh; texturemap:
"the render's value is inversely proportional to how much the model had to invent")
**[estimate — practitioner consensus, unbenchmarked]**. **Shipped:** the eye-level ink
pass now renders flat placeholder colours — timber-family room floors, plaster walls,
muted per-group object hues sharing the seg map's hue — at the same per-class luminance
the grey massing was tuned to, so the AMBIENT/tone-separation work above still holds.
The camera brief now says what the colours are for. A/B against grey on the harness is
the natural next eval.

### The Interactions API, read off the wire rather than the docs

Everything in this subsection was probed against the live endpoint with a real key on
2026-09-03, after the first implementation shipped and failed every render. It is here
because the failure was entirely avoidable and the shape of the mistake generalises.

**The bug.** The adapter read the finished image from `output_image.data` — the field the
Google client libraries expose — and the REST answer has no such field. Every real render
came back HTTP 200 and was reported to the person waiting as *"Google answered the render
without any image data in it"*. The unit tests passed throughout, because the fixture had
been written from the same guess as the code: **a fixture invented from the same
assumption as the adapter cannot disagree with it**, so the whole test block was green and
worthless. The fixture is now a transcript of a real 200, trimmed only in the length of
its base64.

**What actually comes back** (`src/server/providers/gemini.ts` carries the full transcript):

```
{ id, object: 'interaction', status: 'completed', model, usage: {...},
  steps: [ { type: 'thought', signature: '<opaque, ~1.9 MB>' },
           { type: 'model_output',
             content: [ { type: 'image', mime_type: 'image/jpeg', data: <base64> } ] } ] }
```

The picture is a content part of a step, the model's thinking is a sibling step in front
of it, and the last image wins (a model that revises its own work emits the final frame
last). Text parts appear here too — that is how a safety stop arrives, as a 200 with prose
instead of a picture — so they are read and repeated back rather than flattened into
"no image".

**The menus are the endpoint's own refusal messages**, not doc-page transcriptions: send a
bad enum and it names every legal value. Aspect ratios are `1:1, 2:3, 3:2, 3:4, 4:3, 4:5,
5:4, 9:16, 16:9, 21:9, 1:8, 8:1, 1:4, 4:1`; sizes are `512, 1K, 2K, 4K`. JPEG is the only
output mime — `image/png` and `image/webp` are both refused by name, which is why this is
the one provider in the app whose output is not a PNG.

**Errors use `{ error: { message, code } }` with a STRING code** (`invalid_request`), which
is *not* the `{ code, message, status }` of Google's older APIs.

**Real metering, first bill.** A 1K frame reports 1120 output-image tokens — exactly what
the flat estimate in `src/data/providers.ts` assumed, so that arithmetic is now confirmed
rather than hoped. `receipt()` prices it from Google's own counts: $0.067 for the flash
model on the probe render, against a $0.11 pessimistic estimate. One line is deliberately
missing: `total_output_tokens` exceeds the image tokens by ~240 because the model also
emits text, and the pricing page quotes no text-output rate for an image model, so the
count is logged and left out of the total, which therefore reads as a floor.

**Why the held-in-process bridge stays**, despite the answer carrying a real interaction
`id`. Both halves were probed: `GET /v1beta/interactions/{id}` works and returns the
completed interaction with its image intact, but `background: true` — a real parameter of
this endpoint — is refused by these models by name ("does not support background
interactions"; `gemini-3-pro-image-preview` accepts it and answers immediately with
`status: 'in_progress'`). The id therefore only exists once the blocking POST has already
returned, which is the same moment the held entry is filled in, so nothing is recoverable
that was not already in hand. If Google ever lets these models take `background`, the
retrieval endpoint is waiting and this provider becomes genuinely asynchronous like BFL's.

**Collateral, found by the same pass:** the eval harness checked every cell against the
global `MAX_USD_PER_IMAGE` instead of `ceilingUsd(meta)`, so the three providers carrying
their own licence — GPT Image 2 and both Gemini models — could not be swept at all, and
its "a smaller size fits" hint offered a *larger* canvas on flat-priced providers. Both
fixed; a harness stricter than the thing it measures measures nothing.

**Not shipped, ranked next:** per-hero-object masked refinement (we have exact object
masks from the face buffer; reference-first beats text for product fidelity — a 4-model
test showed text descriptions always produce a *different* product **[verified]**);
a creative tiled upscale step for export quality (Magnific V2 / SUPIR class); multi-view
consistency (SpatialGen, MVRoom) is research-only — no production API **[verified]**.
