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
