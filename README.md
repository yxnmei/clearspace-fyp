# ClearSpace

<img src="frontend/src/assets/clearspace-logo.svg" alt="ClearSpace house-and-leaf logo" width="72" align="right">

ClearSpace is a human-in-the-loop multimodal AI system for decluttering and
reorganising indoor spaces from a room photograph. It helps users work through
decluttering step by step: review detected belongings, decide what to
**Keep / Sell / Donate / Discard**, and turn reviewed selections and confirmed
choices into practical organisation guidance or optional marketplace listing drafts.

Because household decisions depend on personal context as well as recognition,
ClearSpace coordinates specialised vision, language, speech, and image-generation
components rather than relying on one model. AI outputs are starting points,
not final decisions: users review detections, correct labels, exclude items,
override recommendations, and explicitly confirm decluttering choices before
they guide downstream outputs.

Developed for **CM3070 Computer Science Final Year Project, Brief 4.1:
Orchestrating AI Models to Achieve a Goal**, the project's main engineering
focus is the orchestration of specialised AI components within a modular,
reviewable workflow. It explores how these components can support a user-controlled
decision process while preserving consistent reviewed state across stages.

## ✨ Overview

Scene classification identifies the room type, while object detection supplies
reviewable items and boxes. Optional written context or an explicitly applied
voice transcript helps the system interpret the user's intentions. Decluttering
decision reasoning produces Keep / Sell / Donate / Discard recommendations and
supporting reasons; users can correct or override them.

Deterministic organisation planning produces the **Tidy Plan Checklist** and
**Storage Ideas** without a planning LLM call. Marketplace listing generation produces
editable drafts for confirmed Sell items. Optional image generation produces
the **AI Visual Preview**.

The three workflows share analysis but support different goals: **Declutter** helps
users decide what stays or goes, **Direct Reorganise** organises a reviewed selection
without removal decisions, and **Both** connects the two. Confirmed Sell items
determine listing eligibility; Both's confirmed Keep items determine what is
organised. Shared item identity and explicit review keep these stages connected
to the same belongings and user choices.

## 🧩 Key Contributions

- **Composed multimodal workflows.** Shared analysis and planning services
  coordinate specialised model wrappers; Both reuses Declutter review and
  confirmation rather than implementing a second decision pipeline.
- **Reviewable state transitions.** Label corrections, decision overrides,
  exclusions, and confirmation are explicit. Voice transcription produces a
  transcript that must be reviewed and applied before becoming user context.
- **Identity independent of labels.** Stable `item_id` values connect boxes,
  corrections, decisions, and drafts, including objects with duplicate labels.
- **Validated downstream eligibility.** The backend reconstructs confirmed
  choices to derive Keep and Sell sets instead of trusting client-supplied
  eligibility lists. Frontend response contracts also validate incoming data.
- **Asynchronous consistency.** Request-generation guards reject superseded
  responses. Per-item draft caching preserves existing Sell drafts and manual
  edits through decision changes and reconfirmation for the same photo.
- **Evaluation-informed planning and failure isolation.** The Tidy Plan Checklist
  and Storage Ideas use repeatable, item-grounded rules. Optional image generation
  is isolated so that these text-based outputs remain available when the AI
  Visual Preview cannot be generated. Evaluation findings explain the choice
  of deterministic planning over the retained generative alternatives.

The contribution lies in workflow composition and user control, rather than
training a new foundation model. Evaluation distinguishes software correctness,
model behaviour, real-model integration, and usability.

## 🔄 How ClearSpace Works

The workflow is chosen before upload; the branches below show its effect on
processing and review.

~~~mermaid
flowchart TD
    P["Room photo + optional reviewed context"] --> V["Scene classification + object detection"]
    V --> W{"Chosen workflow"}
    W -->|Declutter| D["Review Declutter Decisions"]
    D --> C["Confirm choices"]
    C --> S["Declutter Summary"]
    S --> L["Marketplace Listings for confirmed Sell items (optional)"]
    W -->|Direct Reorganise| I["Review labels and select items"]
    I --> T["Tidy Plan Checklist + Storage Ideas"]
    W -->|Both| B["Review Declutter Decisions and confirm"]
    B --> K["Organise confirmed Keep items"]
    K --> T
    B --> L
    T --> X["AI Visual Preview (optional)"]
