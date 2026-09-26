"""
Shared outbound image validation: verify raw bytes decode as an image in
exactly the claimed format. Base64 is a transport concern handled by the
HTTP layer; this module only sees real bytes.

One implementation used by both the image-generation client (before an
image is sent to the remote service) and the reorganise pipeline (before
plan construction and generation), so the two cannot drift. Validation of
the INBOUND remote response image stays separate, inside the client.
"""

from __future__ import annotations

import io
from typing import Any

from PIL import Image

SUPPORTED_IMAGE_MEDIA_TYPES: dict[str, str] = {"image/png": "PNG", "image/jpeg": "JPEG"}


class ImageValidationError(ValueError):
    """image_bytes are not non-empty, decodable bytes in the claimed
    format. Subclasses ValueError so existing `except ValueError` callers
    keep working."""


def validate_image_bytes(image_bytes: Any, image_media_type: Any) -> None:
    """
    Raise ImageValidationError (never a raw exception) for empty or
    non-bytes input, an unsupported media type, bytes Pillow cannot
    decode/verify, or bytes whose actual format differs from the claim
    (e.g. JPEG bytes claimed as PNG). Validation only: callers that need
    the decoded image open it themselves.
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
