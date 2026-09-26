"""
Unit tests for app/core/image_validation.validate_image_bytes() — the
shared, pure Pillow-based image-content validator used by both
app/models/image_gen_client.py and
app/services/reorganise_pipeline_service.py. No HTTP, no model, no
network anywhere in this file.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.core.image_validation import ImageValidationError, validate_image_bytes


def _image_bytes(fmt: str = "PNG", size=(4, 4), color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format=fmt)
    return buf.getvalue()


PNG_BYTES = _image_bytes("PNG")
JPEG_BYTES = _image_bytes("JPEG")


def test_valid_png_matching_media_type_passes():
    validate_image_bytes(PNG_BYTES, "image/png")  # does not raise


def test_valid_jpeg_matching_media_type_passes():
    validate_image_bytes(JPEG_BYTES, "image/jpeg")  # does not raise


@pytest.mark.parametrize("bad_bytes", [b"", None, "not-bytes", 123, [], {}])
def test_non_bytes_or_empty_rejected(bad_bytes):
    with pytest.raises(ImageValidationError):
        validate_image_bytes(bad_bytes, "image/png")


@pytest.mark.parametrize("bad_media_type", ["image/gif", "png", "", None, 5])
def test_unsupported_media_type_rejected(bad_media_type):
    with pytest.raises(ImageValidationError):
        validate_image_bytes(PNG_BYTES, bad_media_type)


def test_non_image_bytes_rejected():
    with pytest.raises(ImageValidationError):
        validate_image_bytes(b"this is not an image at all", "image/png")


def test_truncated_image_bytes_rejected():
    with pytest.raises(ImageValidationError):
        validate_image_bytes(PNG_BYTES[: len(PNG_BYTES) // 2], "image/png")


def test_png_bytes_claimed_as_jpeg_rejected():
    with pytest.raises(ImageValidationError):
        validate_image_bytes(PNG_BYTES, "image/jpeg")


def test_jpeg_bytes_claimed_as_png_rejected():
    with pytest.raises(ImageValidationError):
        validate_image_bytes(JPEG_BYTES, "image/png")


def test_image_validation_error_is_a_value_error():
    assert issubclass(ImageValidationError, ValueError)


def test_error_message_never_contains_raw_bytes_repr():
    # Sanity check on message hygiene — the error should describe the
    # PROBLEM, never dump the actual bytes into the message.
    try:
        validate_image_bytes(b"garbage-not-an-image", "image/png")
    except ImageValidationError as exc:
        assert "garbage-not-an-image" not in str(exc)
    else:
        pytest.fail("expected ImageValidationError")