~~~

## 🧭 Workflows

| Workflow | User control | Downstream input | Outputs |
|---|---|---|---|
| **Declutter** | Correct labels, override decisions, exclude items, and confirm | Confirmed, non-excluded Sell items for listings | Declutter Summary; optional Marketplace Listings |
| **Direct Reorganise** | Correct labels and select items; no removal decisions | Reviewed selection and label corrections | Tidy Plan Checklist, Storage Ideas, optional AI Visual Preview |
| **Both** | Confirm decisions; request organisation and listings independently | Confirmed Keep items for organisation; confirmed Sell items for listings | Tidy Plan Checklist, Storage Ideas, optional AI Visual Preview and Marketplace Listings |

In **Both**, the backend derives the non-excluded Keep and Sell sets separately.
The checklist also includes departure steps for confirmed Sell / Donate / Discard
items. Organisation and listing generation can run in either order.

In Declutter and Both, a label correction reruns that item's decision reasoning
and requires reconfirmation. In Direct Reorganise, corrected labels shape the
next checklist, storage suggestions, and image-generation prompt without
invoking the decluttering decision model.

Listing names and optional declared conditions are editable metadata. A listing
rename does not change a decision; Both's Tidy Plan Checklist still uses the
backend's reviewed label. Changed listing details mark an existing draft as
outdated but preserve its text until explicit regeneration.

## 🏗️ System Architecture

The React / Vite frontend owns interaction and temporary workflow state.
FastAPI parses requests and serialises responses; services compose workflow
operations independently of HTTP. Core schemas enforce identity and selection
invariants, while model wrappers isolate inference and remote-service calls.

Most inference runs locally. Image generation uses a separate FastAPI service
on a Colab GPU, reached through ngrok.

| Component / process | Implementation | Purpose and design rationale |
|---|---|---|
| scene classification | CLIP ViT-B/32 | Zero-shot room classification against templated descriptions; no room-specific training |
| object detection | Grounding DINO | Open-vocabulary household prompt produces reviewable boxes and labels |
| decluttering decision reasoning | Local Ollama LLM; default `phi4-mini` | Combines item evidence and context into recommendations and reasons |
| marketplace listing generation | Separately configured Ollama LLM; default `phi4-mini` | Writes editable drafts from reviewed labels and optional seller details |
| voice transcription | faster-whisper base; openai-whisper base supported | Produces an editable transcript; context changes only on explicit application |
| deterministic organisation planning | Room-sensitive, evidence-gated rules | Produces the Tidy Plan Checklist and Storage Ideas without a planning LLM call |
| image generation | Stable Diffusion v1.5 + depth ControlNet | Separate GPU service produces the optional AI Visual Preview without blocking text outputs on failure |

Model fit is not the same as proven superiority. Comparative findings and
historical alternatives are documented in the
[evaluation record](backend/evaluation/README.md).

## 💡 Key Design Decisions

| Problem | Decision | Rationale |
|---|---|---|
| Plausible output may misrepresent user intent | Review decisions and transcripts before use | Valid structure cannot establish personal preference |
| Labels can change or repeat | Preserve **stable item identity** through `item_id` | Corrections retain the same object, box, and associated draft |
| Client eligibility may be outdated | Enforce **server-derived eligibility** from confirmed choices | Listing metadata cannot make a Keep or excluded item eligible for sale |
| Valid LLM plans can still give poor advice | Use deterministic organisation planning | Repeatable, item-grounded rules replace unvalidated planning calls |
| The image-generation service may be unavailable | Preserve text outputs; mark the AI Visual Preview unavailable | Optional illustration cannot block the checklist or storage guidance |

Server-authoritative derivation here means validating and replaying submitted
analysis, decisions, and overrides—not an authenticated, persistent server
session. Image hashes correlate the photo with its analysis; they are not
cryptographic authentication.

## 📊 Evaluation & Results

Evaluation separates model-output quality, runtime integration, and usability.
The headline findings below are bounded by the recorded test conditions.

