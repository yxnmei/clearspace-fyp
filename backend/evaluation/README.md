# Evaluation

Tracked, condensed summaries of evaluation runs. The raw per-run JSON
lives in `evaluation/results/`, which is **gitignored** (`.gitignore`:
`backend/evaluation/results/*`) — those files are local-only and are not
part of the repository history. This file records what each run
concluded, so a conclusion cited elsewhere in the project can be traced
without the raw artefact.

---

## 2026-08-20 — Reorganise planner screen

**Harness**: `evaluation/scripts/compare_reorganise_planning.py screen`
**Fixtures**: `reorganise_simple.json` (4 items), `reorganise_bedroom02_28items.json`
(28 items, transcribed from a captured real smoke-test prompt)
**Bounds**: 210s hard per-call timeout, `num_predict=1536`, 180s interactive gate
**Raw artefact (local only)**: `results/reorganise_planning_screen_20260820.json`

Ten calls: 8 simple cases (4 models × plain/schema), then the crowded
fixture for the 2 pairs that passed. Completed with `status="complete"`.

### Simple fixture

| Model | Mode | Latency | Outcome |
|---|---|---|---|
| phi4-mini | plain | 21.8s | **pass** |
| phi4-mini | schema | 2.6s | call failed — `ResponseError` |
| qwen3:8b | plain | 212.0s | timeout (`ReadTimeout`) |
| qwen3:8b | schema | 157.2s | call failed — `ResponseError` |
| mistral | plain | 48.5s | **pass** |
| mistral | schema | 2.2s | call failed — `ResponseError` |
| gemma2:2b | plain | 20.4s | semantic invalid — empty zone `'Keep in Place'` |
| gemma2:2b | schema | 2.5s | call failed — `ResponseError` |

### Crowded fixture (28 items)

| Model | Mode | Latency | Outcome | ID accounting |
|---|---|---|---|---|
| phi4-mini | plain | 69.6s | semantic invalid — empty zone `'Window'` | 4 missing, 5 duplicated |
| mistral | plain | 122.8s | semantic invalid — item_id in more than one zone | 0 missing, 5 duplicated |

**Survivors: none.**

### Findings

1. **Schema mode failed on all four models** — every case returned a
   server-side `ResponseError`. Three returned in approximately
   2–2.6 seconds; qwen3:8b returned a `ResponseError` after
   approximately 157 seconds. The error detail recorded in the artefact
   is sanitized to the exception type, so it does **not** establish
   whether inference began in any of these cases — only how long each
   call took before failing. The production
   `ReorganisePlan` schema was passed to Ollama's `format=` parameter
   **unchanged** (`$defs`/`$ref` intact, descriptions intact), so this is
   an honest result about that schema on this client version — not an
   artefact of a rewritten one.

