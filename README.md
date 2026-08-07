# ClearSpace

A human-in-the-loop multimodal AI system for intelligent room decluttering
and spatial reorganisation. Developed as a CM3070 Final Year Project under
**Brief 4.1: Orchestrating AI Models to Achieve a Goal**.

## What it does

Decluttering is cognitively demanding — the bottleneck is rarely knowing
*how* to declutter, it's the sheer number of small keep/sell/donate/discard
decisions involved, and the decision fatigue that comes with making them
one item at a time. ClearSpace is designed around reducing that burden,
not around producing an exhaustive inventory of everything in a room.

Photograph a cluttered space, optionally add spoken or written context,
and receive:

- Per-item **Keep / Sell / Donate / Discard** decisions with reasons
- Marketplace listing drafts for items marked Sell
- An AI-generated visual impression of the space reorganised

Every AI decision is designed to be overridden — this is a human-in-the-loop
system, not an autonomous one. Three workflows are supported: **Declutter**,
**Reorganise**, and **Both** (declutter first, then reorganise using only
the items the user chose to keep).

## Architecture

ClearSpace orchestrates five pretrained models across three data domains
(image, text, audio) into one pipeline:

| Stage | Model | Domain |
|---|---|---|
| Object detection | Grounding DINO (open-vocabulary) | Image |
| Scene classification | CLIP (zero-shot) | Image |
| Decision reasoning | Local LLM via Ollama | Text |
| Voice context transcription | Whisper | Audio |
| Space visualisation | Stable Diffusion v1.5 + ControlNet (depth-guided) | Image |

Each model choice is backed by a documented comparison against alternatives
rather than picked by default — see **Evaluation & Methodology** below.

**Design principle: actionable clutter, not room inventory.** The detection
and reasoning stages are tuned to identify items a user would realistically
make a keep/sell/donate/discard decision about, not to maximise the count
of every object visible in a photo. Detecting more objects can look better
on a raw accuracy metric while actively working against the system's real
goal — surfacing a manageable set of real decisions instead of an
overwhelming one.

## Evaluation & methodology

Model selection is evidence-driven, not assumed:

- **LLM reasoning**: 5 candidate models (Mistral, Qwen3, Gemma2, Phi-4-mini,
  DeepSeek-R1) were compared on JSON-validity rate, ground-truth decision
  agreement, per-decision-class breakdown, output determinism across
  repeated runs, and latency. Agreement scores are evaluated against a
  majority-class baseline, since a model that simply defaults to the most
  common decision can otherwise look artificially accurate. The selected
  model is the one with no single severe failure mode, not the one with
  the highest headline number.
- **Object detection**: Grounding DINO's open-vocabulary detection was
  selected via a comparative object-count evaluation against YOLOv8, with
  its detection vocabulary iteratively refined against real labelling
  errors found through a purpose-built visual inspection tool.
- **Reproducible evaluation infrastructure**: structured JSON-lines run
  logging with per-stage timing, versioned prompts, and per-run output
  folders so evaluation results stay traceable and comparable over time
  rather than overwriting each other.

## Implementation status

| Component | Status |
|---|---|
| Object detection (Grounding DINO) | Implemented, evaluated |
| LLM reasoning (local, via Ollama) | Implemented, evaluated against 5 candidate models |
| Evaluation harness & reproducibility infrastructure | Implemented |
| Unit test suite (core logic) | Implemented |
| Scene classification (CLIP) | In progress |
| Speech-to-text (Whisper) | Planned |
| Image generation (Stable Diffusion + ControlNet) | Planned |
| REST API / end-to-end pipeline | In progress |
| Frontend | In progress |
| Integration / system / acceptance tests | Planned — deliberately deferred until the components under test exist |

## Repository structure

```
backend/
  app/
    api/         FastAPI routes — thin HTTP layer only
    services/     Pipeline orchestration (declutter, reorganise)
    models/      Pretrained model wrappers (one per pipeline stage)
    core/        Pure logic: label cleanup, JSON repair, box geometry
  evaluation/
    scripts/     Model comparison and evaluation scripts
    labels/      Ground-truth labels for the evaluation image set
    results/     Evaluation run outputs (generated, not committed)
  tests/
    unit/        Fast, no model loading
    integration/ Real models combined, no HTTP layer
    system/      Black-box, through the actual API
    acceptance/  Human-judged, against real requirements

frontend/
  src/
    api/         Backend client
    hooks/       Per-workflow state/data hooks
    components/  UI components
```

## Local setup

```bash
# backend
cd backend
conda create -n clearspace-fyp python=3.11
conda activate clearspace-fyp
pip install -r requirements.txt
cp .env.example .env
# CLIP has no PyPI release — install separately:
pip install git+https://github.com/openai/CLIP.git
pytest                       # unit test suite

# evaluation-only dependencies (faster-whisper, sklearn, etc.)
pip install -r requirements-eval.txt

# frontend
cd frontend
npm install
npm run dev
npm test
```

**Ollama** must be running locally with the LLM comparison set pulled:
`mistral`, `qwen3:8b`, `gemma2:2b`, `phi4-mini`, `deepseek-r1:7b`.

**Image generation** depends on a separate Colab notebook and ngrok
tunnel — see `backend/app/models/image_gen_client.py`. Endpoints touching
`/generate` require it running.

Currently runnable: the unit test suite and the evaluation scripts under
`backend/evaluation/scripts/` (model comparisons, detection visualisation).
The REST API and frontend are under active development.
