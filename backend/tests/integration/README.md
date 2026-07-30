# Integration tests — Verification

**"Are we building the product right?"** Components combined, real models
loaded, no HTTP layer. Example (per §6): does Grounding DINO's output
actually feed correctly into the Mistral classification prompt — real
detector, real LLM call, checked at the Python-function boundary rather
than through `requests`.

These are slow (they load real models) and will stay empty until the
corresponding `app/models/*.py` implementations exist — see the §3 build
order (step 5 comes before these can be written honestly). Don't backfill
this directory with mocked-out versions just to have something here;
a green integration suite that never touched a real model is worse than
an honestly-empty directory, because it hides exactly the risk this test
type exists to catch.

Mark tests here with `@pytest.mark.integration` so `pytest -m "not integration"`
skips them for the fast unit-only loop, and CI (if added) can run them
separately with a longer budget.
