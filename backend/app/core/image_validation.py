"""
Pure, shared image-content validation: given raw bytes and a claimed
media type, verify the bytes genuinely decode as an image in that exact
format. No base64 handling lives here — base64 is a wire-transport
concern specific to whichever HTTP layer receives a request; this module
only ever sees real bytes.

Used by:
  - app/models/image_gen_client.py (R3) — validates the caller-supplied
    outbound image before it is ever sent to the remote service
    (_validate_image delegates here).
  - app/services/reorganise_pipeline_service.py (R4) — validates the
    resubmitted original image before deterministic plan construction and
    remote image generation, so malformed image data reaches neither.

One implementation, not two that drift, per PROJECT_SPEC.md §4 — the
same discipline already applied to ItemId/NonEmptyStr in
app/core/schemas.py. R3's own validation of the INBOUND remote response
image (inside image_gen_client._parse_generation_response) is a
separate, pre-existing block and is deliberately left untouched by this
module's introduction — only the caller-supplied OUTBOUND image
validation (_validate_image) was refactored to use this.
"""

from __future__ import annotations

import io
from typing import Any

from PIL import Image

SUPPORTED_IMAGE_MEDIA_TYPES: dict[str, str] = {"image/png": "PNG", "image/jpeg": "JPEG"}


class ImageValidationError(ValueError):
    """image_bytes is not genuine, non-empty, decodable bytes whose
    actual format matches the claimed image_media_type. A ValueError
    subclass — existing `except ValueError`/`pytest.raises(ValueError)`
    callers (e.g. app/models/image_gen_client.py's existing test suite)
    keep working unchanged regardless of which module raises it."""


def validate_image_bytes(image_bytes: Any, image_media_type: Any) -> None:
    """
    Raises ImageValidationError (never a raw exception) for:
      - image_bytes not real, non-empty bytes.
      - image_media_type not one of SUPPORTED_IMAGE_MEDIA_TYPES.
      - image_bytes that Pillow cannot decode/verify as an image at all
        (truncated, corrupt, or not image data).
      - image_bytes that decode successfully but to a DIFFERENT actual
        format than the one claimed (e.g. JPEG bytes claimed as PNG).

    Returns None on success — this function's only job is validation, not
    decoding for reuse; callers that need the decoded image open it again
    themselves.
    """
    if not isinstance(image_bytes, bytes) or not image_bytes:
        raise ImageValidationError("image_bytes must be non-empty bytes")
    if image_media_type not in SUPPORTED_IMAGE_MEDIA_TYPES:
        raise ImageValidationError(
            f"image_media_type must be one of {sorted(SUPPORTED_IMAGE_MEDIA_TYPES)}: {image_media_type!r}"
        )
    try:
        img = Image.open(io.BytesIO(image_bytes))
        actual_format = img.format
        img.verify()
    except Exception as exc:
        raise ImageValidationError(
            f"image_bytes could not be decoded as a valid image: {type(exc).__name__}"
        ) from exc
    if SUPPORTED_IMAGE_MEDIA_TYPES[image_media_type] != actual_format:
        raise ImageValidationError(
            f"image_media_type {image_media_type!r} does not match the actual image format {actual_format!r}"
        )
