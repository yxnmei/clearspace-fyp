"""Placeholder — see README.md. Delete once the first real system test lands.

test_upload_declutter_returns_classified_items (the /upload placeholder)
was removed here once /upload's declutter path was implemented — see
tests/system/test_upload_declutter.py for the real, fake-backed
replacement. test_generate_returns_reorganised_image below is still an
honest placeholder: /generate (Reorganise/image-gen) is not implemented."""

import pytest


@pytest.mark.requires_colab
@pytest.mark.skip(
    reason=(
        "Requires the Colab notebook running with a live ngrok tunnel — see §5. "
        "Not automatable; run manually after starting the notebook."
    )
)
def test_generate_returns_reorganised_image():
    pass