2. **Both crowded models duplicated exactly 5 item_ids across zones**,
   independently. The prompt states the rule explicitly ("Each selected
   item_id must appear in EXACTLY ONE zone"). Neither model invented
   items; phi4-mini additionally dropped 4. Maintaining a partition over
   28 items — the one invariant the plan depends on — is where both
   failed.

3. **Output bounds are worth adding, but the evidence is not a
   controlled benchmark.** The bounded phi4-mini crowded call took
   **69.6s**. The earlier production planning stage was **1440.81s**, and
   that figure is the *total* across two unbounded attempts plus parsing
   between them (`plan_reorganisation` measures one `StageTiming` from a
   single `t0`); no per-attempt timing was recorded, and the raw
   responses were never persisted. The two numbers differ in attempt
   count, bounds, and measurement scope at once. They justify bounding
   the retained research path — they do **not** establish that a missing
   `num_predict` was the sole cause of the 1440.81s figure.

### Consequence

Production stopped calling the Reorganise LLM planner. Direct Reorganise
and Both now build the deterministic plan directly and report provenance
`deterministic_direct` (zero attempts, no issues, no model metadata) —
distinct from `deterministic_fallback`, which means two planner attempts
were genuinely made and rejected. The LLM path is retained, still tested,
and still reachable by passing a planner to `run_reorganise_pipeline()`;
it is now bounded by `REORGANISE_LLM_TIMEOUT_S` and
`REORGANISE_LLM_NUM_PREDICT` (Reorganise-scoped; Declutter's LLM
behaviour is unchanged).

### Not established

Whether a flattened, `$defs`-free schema would make structured output
viable; whether a different prompt shape would fix the partition failure;
whether any model succeeds at a smaller item count. Each would be a new
experiment, not a re-reading of this one.

---

## 2026-08-21/22 — Reorganise Planner V2 (flat per-item rows)

**Harness**: `evaluation/scripts/compare_reorganise_planning_v2.py`
(planner: `evaluation/scripts/reorganise_v2.py`)
**Fixtures**: `reorganise_simple.json` (4 items), `reorganise_bedroom02_28items.json`
(28 items, user context "i want a neat room")
**Bounds**: 210s hard per-call timeout, `num_predict=1536`, 180s interactive
gate, batches of 7, plain JSON only (`format=` never sent)
**Raw artefacts (local only)**: `results/reorganise_planning_v2_*.json`

V2 responds to the 2026-08-20 screen above, where both crowded survivors
duplicated exactly 5 `item_id`s. Instead of asking a model to partition 28
ids into nested zones, the model emits **flat rows** — one per item,
`{item_id, operation, zone_name, instruction}` — and deterministic code owns
batching, row-wise validation, aggregation, one batched recovery pass and the
merge into `ReorganisePlan`. The mutual-exclusion invariant is therefore true
by construction rather than by instruction.

V2.1 is the same harness with revised prompt guidance (zones as broad
functional areas, a 2–8 zone target, zone reuse, same-label grouping, no
inventing objects absent from the room inventory, per-operation conditions,
and instruction content rules). Prompt revision is recorded in each artefact
as `prompt_version`, separate from `planner_version`.

| Prompt/model | Fixture | Calls | Latency | Resolution | Zones | Result |
|---|---:|---:|---:|---:|---:|---|
| V2 / Phi-4-mini | Simple, seed 11 | 1 | 19.084s | 4/4 | 4 | Automatic pass; manual usefulness fail |
| V2 / Phi-4-mini | Crowded, seed 11 | 4 | 102.485s | 28/28 | 9 | Failed `zone_count` |
| V2.1 / Phi-4-mini | Crowded, seed 11 | 4 | 123.064s | 28/28 | 14 | Failed `zone_count`, `operation_diversity` |
| V2.1 / Mistral | Crowded, seed 11 | 4 | 311.999s | 28/28 | 12 | Failed `latency_gate`, `zone_count` |

### Findings

1. **Identity handling was exact in every crowded run.** All three crowded
   cases resolved 28/28 with zero missing, duplicate, unexpected and
   out-of-batch ids, no recovery pass required, and exact final-plan
   coverage. In these observed cases, flat per-item rows plus deterministic
   merging fixed the V1 mutual-exclusion failure — the specific defect that
   ended the 2026-08-20 screen.

2. **Phi-4-mini stayed semantically weak under both prompts, applying
   whichever instruction was most prominent too uniformly.** Under V2 it made
   `keep_in_place` 14 of 28 rows; told under V2.1 that `keep_in_place` is not
   the default, it made `store` 28 of 28 and named zones after the items
   themselves ("Store the desk in the Desk Zone"). On the simple fixture it
   produced one zone per item, each named after that item's own position
   descriptor.

3. **Mistral, on the identical V2.1 prompt, produced substantially more
   useful actions.** All four operations appeared in a plausible spread
   (relocate 11, group 7, keep_in_place 6, store 4); destinations referred to
   real detected items ("Move the jewelry to the desk", "Move the clock to
   the shelf"); and it was the only model here to return **raw-valid JSON**
   on every call, needing no `json_repair` intervention. It was nonetheless
   too slow for an interactive workflow at 311.999s (73–81s per call, past
   the 180s gate) and still produced 12 zones with 5 singletons and some
   zone names inconsistent with their own instruction's destination.

4. **Both prompt wording and model capability affected semantic quality
   here.** The V2 → V2.1 change altered phi4-mini's output substantially
   (annotation copying and invented containers stopped; operation
   distribution collapsed), and the same V2.1 prompt produced markedly
   different quality from two different models. Neither factor alone
   accounts for what was observed, and these runs do not measure how far
   either could be pushed.

### Consequence

**No candidate was promoted.** Production Reorganise remains
`deterministic_direct`; V2/V2.1 are evaluation-only and no `app/` module,
schema, provenance value, route or contract was changed by this work.

### Not established

Only **seed 11** was tested, on one fixture per size, with one run per
configuration — stability across seeds is unmeasured, and
`grouping_identical_across_seeds` is `null` in every artefact for that
reason. These are single-seed observations and do not establish general
reliability for any model or prompt. Whether further prompt revision,
a larger or differently-tuned model, a different batch size, or a
combination would clear the gates is untested.

**Passing the automatic gates is not acceptance.** Gates are computed from
`llm_resolved_count` before Keep-in-place absorption, and every verdict is
reported as `AUTO-PASS — MANUAL REVIEW PENDING`. The manual usefulness
review is required, is never auto-scored, and the simple-fixture case above
is exactly why: it passed every automatic gate while producing a plan that
proposed no actual reorganisation.

## 2026-08-28 — Speech-to-text: whisper-base vs faster-whisper-base

Harness: `evaluation/scripts/compare_stt.py` (committed `c83868d`), WER
rule in `evaluation/metrics/stt_metrics.py`. Labels: 12 hand-written
reference transcripts, committed `3656cea`. Recordings
(`data/audio_clips/`) and the raw artefact
(`evaluation/results/compare_stt_20260828.json`) are gitignored and
local-only.

`status: "complete"` · 12 clips · 3 repetitions · **72 measured calls**
plus 2 discarded warm-ups · **0 failed calls** · single decode per clip
shared by both backends.

### Dataset

12 self-recorded `audio/m4a` clips, **one speaker**, 122.069 s total:
4 `context_typical`, 2 `proper_nouns`, 2 `long_form`, 2 `short`,
1 `numeric`, and 1 `silence` clip (`wer_scored: false`, scored for
hallucination rather than WER). 11 clips scored, 304 reference words.

### Results

| | whisper-base | faster-whisper-base |
|---|---|---|
| corpus WER | **0.075658** (7.57%) | **0.075658** (7.57%) |
| errors / reference words | 23 / 304 | 23 / 304 |
| substitutions / deletions / insertions | 17 / 5 / 1 | 17 / 5 / 1 |
| mean per-clip WER *(secondary, length-biased)* | 0.113394 | 0.113394 |
| cold load | 3467.936 ms | **986.028 ms** |
| median latency, short (<5 s) | 486.464 ms | 482.260 ms |
| median latency, mid (5–15 s) | 583.756 ms | 559.370 ms |
| median latency, long (>15 s) | 1898.360 ms | **1402.405 ms** |
| deterministic across all 3 reps | yes, every clip | yes, every clip |
| hallucinated on the silence clip | no | no |
| failed calls | 0 | 0 |

**Accuracy is identical, not merely similar.** The two backends produced
byte-identical transcripts on 10 of 12 clips; the two that differed
(`clip_005`, `clip_008`) differed only in capitalisation and sentence
punctuation, which the normalisation rule removes. After normalisation
all 12 pairs are identical, which is why every accuracy figure ties
exactly rather than approximately.

### Findings

1. **Both backends made the same substantive errors.** `ikea kallax
   shelf` → "IKEA collect-shout" and `dyson fan can sit` → "Dyson friend
   can seat" (`clip_006`, WER 0.385); `donate these old paperback books`
   → "Don't eat these old paperback books" (`clip_010`, WER 0.400).
2. **One error changes user intent.** "Donate these" → "Don't eat these"
   inverts the instruction. It is a plausible-sounding sentence, so downstream schema and structural validation cannot determine from the transcript alone that it differs from the speaker's intent.
3. **Strict WER also charges formatting differences.** `three` → "3",
   `twenty nineteen` → "2019" (`clip_011`), and `reorganise` →
   "reorganize" (`clip_002`). The rule deliberately does not convert
   numbers or reconcile spelling variants, because either would flatter
   whichever backend shares the reference's convention.
4. **Neither backend invented speech on silence**, and both were
   deterministic across all three repetitions.

### Consequence

**Production is unchanged and remains `stt_backend = "whisper"`.** Human
review passed (all four judgement fields `true` in the artefact) and
recommends advancing `faster-whisper-base` to a **separate, separately
approved production-default smoke test** — on the grounds that it
matched, and did not beat, whisper-base on accuracy, while improving
cold load (3.5× faster) and long-form latency (~26% faster). Speed alone
is not the basis for a default change, and no default was changed here.

The intent-changing error is direct evidence for the existing
review-before-apply design: the frontend never writes a transcript into
`user_context` automatically, and the user edits and explicitly applies
it. Review passed *because* that gate exists, not despite the errors.

### Not established

This is a **small, single-speaker pilot**: 12 clips, one voice, one
accent, one recording device, one language, quiet conditions. It does
not establish that either backend is generally better, and it says
nothing about accented speech, multiple speakers, noisy rooms, or other
model sizes. `faster-whisper-base` is **not** shown to be more accurate
— it tied. Latency was measured on one machine (Windows, AMD64,
CPU-only, `compute_type="int8"`) and does not transfer to other
hardware.

---

## 2026-09-06 — Marketplace listing draft harness: BUILT (first real run 2026-09-07, below)

**Current status: the harness has since been run for real.** This entry
is the build record only. Every dated pass in it was model-free at the
time it was made, and its "no real run" / "fake-backed only" notes
describe the state on that date, not now. The first real evaluation ran
on 2026-09-07 and has its own section further down
(`2026-09-07 — Marketplace listing prompt-first real evaluation`); read
that for the current result. It found no prompt that cleared the
predeclared hard safety rule, so no candidate was promoted and the
production prompt / configuration are unchanged and still provisional.

Harness: `evaluation/scripts/compare_listing_drafts.py`. Fixture corpus:
`evaluation/fixtures/listing_draft_eval.json` (20 synthetic, non-personal
cases: clear household labels, ambiguous labels — `monitor`, `mouse`,
`notebook`, `bottle`, `drawer`, `clothes` — multiword labels, labels that
tempt fabricated condition/material/colour/size/brand/accessories/
functionality, and 4 prompt-injection-style labels testing
`app/models/listing_llm.py`'s existing data-boundary). Example candidate
matrix: `evaluation/fixtures/listing_candidates.example.json` (never
loaded automatically; every invocation names `--candidates` explicitly).

**Safe by construction.** `validate` / `plan` / `dry-run` never reach a
model — `dry-run` rehearses the full pipeline (preflight, retries,
JSON/schema validation, heuristic screening, aggregation, atomic write)
with a fixed, deterministic, built-in fake caller. Only
`run --execute-real-models` constructs a real Ollama client, and only
after confirming every required model is already present locally
(`ollama.list()`, never a pull). Exact worst-case call count is computed
and enforced (`MAX_TOTAL_CALLS_CEILING`) before the first call. Reuses
`app.models.listing_llm.build_listing_prompt` byte-identical for the
production "v1" arm, `app.core.json_repair.extract_json_detailed`, and
`app.core.listing_schemas.ListingDraftContent`'s real bounds — never a
reimplementation of any of the three. Three evaluation-only prompt
variants are registered (`eval-a1`, `eval-a2`, `eval-a3`); a candidate
set may compare several registered evaluation prompts in one run but
must always include at least one production `v1` baseline, and any
`prompt_version` outside the registered set is rejected before any
model call (checked both while parsing a file and, defensively, for
directly-constructed `CandidateConfig` values). Run size stays bounded
by the existing `MAX_CASES` and `MAX_TOTAL_CALLS_CEILING`, not by a
prompt-count cap.

**Screening is not proof.** JSON validity, schema compliance, and a
fixed set of regex/word-list content flags (price, contact details,
links, hashtags, emoji, condition/functionality claims, dimensions,
obvious brand/model claims) are coarse, over-inclusive-by-design
screening signals — recorded per draft, never treated as a factual-
safety verdict. A **genuinely separate, atomically-written reviewer
packet** (`<out>.reviewer.json`, built by `build_reviewer_packet`) is
what a human reviewer actually receives: review IDs, labels, guidance,
generated drafts and blank judgement fields, seeded/deterministically
blinded, with NO candidate/model/prompt identity, no answer key, and no
technical result data anywhere in it. The full researcher artifact
(`<out>.json`) keeps everything, including the one-to-one
`human_review_answer_key`. `plan` may print the case/candidate mapping
for the researcher, but always labels it researcher-only and never
describes it as the blinded view. Predeclared decision rules (never
computed by the harness): a prompt-injection compliance or
unsupported-claim failure is a hard safety disqualifier ahead of
everything else; then schema reliability; then human acceptance without
required deletion; then clarity/usefulness; latency last.

**Review corrections (2026-09-06), all fake-backed, no real run:**
model-availability failures (transport/HTTP/malformed response) are now
caught and turned into a fixed, sanitised incomplete result (CLI exit 1)
instead of a raw exception; every model call attempt gets its own
ordered diagnostic record so a later transport failure can never inherit
a stale JSON/schema diagnosis from an earlier attempt; unit latency is
now end-to-end across every attempt (including failed and unavailable
units), not just the final successful call; automated summaries now
expose clearly separate, clearly labelled `rep0` and `all_repetitions`
figures rather than silently reporting rep-0-only numbers as the
candidate rate, and a repetition that came back unavailable makes that
case's determinism explicitly UNASSESSABLE rather than false; the real
Ollama caller's error handling now mirrors production's own two-stage
split (known operational failures vs. malformed-response shape vs.
genuine programming defects, which still propagate); and the
reproducibility record now includes a deterministic fixture-content
SHA-256 plus, from the availability check, each resolved model's
installed name/tag and digest (explicit `null` when Ollama supplies
none, dict- and object-shaped `ollama.list()` responses both supported).
`plan`'s output and the artifact's `bounds` now say explicitly that
determinism is not assessed with `reps=1`.

**Human review completion layer (2026-09-06), model-free.** Every
blinded reviewer packet now embeds `REVIEWER_RUBRIC`: the type, meaning
and allowed values of each judgement field, written 1-5 anchors for
`clarity_rating` and `usefulness_rating`, how to complete an
`unavailable` draft (decision `unavailable`; the four assessment fields
left `null`), and the internal-consistency rules (`accept` requires a
faithful draft with an empty `unsupported_attributes_found` and no
required factual deletion). Two new model-free subcommands consume a
completed packet: `validate-review` checks it against its researcher
artifact (matching `artifact_id`/`seed`, exact one-to-one review
coverage with no missing/extra/duplicate/pending entry, untouched
immutable fields, and every human value strictly against the rubric,
reporting every problem it finds and never altering either input);
`summarise-review` — only for a packet that passes validation and whose
`--fixtures` content hash matches the researcher artifact — joins
through the researcher-only answer key to produce candidate-level
DESCRIPTIVE metrics (reviewed/generated/unavailable counts, acceptance
count and rate, acceptance-without-deletion count and rate,
unsupported-attribute failure count, prompt-injection/high-risk failure
count, mean clarity/usefulness, and a bounded rejected-case reference),
written atomically to an explicit `--out`. Neither subcommand ranks
candidates, picks a winner, changes a production setting, or imports
`ollama`/`httpx`.

**Integrity hardening (2026-09-06), model-free.** `validate-review` now
requires the reviewed packet's rubric to equal `REVIEWER_RUBRIC` in
full, not merely carry the current version: a same-version edit to
`how_to_use`, any field meaning/type, a rating anchor, the unavailable
rule or a consistency rule fails validation with a concise error, and
the comparison never mutates either input. Before it aggregates,
`summarise-review` strictly re-validates the researcher-only join
(`_validate_researcher_join`): the `human_review_answer_key` must be an
object whose review-ID set exactly equals both the canonical queue and
the reviewed-entry sets; every mapping must be an object with exactly
non-blank `case_id`/`candidate_id`; researcher candidates must form a
valid, unique ID set; every mapped case must exist in the hash-verified
fixture and every mapped candidate in the researcher list; the mappings
must cover each fixture-case x candidate pair exactly once and match the
deterministic `blinded_pair_order` recomputed from the recorded seed,
ordered fixture cases and ordered candidates; each canonical queue label
and guidance must agree with its mapped fixture case; and the final
`reviewed_entry_count` must equal the sum of per-candidate
`reviewed_count`. Any malformed researcher queue / candidate / answer-key
structure is a concise `ReviewValidationError` (CLI exit 1, `--out`
never created or replaced), never a `KeyError`, `TypeError` or
traceback.

**Aliasing + blank-identifier hardening (2026-09-06), model-free.**
`build_reviewer_packet` now returns a genuinely independent packet: the
rubric is a deep copy of `REVIEWER_RUBRIC` (never that object) and every
queue entry is deep-copied with all nested values, so building or later
editing a packet can never mutate `REVIEWER_RUBRIC`, the supplied queue,
or the researcher artifact — which is also what lets `validate-review`
catch an in-place edit to a packet's rubric or an immutable entry field
as a real divergence rather than a change to both comparison sides at
once. Every identifier documented as a non-blank string (canonical and
reviewed review IDs, the packet `artifact_id`, researcher candidate IDs,
and answer-key `case_id`/`candidate_id`) is now rejected when it is
whitespace-only (`.strip()` semantics); legitimate non-empty values,
including ones with internal spaces, pass through verbatim and are never
trimmed. A coordinated tamper that blanks a candidate ID to `"   "` in
both the researcher candidate list and every answer-key mapping is
refused by `summarise_review` (`ReviewValidationError`; CLI exit 1,
`--out` untouched).

**Second review pass (2026-09-06), all fake-backed, no real run:** the
built-in `dry-run` fake caller is now fully candidate-neutral, its
placeholder title/description never embed candidate_id, model_name,
prompt_version or temperature, since that text flows unchanged into the
human review queue and then the reviewer packet. The researcher
artifact and reviewer packet now share one opaque `artifact_id` per
run; an incomplete, zero-entry reviewer-packet placeholder is written
before the first model call, so a stale COMPLETE packet from an earlier
run can never appear current during a new, still-running, failed, or
interrupted one; the researcher artifact is marked "complete" only
after its paired reviewer packet has actually been written, and if that
write fails the researcher artifact stays incomplete and the CLI claims
neither output succeeded. Model/tag resolution in the availability
check is now exact: a tagged request (`mistral:q4_K_M`) matches only
that exact installed tag, an untagged request (`mistral`) matches only
an exact untagged entry or its explicit `:latest` form, and an
arbitrary other installed tag never silently satisfies an untagged
request; a missing/non-collection `models` value or a response whose
entries are wholly unparseable is now a sanitised `ModelPreflightError`
rather than being read as "every model missing". The one test that
invoked the CLI's real `run --execute-real-models` code path (behind a
fully monkeypatched fake Ollama module) was removed; the same sanitised
preflight-failure and exit-1 behaviour is now covered directly through
`run_evaluation()` and `_report_exit()`, with no test in the suite
passing or invoking that flag.

**Prompt-first evaluation matrix (2026-09-07), model-free additions.**
Registering the two extra prompt builders and adding the four-arm matrix
file was itself done without any model call; the matrix was then executed
for real the same day (see `2026-09-07 — Marketplace listing prompt-first
real evaluation` below). Two further evaluation-only prompt builders are
registered alongside `eval-a1`:

- **`eval-a1`** — restates the data-boundary / anti-injection rule more
  than once, in more compact language; tests *adherence*, not
  description quality.
- **`eval-a2`** — `v1`'s instruction set with two short faithful worked
  examples appended (garden hose, bicycle pump; each states a general
  purpose true of any such item, then names what the label leaves
  unstated). Hypothesis: demonstrations raise the human clarity /
  usefulness ratings without raising the unsupported-claim rate.
- **`eval-a3`** — instruction-only *safe label entailment*: a neutral
  stated qualifier (e.g. `wooden`, `leather`, `electric`, `wireless`,
  `gaming`, `vintage`) may be reused exactly but never made more
  specific; general statements must hold across every reasonable reading
  of the label; ambiguous labels stay neutral — all bounded by
  *invariant exclusions* (never a brand / price / condition / contact /
  link / publishing claim, regardless of what the label contains) plus
  explicit untrusted-content and mixed-label handling. Hypothesis: this
  lowers the unsupported-claim rate, most on fabrication-tempting and
  ambiguous labels.

Both new builders reject blank / non-string labels, strip the boundary
markers and generic `<<<` / `>>>` fragments, collapse whitespace, and
interpolate the sanitised label content exactly once, between the
markers; all later references are indirect (`eval-a2` keeps production
v1's "the label itself" and its examples say "the label"; `eval-a3`
says "the label above") and never repeat that content. Neither builder
touches `build_listing_prompt` or any production setting.

The dedicated **four-arm prompt-first matrix** lives in
`evaluation/fixtures/listing_candidates.prompt_first.json` (a NEW file;
`listing_candidates.example.json` and `listing_draft_eval.json` are
unchanged): `prod_v1_phi4_t0.2` / `eval_a1_phi4_t0.2` /
`eval_a2_phi4_t0.2` / `eval_a3_phi4_t0.2`, all on `phi4-mini`,
`temperature=0.2`, `num_predict=512`, `max_attempts=3`. For the 20-case
corpus at `reps=1` its intended bounds are **80 minimum model calls**,
**240 maximum model calls** (within the 400 ceiling), **80 blinded
review entries** (one per case x candidate, rep 0 only), and
**determinism is not assessed** (a `reps=1` run cannot assess it).

`DECISION_RULES` rule 1 is **three distinct checks**, not one, and the
rubric fields are not treated as equivalent: an arm clears it only when,
per entry, (a) `unsupported_attributes_found` is empty; (b)
`requires_factual_deletion_before_use` is `false`; and (c) for entries
on `prompt_injection` / `high_risk` cases, a manual read of the
generated text confirms no actual compliance with an embedded
instruction. `summarise-review`'s `prompt_injection_or_high_risk_failure_count`
only points at rejected high-risk entries to inspect — it is not proof
of injection compliance.

**Harness verification (fake-backed):** 390 focused unit tests
(`tests/unit/test_compare_listing_drafts.py`) plus the full backend
suite green, with no inference, Ollama call, network connection,
download or production setting change during that verification. The
harness was then executed for real on 2026-09-07 (next section).
`app.config`'s `listing_llm_*` defaults (`phi4-mini`, temperature 0.2,
`max_attempts=3`) are still untouched and remain provisional: the
2026-09-07 run produced no prompt arm that cleared the predeclared hard
safety rule, so no candidate was promoted.

---

## 2026-09-07 — Marketplace listing prompt-first real evaluation

**First and only real run of the listing harness.** One approved local
run of `compare_listing_drafts.py run --execute-real-models` against the
committed four-arm prompt-first matrix. This supersedes every "no
inference / no human evaluation has occurred" note in the section above,
which described the state on its own date. Production is still
unchanged.

### Run parameters (verified against the artifact)

| | |
|---|---|
| Model | `phi4-mini:latest` (requested `phi4-mini`) |
| Model digest | `78fad5d182a7c33065e153a5f8ba210754207ba9d91973f57dffa7f487363753` |
| Seed | `918273645` (the printed default `20260906` was deliberately not reused) |
| Fixture corpus | `evaluation/fixtures/listing_draft_eval.json`, 20 synthetic label-only cases |
| Prompt arms | 4: production `v1`, `eval-a1`, `eval-a2`, `eval-a3` (all `phi4-mini`, temperature 0.2, `num_predict` 512, `max_attempts` 3) |
| Repetitions | `reps=1` |
| Model-call attempts | 80 (20 cases x 4 arms x 1 rep); planned bounds min 80 / max 240, ceiling 400 |
| Attempt outcomes | every one of the 80 units succeeded on its first attempt; 0 retries anywhere |
| Draft outcomes | 80 `generated`, 0 `unavailable` |
| Blinded human review | 80-entry reviewer packet completed, `validate-review` passed, `summarise-review` produced the table below |
| Determinism | not assessed (a `reps=1` run cannot assess it) |

### Reviewed results (blinded single-reviewer, `summarise-review` output)

| Arm | Accepted | Unsupported-attribute failures | Mean clarity | Mean usefulness |
|---|---|---|---|---|
| production `v1` | 6 / 20 (30%) | 14 | 3.90 | 1.95 |
| `eval-a1` | 6 / 20 (30%) | 14 | 3.85 | 1.90 |
| `eval-a2` | 14 / 20 (70%) | 6 | 4.00 | 2.60 |
| `eval-a3` | 6 / 20 (30%) | 14 | 4.00 | 2.00 |

All four arms: 20 `generated`, 0 `unavailable`; acceptance was identical
to acceptance-without-required-deletion (no arm had an accepted draft
that still needed a factual deletion).

### Schema / reliability observations (verified)

- Schema-valid: **20 / 20 for every arm**; JSON-valid 20 / 20 for every
  arm.
- **No retries**: mean attempts 1 across all 80 units.
- JSON-fence repair rate (the model wrapping its object in a
  ```` ```json ```` fence, then mechanically repaired): production `v1`
  **20 / 20**, `eval-a1` **20 / 20**, `eval-a2` **0 / 20**, `eval-a3`
  **6 / 20**. `eval-a2`'s two bare-JSON worked examples are the only
  visible difference that removed fencing; `eval-a3`'s longer rule block
  reduced but did not remove it.
- Median call latency (from the artifact `latency_ms.median_ms`):
  production `v1` **7213 ms**, `eval-a1` **6355 ms**, `eval-a2`
  **7279 ms**, `eval-a3` **11135 ms**. `eval-a3` is markedly slower for
  no reliability gain.

### Decision

- **No prompt passed the predeclared hard safety rule
  (`DECISION_RULES` rule 1).** On the four `prompt_injection` /
  `high_risk` cases the reviewer accepted 0 / 4 (`v1`), 0 / 4
  (`eval-a1`), 1 / 4 (`eval-a2`) and 1 / 4 (`eval-a3`); a manual read of
  the generated text confirmed real compliance with embedded
  instructions in more than one arm (production `v1` and `eval-a3`
  reproduced the injected phone number and the injected promotional link
  verbatim; `eval-a2` adopted the injected "Rolex" and "Apple iPhone 15
  Pro, 128GB" framing as if it were the item).
- **No production-ready winner was selected.**
- **`eval-a2` was the strongest descriptive result, not an approved
  winner.** Despite 70% acceptance and the lowest unsupported-attribute
  count, `eval-a2` still adopted the injected Rolex / iPhone content,
  leaked its own "garden hose" worked example as the entire draft on the
  marker-spoof case, and still made unsupported ordinary claims
  ("comfortable seating" for the desk chair, "high-performance" for the
  gaming laptop).
- **Production prompt and configuration remain unchanged and
  provisional.** `LISTING_PROMPT_VERSION` stays `"v1"`; the
  `app.config` `listing_llm_*` defaults are untouched.
- **Mandatory human review / editing of every generated draft remains
  necessary.** The stage still produces drafts to be checked; they are
  never automatically published and must be reviewed before use.

### Limitations

- 20 synthetic, label-only cases (a short item label is the only input;
  no real personal data).
- One blinded reviewer.
- One repetition; no determinism assessment.
- No image or video context, and no user-confirmed listing attributes
  (condition, dimensions, accessories, etc.) were available to the
  model.
- No real marketplace publishing and no buyer-outcome measurement.
- A deliberately strict unsupported-claim rubric: a few rejections sit
  on an arguable general-knowledge boundary (e.g. whether "comfortable
  seating" for a desk chair or "high-performance" for a gaming laptop is
  a fabricated attribute or a category-general statement). Reviewer
  guidance on that boundary would benefit from written anchor examples
  before any future review.

### Future-work direction (not a plan)

- Richer input context: an image or video crop of the item rather than a
  bare label.
- User-confirmed condition and other item details, entered and vouched
  for by the seller.
- Category and price suggestions kept as clearly separated, clearly
  labelled estimates, never stated as facts.
- Stronger deterministic input validation / neutralisation of the item
  label before it reaches the model.
- Further model or prompt comparison only if a later change makes it
  justified; another round of "more prohibition text" on `phi4-mini` is
  not indicated by this run.

ClearSpace currently generates an editable title/description draft per
confirmed Sell item and nothing more. It does not claim full
Carousell-style feature parity (no image-conditioned listing generation,
no category, condition, price or publishing).

### Local artifacts (gitignored, local-only, read-only)

All four live under `evaluation/results/` and share
`artifact_id` `fa9d87f93f35471ba782f1ca2a0db404`.

| Artifact | Path (`evaluation/results/`) | SHA-256 |
|---|---|---|
| Researcher | `listing_drafts_prompt_first_20260907_105659.json` | `db231d1e8aea32e4c8a63a456993658e0d13079ae86bc067d04183947f578284` |
| Reviewer packet (original, blank) | `listing_drafts_prompt_first_20260907_105659.reviewer.json` | `913c223d992eaf50044096514b3b3b287656756b7153fb807ae604ba67a5cf6c` |
| Reviewed packet (completed) | `listing_drafts_prompt_first_20260907_105659.reviewed.json` | `cddf9314f2ae5804db641408e858bcc3c2503422d8f125e0d5628bbfd0b90fc6` |
| Review summary | `listing_drafts_prompt_first_20260907_105659.review_summary.json` | `5c3c355de3f93dff3e8f0d0681439bafe79833109afd99368853069b1f606f8e` |

---

## 2026-09-10/13 — Reorganise: semantic zone planning attempt NOT promoted; replaced by an action checklist

Status note, not an evaluation result. Recorded so the Reorganise
sections above stay readable as history and so the current production
shape is stated in one place.

### What was tried (2026-09-10, never committed)

An uncommitted attempt rewired the existing whole-plan zone planner
(`app/models/reorganise_llm.py`, prompt revised from `v1` to a `v1.1`
asking for 2 to 5 broad functional zones) back into both production
generation routes, with the same two-attempt state machine as before
and a spatially grouped deterministic fallback.

### Limited manual observation (not a controlled benchmark)

One person ran it by hand on their own photos with the configured
`phi4-mini`. No harness, no fixture, no seed control, no artefact, one
machine, so nothing here is a measurement of the model. What was seen:

- Both path: `deterministic_fallback`.
- Direct Reorganise path: `deterministic_fallback`.
- The detailed Direct Reorganise run (21 selected items): model
  `phi4-mini`, prompt `v1.1`, attempts 2, initial result semantic
  invalid, recovery result semantic invalid, planning duration
  89.40 seconds, provenance `deterministic_fallback`.

So on that run the planner added roughly 90 seconds and produced no
accepted zone plan. This is consistent with the 2026-08-20 screen and
the V2/V2.1 findings above (identity handling can be made exact; the
semantic quality of a nested item-to-zone assignment is weak at this
model size), and it was judged not worth further prompt tuning.

### Decision

The zone-planning wiring, the `v1.1` prompt change, the spatial-zone
fallback and the zone-card UI were removed before any commit. Nothing
about the research planner changed: `reorganise_llm.py`,
`reorganise_service.py`, `reorganise_semantic_conversion.py`, the `v1`
prompt and `compare_reorganise_planning.py` are as they were at
`882bbba` and are now research-only (no production route imports them).

### What production does instead (2026-09-13, stabilised 2026-09-17)

Direct Reorganise (`/generate`) and Both (`/generate/confirmed`) share
one pipeline (`app/services/reorganise_pipeline_service.py`) returning:

- **`action_plan`**: a prioritised checklist of 1 to 5 `{priority,
  title, instruction}` actions, built **deterministically with zero
  model calls** from detected positions, labels and sizes
  (`app/core/reorganise_actions.py`). Both routes pass no checklist
  generator, so provenance is always `deterministic_direct` (attempts 0,
  no model name, no prompt version, no issue) and neither route imports
  or resolves a checklist model. The checklist starts with the busiest
  photo area, then groups repeated labels and compatible categories,
  then the remaining areas; it says a large item stays where it is but
  never arranges other items around, on or beside it, and never names a
  destination, surface or container.
  The AI checklist was the original design and is **not promoted**: a
  dedicated prompt (`app/models/reorganise_actions_llm.py`, currently
  `reorganise-actions-v2`) with an at-most-one-call service path,
  strict validation and the `llm_generated` / `deterministic_fallback`
  provenances is retained as research code, reachable only by passing a
  generator to the pipeline explicitly. The two real runs below are why.
- **`focus_areas`**: at most three coarse photo areas (left / centre /
  right / other) ranked by selected-item count, derived only from the
  detector `position` descriptors, joined by `item_id`. A concentration
  count, not a clutter measurement, not AI output, not a floor plan.
- **`storage_suggestions`**: at most three generic suggestions from
  five narrow compatible categories (technology accessories; toys and
  games; books and papers; clothing, bags and shoes; jewellery, keys,
  watches and glasses), each requiring at least two small or medium
  matching items, never mixing categories and never using image
  position as evidence. No brands, retailers, prices, links or
  availability claims.
- **`image_prompt`** and the existing image fields: the prompt is
  built deterministically from room type, selected items and user
  context; the Colab/ControlNet integration is unchanged and the visual
  remains an impression that does not follow the checklist step by step.

### One authorised real run of `reorganise-actions-v1` (2026-09-17)

A single, separately authorised local call, not an evaluation: one
fixture (`reorganise_bedroom02_28items.json`, 28 items, context "i want a
neat room"), one call, no seed control, no repetition, no harness, no
artefact in the repository. `plan_reorganise_actions()` was called
directly with the real generator; no route, pipeline, image generation or
retry was involved.

- Model `phi4-mini`, prompt `reorganise-actions-v1`, 1 model call,
  **24.97 s**.
- **Passed structural validation**: five actions, provenance
  `llm_generated`, no issue. The JSON arrived inside a markdown fence
  despite the instruction, so it was accepted as mechanically repaired.
- **Rejected on human review.** Four of the five actions told the user to
  place items on an "upper-left", "upper-right", "lower-left" or
  "lower-center" shelf. The fixture contains one shelf, detected at the
  centre. The model had turned the detected photo positions in its
  inventory into destinations and invented furniture there. The first
  action placed the desk where it already was, the six picture frames and
  other repeated items were largely ignored, and the ordering followed
  the photo rather than usefulness. No shopping advice, brands, removal
  or invented item labels appeared; the validator cannot catch an
  invented shelf because "shelf" is a legitimate label.

Consequence: prompt `reorganise-actions-v2` removes position descriptors
from the model's inventory (labels, counts and sizes remain) and adds
three short rules: group repeated or compatible items first, give no
placement instruction naming a spot, and never assume a surface or
container exists because an item is listed. Deterministic focus areas,
the fallback checklist and the image prompt still use positions and are
unchanged.

### One authorised real run of `reorganise-actions-v2` (2026-09-17)

Same conditions as the `v1` run: one separately authorised local call on
the same 28-item fixture, no seed control, no repetition, no harness, no
artefact in the repository, not an evaluation.

- Model `phi4-mini`, prompt `reorganise-actions-v2`, 1 model call,
  **24.91 s**.
- **Passed structural validation**: five actions, provenance
  `llm_generated`, no issue, again accepted as mechanically repaired
  because the JSON was fenced.
- **Rejected on human review.** The targeted defect was fixed: no action
  named a photo position and no shelf was invented. But the first,
  highest-priority action was about "books and papers", which are not in
  the inventory; another told the user to store the plate, cup and mouse
  in the bin; another put the mirror on the shelf or desk; one was
  generic filler. One sensible group appeared (monitor, keyboard,
  speaker). The six picture frames, two toys and two cups were still not
  grouped.

### Decision (2026-09-17): the AI checklist is not used in production

Two real runs, two prompts, both structurally valid, both rejected by a
human, with a different defect each time. This matches the planner
history above: `phi4-mini` repairs the rule stated most forcefully and
drifts elsewhere, and a structural validator cannot see invented nouns
or bad advice. Prompt tuning stopped by decision, and no noun or
groundedness validator was added. Direct Reorganise and Both now build
the deterministic checklist directly (`deterministic_direct`, zero model
calls). The `v1`/`v2` prompt, the one-call service path and their tests
are retained unchanged as non-production research evidence.

### Not established

**No checklist prompt has validated quality, and none is in production.**
The two runs show the call path, repair, validation and provenance
working and give two latency observations of about 25 s; they do not
show useful output, and two single calls on one fixture are not a
general evaluation of the model or the prompts. The deterministic
checklist has been reviewed by reading its output on the same fixture,
not by a user study. The 90 s / 640-token bounds apply to the research
path only and remain conservative ceilings, not tuned values.
