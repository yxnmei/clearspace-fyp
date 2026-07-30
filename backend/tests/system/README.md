# System tests — Validation

**"Are we building the right product?"** Black-box, through the actual
FastAPI app (e.g. `httpx.AsyncClient` against the real `app`) — POST an
image to `/upload`, assert on the real HTTP response. No knowledge of
internals; if it reads `app.services.declutter_service` directly, it's
an integration test, not this.

Per §5, any system test touching `/generate` (the Reorganise path) has a
**manual precondition that can never be automated the way Declutter-path
tests can**: the Colab notebook must be running and its ngrok tunnel live.
Document that requirement directly in each such test's docstring, and
mark it `@pytest.mark.requires_colab` so the rest of the suite can run
without a human going to start a notebook first.
