# ClearSpace

A human-in-the-loop multimodal AI system for intelligent decluttering and
spatial reorganisation. CM3070 Final Year Project, submitted under
**Brief 4.1: Orchestrating AI Models to Achieve a Goal**.

Photograph a cluttered space, optionally add voice/text context, and get
back per-item Keep/Sell/Donate/Discard decisions with reasons, marketplace
listing drafts for Sell items, and an AI-generated visual impression of
the space reorganised.

This is a from-scratch rebuild of an earlier prototype. Everything in
this repo is ordered to put evaluation and reproducibility first —
see `PROJECT_SPEC.md` for the full rationale and build order, and
`DEVLOG.md` for the running decision log.

## Repo layout

- `backend/` — FastAPI app, model wrappers, evaluation harness, tests
  (see `backend/app/`, `backend/evaluation/`, `backend/tests/`)
- `frontend/` — React + Vite + Tailwind client

## Status

Scaffold only, as of 2026-07-30 — directory structure, config, logging
infrastructure, thin API/service/model layering, and test/evaluation
skeletons are in place per the build order below. No model is wired up
yet; every `app/models/*.py` function currently raises `NotImplementedError`
until the model comparisons in step 4 are actually run.

## Build order (see DEVLOG.md for how this is actually progressing)

1. Reproducibility infrastructure — done (this scaffold)
2. Curate the 12–15 image test set (`backend/data/test_images/`, gitignored;
   ground truth in `backend/evaluation/labels/labels.json`, committed)
3. Batch-evaluation harness — scaffolded (`backend/evaluation/scripts/batch_eval.py`)
4. Run every §2 model comparison before committing to the architecture
5. Build the pipeline with the now-evidenced model choices
6. Backend, then frontend
7. Image generation, with fidelity scoring from day one
8. Continuous: dev log + small commits

## Local setup

```bash
# backend
cd backend
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
cp .env.example .env
# CLIP has no PyPI release — install separately:
pip install git+https://github.com/openai/CLIP.git
pytest                       # unit tests only run today; integration/system are skipped

# eval-only deps (faster-whisper, sklearn, etc.) — never a runtime dependency
pip install -r requirements-eval.txt

# frontend
cd frontend
npm install
npm run dev
npm test
```

Ollama must be running locally with the §2 comparison models pulled:
`mistral`, `qwen3:8b`, `gemma2:2b`, `phi4-mini`, `deepseek-r1:7b`.

Image generation depends on a separate Colab notebook + ngrok tunnel —
see `backend/app/models/image_gen_client.py` and PROJECT_SPEC.md §5.
Nothing that touches `/generate` will work without it running.
