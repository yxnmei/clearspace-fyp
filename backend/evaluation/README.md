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

## 2026-09-06 — Marketplace listing draft harness: BUILT, NOT YET RUN

**No inference has been run.** This entry documents the harness itself,
not a result — there is no results table here because no candidate has
been evaluated yet. It exists so a future run (separately approved) has
somewhere to record its outcome without inventing the harness at the
same time.

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

**Prompt-first evaluation matrix (2026-09-07), model-free additions —
NO inference or human review has been run.** Two further evaluation-only
prompt builders are registered alongside `eval-a1`:

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

**Verified so far (fake-backed only):** 390 focused unit tests
(`tests/unit/test_compare_listing_drafts.py`) plus the full backend
suite green. No inference, no Ollama call, no network connection, no
download, no production setting change, and no human evaluation has
occurred. `app.config`'s `listing_llm_*` defaults (`phi4-mini`,
temperature 0.2, `max_attempts=3`) are untouched and remain provisional
pending a real run of this harness.