| Component | Method / scope | Headline finding |
|---|---|---|
| voice transcription | Two base backends; 12 single-speaker clips, 3 repetitions; 11 clips WER-scored | Both: **7.57% corpus WER**. Faster-whisper reduced cold-load and long-clip latency on the tested CPU |
| marketplace listing generation | 20 synthetic label-only cases; 4 prompt arms, 1 repetition, 1 blinded reviewer | **80/80 schema-valid**, but no arm passed the hard safety rule |
| Organisation planning alternatives | Planner screens; two single-call LLM checklist trials | Both checklists passed structural validation but failed human review; production planning is deterministic |
| AI Visual Preview | Live service/browser integration; bounded qualitative pilot | Runtime delivery worked; the pilot rejected output quality |
| Workflow composition | Opt-in real-model chain; documented HTTP/browser smoke tests; fake-backed API/UI tests | Integration and contract evidence, not general model accuracy |
| Usability | Recorded P1–P3 sessions; later build-specific results not fully consolidated | Feedback informed revisions; post-change improvement is not yet established |

The voice transcription comparison records Whisper as the default at that
time; current configuration uses faster-whisper. An intent-changing transcription
error reinforced review-before-apply. Historical listing results concern prompt
v1; the v2 seller-detail branch has not received an equivalent evaluation.

See the [dated evaluation record](backend/evaluation/README.md),
[real-model integration scope](backend/tests/integration/README.md), and
[AI Visual Preview evidence](colab_service/README.md) for methods, limits, and
provenance. No aggregate accuracy figure for scene classification, object
detection, or decluttering decision reasoning is asserted here without a
corresponding result. Successful image delivery does not establish a faithful layout.

## 🛠️ Tech Stack

- **Frontend:** React, Vite, Tailwind CSS.
- **Backend:** Python 3.11, FastAPI, Pydantic.
- **Vision:** CLIP, Grounding DINO, PyTorch.
- **Language:** Ollama for decluttering decision reasoning and marketplace listing
  generation.
- **Speech:** faster-whisper / openai-whisper; PyAV audio decoding.
- **Image generation:** Stable Diffusion v1.5, depth ControlNet, Colab, ngrok.
- **Verification:** pytest, FastAPI TestClient / httpx, Vitest, React Testing
  Library, and component-specific evaluation harnesses.

## 🚀 Getting Started

Use a Conda environment with Python 3.11, Node.js / npm, and local Ollama.
Before running real uploads, provision the vision checkpoints and configured
Ollama model; voice transcription also needs locally cached speech weights.
Weights, real environment files, and evaluation images are not committed.

### Backend

From the repository root, in Anaconda Prompt or a Conda-enabled Windows
Command Prompt:

~~~cmd
conda create -n clearspace-fyp python=3.11
conda activate clearspace-fyp
cd backend
python -m pip install -r requirements.txt
python -m pip install git+https://github.com/openai/CLIP.git
if not exist .env copy .env.example .env
~~~

Configure [backend/.env.example](backend/.env.example)'s model paths and local
services in your `.env`, start Ollama with the configured model available,
then run from `backend/`:

~~~cmd
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
~~~

### Frontend

In a second terminal, from the repository root:

~~~cmd
cd frontend
npm ci
npm run dev
~~~

Open http://localhost:5173. Interactive API documentation is available at
http://127.0.0.1:8000/docs; `GET /health` reports backend liveness, not model
readiness. The default CORS origin is `http://localhost:5173`.

### Optional AI Visual Preview

For the AI Visual Preview, follow the
[image-generation service setup](colab_service/README.md) and
[launcher notebook](colab_service/ClearSpace_Image_Gen.ipynb), then configure
`IMAGE_GEN_BASE_URL`. The Tidy Plan Checklist and Storage Ideas remain available
if that service cannot be reached.

<details>
<summary>Model provisioning and Windows environment notes</summary>

- Grounding DINO expects its config and checkpoint under `backend/weights/`
  by default. Relative configured paths resolve against `backend/`.
- Cache CLIP before an offline demonstration: its wrapper can fetch a missing
  checkpoint on initial loading.
- phi4-mini is the default for decluttering decision reasoning and marketplace
  listing generation; the full historical comparison set is not required to run
  the app.
