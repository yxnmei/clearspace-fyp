# Ground-truth labels for the evaluation image set

`labels.json` (once populated) is the committed ground truth for the
12–15 curated test images (§3 step 2). Actual image files are gitignored
(`data/test_images/`) — only this labels file, which references them by
filename, is committed. That's deliberate: the labels are small,
reviewable in a diff, and needed for CI-style reruns; the images
themselves are not something to ship in the repo.

## Clutter Image Rating (CIR) caveat — do not silently gloss over this

Frost et al.'s CIR only has **official anchor photos for Bedroom,
Kitchen, and Living Room**. Any image outside those three room types
(desk, wardrobe, storage corner, etc.) is **self-rated** on the same
1–9 scale by visual comparison to the nearest anchor set, not scored
against an official CIR anchor. Record which is which — see
`self_rated: true/false` in the schema below — and say so explicitly in
the dissertation. Do not let a self-rated desk photo get reported
alongside official CIR scores without that caveat; that's exactly the
kind of thing a reviewer catches.

## Schema (see labels.example.json)

```json
{
  "filename": "desk_01.jpg",
  "room_type": "home office desk",
  "cir_score": 6,
  "self_rated": true,
  "ground_truth_items": [
    {"label": "keyboard", "expected_decision": "keep"},
    {"label": "printer", "expected_decision": "sell"}
  ],
  "notes": "cluttered desk, moderate severity"
}
```

`ground_truth_items.expected_decision` is a judgement call made once, by
one person, at labelling time — it feeds the §8 "decision agreement"
metric, not a claim of objective correctness. Note who labelled it and
when in `notes` if more than one person ever contributes labels.

## Detector (Grounding DINO) evaluation — a separate contract, not this file

`labels.json` is LLM-decision ground truth (see above) — it is deliberately
**not** reused, modified, or extended for the Grounding DINO
actionable-clutter pilot (Phase C1/C2). Changing it would complicate
interpretation of every historical LLM-comparison result already scored
against it. Detector evaluation instead has its own file,
`detection_pilot.example.json` here (a fixture/template — see below), with
its own schema, parsed by `evaluation/metrics/detection_evaluation.py`.

