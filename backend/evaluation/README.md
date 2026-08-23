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