- Provision configured Whisper base weights separately. Production
  voice transcription uses local files only; it does not download a model in
  response to an upload.
- Never commit real credentials or tunnel secrets.
- Check the active interpreter with
  `python -c "import sys; print(sys.executable)"`. It should belong to
  `clearspace-fyp`, not a separate system Python.
- If Command Prompt cannot find Conda, activate using the installation's
  full path, for example:
  `call "%USERPROFILE%\anaconda3\condabin\conda.bat" activate clearspace-fyp`.
- In VS Code, select that interpreter and open a new terminal. Selecting an
  interpreter does not activate an already-open terminal.
- In PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

</details>

## 📁 Repository Structure

~~~text
backend/
  app/
    api/          HTTP boundary
    services/     Workflow composition and eligibility
    core/         Schemas, identity, validation, deterministic organisation planning
    models/       Inference wrappers and remote image client
  evaluation/     Harnesses, fixtures, labels, and dated findings
  tests/          Unit, system, integration, and acceptance material
frontend/src/     API contracts, workflow hooks, and shared components
colab_service/    Independently deployed image-generation service and notebook
~~~

## ✅ Testing & Verification

Unit tests exercise core logic and model-boundary behaviour with fakes.
System tests use real FastAPI routes and services with expensive model
dependencies replaced. Frontend tests cover contracts, state transitions,
interactions, and stale-response handling.

Real-model integration is separate and opt-in. The acceptance directory
contains draft human-review questions, not a completed automated acceptance
suite; participant findings are recorded separately. Live Colab checks require
a manually started GPU service. Passing fake-backed tests does not establish
model-output quality.

With the project environment activated, backend tests additionally require
`pytest` and `httpx`; evaluation tools use `backend/requirements-eval.txt`.

~~~cmd
:: From backend/
python -m pytest -q

:: From frontend/
npm test
npm run build

:: From the repository root
python -m pytest colab_service/tests -q
git diff --check
~~~

Read the [integration prerequisites](backend/tests/integration/README.md)
before opting into real inference, and the
[system-test documentation](backend/tests/system/README.md) for API coverage.
Test totals are deliberately not hard-coded here: report them with the build
and command that produced them.

## ⚠️ Limitations & Responsible Use

- Object detection is not an exhaustive inventory. Users can correct labels and
  exclude detections, but cannot manually add undetected items.
- Declutter Decisions and Marketplace Listings require human review. Listing
  conditions are optional seller declarations, not visual assessments. Nothing
  is automatically disposed of or published, and no price is estimated.
- The Tidy Plan Checklist depends on reviewed evidence and may still be too
  general. Storage Ideas are methods, not verified placements or products.
- The AI Visual Preview is illustrative, not an item-preserving or geometrically
  verified layout. Image generation sends the original photo to the configured
  remote service.
- Drafts, names, decisions, and checklist progress are temporary browser state.
  Reloading or starting over loses that progress. Local reasoning and voice
  transcription do not imply that the entire system runs locally.

## 🔭 Future Work

Evidence-supported directions, not implementation commitments:

- Evaluate the v2 listing prompt with seller-provided details using
  an explicit unsupported-claim rubric.
- Consolidate later usability findings with the exact tested builds before
  drawing conclusions about the revisions.
- Investigate AI Visual Preview preservation through the bounded, masked-editing
  approach documented in the Colab record before attempting target-position planning.

## 📚 Documentation

- [Evaluation record](backend/evaluation/README.md): dated experiments,
  rejected alternatives, current evidence boundaries, and remaining work.
- [Image-generation service](colab_service/README.md): deployment, HTTP contract,
  troubleshooting, runtime evidence, and quality findings.
- [Integration tests](backend/tests/integration/README.md): real-model
  prerequisites, commands, and scope.
- [System tests](backend/tests/system/README.md): API vertical slices and
  documented manual end-to-end checks.
- [Acceptance material](backend/tests/acceptance/README.md): draft human-review
  questions, not the final usability-results record.
- [Evaluation labels](backend/evaluation/labels/README.md): annotation contracts
  and the separate detector-adjudication methodology.
