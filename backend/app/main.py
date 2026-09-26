"""
FastAPI entrypoint: app setup only. Handlers live in app/api/routes.py and
logic in app/services, so evaluation scripts can call it without HTTP.
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import get_settings
from app.logging_utils import configure_logging

configure_logging()
settings = get_settings()

logger = logging.getLogger(__name__)

app = FastAPI(title="ClearSpace", version="0.1.0")

# Fixed, value-free 422 body. FastAPI's default handler returns
# exc.errors(), whose `input` for a body-level model validator is the whole
# request (base64 image, user context, every submitted field) and whose
# `msg` can quote submitted ids, so any client that displays or logs error
# bodies would echo the upload back. This body never echoes input and its
# size does not depend on the request. Route HTTPException details are
# unaffected.
VALIDATION_FAILED_DETAIL = "Request validation failed. Check the submitted fields and try again."

# `loc[0]` is the request part FastAPI validated (never a value the client
# chose); anything outside this allowlist is reported as "request".
_VALIDATION_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})
_MAX_REPORTED_ERRORS = 20


def _summarise_validation_errors(exc: RequestValidationError) -> list[dict[str, str]]:
    """Bounded, deduplicated, sorted {type, location} pairs: pydantic's
    fixed error id and the validated request part. Everything else (msg,
    input, ctx, url, deeper loc elements that can be request keys) is
    dropped."""
    summary: set[tuple[str, str]] = set()
    for error in exc.errors():
        error_type = error.get("type")
        if not isinstance(error_type, str) or not error_type:
            error_type = "unknown"
        loc = error.get("loc") or ()
        first = loc[0] if isinstance(loc, (list, tuple)) and loc else None
        location = first if isinstance(first, str) and first in _VALIDATION_LOCATIONS else "request"
        summary.add((error_type, location))
    ordered = sorted(summary)[:_MAX_REPORTED_ERRORS]
    return [{"type": error_type, "location": location} for error_type, location in ordered]


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = _summarise_validation_errors(exc)
    # Route + error kinds only — never the body, the raw errors or exc itself.
    logger.warning(
        "request validation failed: %s %s (%d error kind(s): %s)",
        request.method,
        request.url.path,
        len(errors),
        ", ".join(f"{e['location']}:{e['type']}" for e in errors) or "none",
    )
    return JSONResponse(status_code=422, content={"detail": VALIDATION_FAILED_DETAIL, "errors": errors})

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
    """Backend liveness — separate from the Colab/ngrok image-gen health check in routes.py."""
    return {"status": "ok"}