**Why detector evaluation needs a different design than label+position
matching.** An earlier plan proposed matching a detected candidate to a
ground-truth object automatically, by label-text agreement (with
`position_zone` as a duplicate-label tie-breaker). That was rejected:
using the predicted label to decide *whether* an object was detected, and
then separately reporting *whether that label was correct*, is circular —
it cannot distinguish "detected with the wrong label" from "never detected
at all," which is exactly this project's most consequential real detector
failure (e.g. `bedroom02.jpg`'s missing clothing/bedding items). Detector
evaluation instead uses **explicit, human-adjudicated correspondence**:
every ground-truth instance and every detector candidate gets a stable ID,
and a separate `Adjudication` record states which instance (if any) a
candidate covers, with ambiguous cases recorded as ambiguous, never
guessed. See `evaluation/metrics/detection_evaluation.py`'s module
docstring for the full reasoning and the pure data structures
(`GroundTruthInstance`, `DetectorCandidate`, `Adjudication`) and metrics
(`compute_metrics`) this enables.

### `detection_pilot.example.json` schema

Ground-truth instances only — candidate/adjudication data comes from an
actual detector run reviewed by a person, not from a static file:

```json
{
  "schema_version": 1,
  "source_labels_json_git_blob": "<git hash-object backend/evaluation/labels/labels.json>",
  "images": [
    {
      "filename": "bedroom02.jpg",
      "ground_truth_instances": [
        {
          "instance_id": "bedroom02.jpg::gt0",
          "canonical_label": "necklace",
          "position_zone": "upper-left",
          "actionability": "actionable",
          "notes": "optional"
        }
      ]
    }
  ]
}
```

- `schema_version`: bump whenever the shape changes; loaders reject an
  unrecognised version rather than guessing.
- `source_labels_json_git_blob`: the exact `labels.json` content this
  annotation pass was done against (`git hash-object backend/evaluation/labels/labels.json`)
  — recorded because detector evaluation and LLM evaluation are separate
  efforts that can otherwise silently drift apart.
- `instance_id`: stable, unique, occurrence-aware (never derived from
  label text — two same-label instances always get different IDs).
- `actionability` — one of:
  - `actionable`: an individually reviewable object for which a
    Keep/Sell/Donate/Discard decision is meaningful in ClearSpace.
  - `contextual`: room structure, fixture, background, or other object
    that should not normally burden the Declutter review.
  - `uncertain`: insufficient evidence to defend either classification —
    excluded from the primary actionable denominator, reported
    separately, never guessed at.

This file (`detection_pilot.example.json`) is an **example/fixture only**,
matching the same convention as `labels.example.json` above — it is not
the real 5-image pilot annotation. Do not populate the real thing by
guessing; the real annotation pass is separately reviewed before any
inference runs against it.

### Label-quality categories (not exact-synonym matching)

Once a candidate is adjudicated `matched` to a ground-truth instance, a
*separate* judgement — `Adjudication.label_quality` — records how good its
label is. Broader categories are never treated as exact synonyms:

- `exact_or_equivalent` — e.g. `necklace` for a necklace.
- `usable_but_broad` — e.g. `jewelry` for a necklace.
- `wrong` — e.g. `cable` for hanging clothes.
- `fragmented_or_glued` — e.g. `box drawer` where two vocabulary terms got
  concatenated onto one detection.
- `not_assessed` — not yet judged.

`usable_but_broad`, `wrong`, and `fragmented_or_glued` all contribute to
user label-correction burden and must never inflate strict label
correctness — see `compute_metrics`'s docstring for the exact rates this
produces.

### One variant per `compute_metrics()` call

`compute_metrics()` (and `validate_detection_evaluation()`) reject a
non-empty `candidates` collection spanning more than one distinct
`DetectorCandidate.variant` — mixing Variant A and Variant B candidates in
one call would let them be counted as duplicates of each other, which they
are not. A comparison between variants always calls `compute_metrics()`
once per variant and compares the resulting metrics afterwards. Zero
candidates, and any number of images sharing one variant, both remain
valid.

### Candidate identity is variant-agnostic, but reuse across variants is not automatic

`candidate_id(filename, index)` does not encode `variant` — it is
`filename::cand{index}`, not `filename::{variant}::cand{index}`. This is a
naming-convention decision only. `DetectorCandidate.variant` remains
required metadata on every candidate regardless.

### Phase C2 (not implemented yet): phrase-boundary handling

A future evaluation variant must reproduce Grounding DINO's real
`remove_combined=True` behaviour — locate each detection's
highest-scoring token, find the surrounding caption `.`-separator
boundaries, and decode only threshold-passing tokens within that single
vocabulary segment. It must **not** invent an arbitrary string-splitting
heuristic on the already-decoded phrase text. Because phrase decoding
never changes a detection's box, a *future* inference runner MAY choose to
reuse the same `candidate_id` for Variant A and Variant B's corresponding
boxes on the same image — but **only after that runner has actually
verified, for that specific run, that both variants produced the same
candidate count with matching box coordinates in the same order**. Nothing
in Phase C1 performs or enforces that verification; this module does not
claim two variants' correspondence is already shared just because
`candidate_id` no longer includes a variant label. If a future runner
finds the boxes actually differ between variants for a given index,
correspondence must be adjudicated again for that image, independently —
never assumed reusable. Only `Adjudication.label_quality` is expected to
differ between variants once that verification holds. Not built in
Phase C1.

---

# Audio ground truth for the Voice V3 STT comparison

`audio_labels.json` (you create it; committed) is the ground truth for
the `whisper-base` vs `faster-whisper-base` comparison. The recordings
themselves live in `data/audio_clips/` and are **gitignored** — only
this labels file, which references them by bare filename, is committed.
Same discipline as the image set above, for the same reason.

`audio_labels.example.json` is a three-row **template**, not data. Copy
it, then replace every row.

## Record with a local recorder or a browser recording tool — NOT the ClearSpace UI

The app's Record control captures a Blob, uploads it, and discards it.
There is no "save recording" path in the UI, so a clip recorded there
cannot end up in `data/audio_clips/`. Use whatever desktop recorder or
browser recording page you like and save the file yourself.

This does not weaken the comparison: both backends receive the same
post-decode waveform, so the container and codec affect them equally.

Accepted `media_type` values are exactly
`app/core/audio_decode.py`'s `SUPPORTED_AUDIO_MEDIA_TYPES`:

`audio/webm` · `audio/ogg` · `audio/wav` · `audio/x-wav` · `audio/wave` ·
`audio/mpeg` · `audio/mp3` · `audio/mp4` · `audio/m4a` · `audio/x-m4a`

WAV (16-bit mono, 16 kHz) is the simplest choice and avoids a codec
step; `audio/webm` with Opus matches what a browser recording produces.
Either is fine, and a mix is fine.

## Schema

```json
{
  "schema_version": 1,
  "recorded_by": "self",
  "consent": "self_recorded",
  "clips": [
    {
      "clip_id": "clip_001",
      "filename": "clip_001.wav",
      "media_type": "audio/wav",
      "category": "context_typical",
      "reference_transcript": "i am downsizing before a move and i want to be decisive about what i keep",
      "wer_scored": true,
      "notes": ""
    }
  ]
}
```

Every field is required on every clip, and **unrecognised fields are
rejected** — the loader mirrors the API's own `extra="forbid"`
discipline, because an extra key means the file and the loader disagree
about the schema rather than that one of them should give way.

- `recorded_by` — must be exactly `"self"`.
- `consent` — must be exactly `"self_recorded"`.

  Both are **pinned to one value**, not validated as "some non-blank
  string". They are copied verbatim into the result artefact, and an
  open string field is exactly where a real name, a username or an email
  ends up. This is a self-recorded single-speaker pilot; if that ever
  changes, widening these is a deliberate code edit with a consent story
  attached, not something a label file can do on its own.

- `clip_id` — stable, unique. Identity is `clip_id`, never the
  transcript text.
- `filename` — a **bare filename**. A path, a directory component, `..`,
  or an absolute path is rejected: a committed labels file must not
  widen what the runner reads or leak a directory layout into the repo.
- `media_type` — the declared type. `check_container_matches_media_type()`
  cross-checks it against the real container during preflight, so a
  mislabelled clip fails loudly instead of quietly producing a result.
- `category` — free text; the suggested set is below.
- `reference_transcript` — what was actually said. Plain lowercase, no
  punctuation, numbers spelled as words ("twenty nineteen").
- `wer_scored` — `false` only for silence clips. A `true` clip whose
  reference normalises to no words is **rejected at load**: WER is
  errors ÷ reference words, and there is no rate to report with a zero
  denominator. Dividing by `max(len, 1)` instead — which the previous
  harness did — silently returns the hypothesis word count and presents
  it as a rate.
- `notes` — may be empty, must be present.

Also rejected: an unknown `schema_version`, a duplicate `clip_id`, a
duplicate `filename` (two labels pointing at one recording would
double-count it in the corpus totals — compared **case-insensitively**,
since Windows treats `Clip_001.wav` and `clip_001.wav` as one file), an
unsupported `media_type`, and more than **30** clips.

A file that exists but cannot be read becomes a bounded preflight error
naming only the `clip_id` — never the path, because an `OSError`'s own
text quotes the full path it failed on.

## Suggested set — 12 clips minimum

| Count | `category` | Purpose | Length |
|---|---|---|---|
| 4 | `context_typical` | The real use case | 6–12 s |
| 2 | `proper_nouns` | Names and brands — the weak spot for `base` | 6–12 s |
| 2 | `long_form` | Multi-sentence, tests segmentation | 20–35 s |
| 2 | `short` | Clipped phrases | 2–4 s |
| 1 | `numeric` | "three boxes", "the 2019 receipts" | 5–10 s |
| 1 | `silence` | Room tone, no speech, `wer_scored: false` | 3–5 s |

Fewer than about ten clips lets one misrecognised word swing corpus WER
by several points.

Every clip must decode to **under 60 seconds** (matching
`stt_max_audio_seconds`). The runner refuses a longer one rather than
truncating it.

## Transcribe by hand, before any run

Write what was said, yourself. Do **not** paste a model's output and
correct it — that biases the ground truth toward whichever backend
produced it, which is precisely the thing being measured.

## Privacy

`reference_transcript` is committed and read in a diff. Say only what
you are willing to publish: no names, addresses, account numbers, or
anything you would not put in the dissertation. Writing the sentences
first and reading them aloud is the safest approach and also gives
cleaner ground truth, since there is no ambiguity about what was said.

Raw audio stays in gitignored `data/audio_clips/`; results stay in
gitignored `evaluation/results/`. The result artefact records bare
filenames only — never an absolute path, a home directory, a username,
or an environment value.
