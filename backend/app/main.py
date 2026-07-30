"""
FastAPI entrypoint. Deliberately thin — no model calls, no orchestration
logic here. HTTP concerns live in app/api/routes.py; everything routes
delegates to lives in app/services so the same functions are callable
from evaluation scripts without going through HTTP at all (see §4).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import get_settings
from app.logging_utils import configure_logging

configure_logging()
settings = get_settings()

app = FastAPI(title="ClearSpace", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health")
def health() -> dict:
    """Backend liveness — separate from the Colab/ngrok image-gen health check in routes.py (§5)."""
    return {"status": "ok"}
