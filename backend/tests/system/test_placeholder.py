"""Colab placeholder — see README.md.

test_upload_declutter_returns_classified_items (the /upload placeholder)
was removed here once /upload's declutter path was implemented — see
tests/system/test_upload_declutter.py for the real, fake-backed
replacement.

test_generate_returns_reorganised_image below is a placeholder for a
future real Colab-connected image-generation system test. Tidy-plan
generation (/generate and /generate/confirmed) IS implemented and is
covered, fake-backed, by test_generate_reorganise.py and
test_generate_confirmed.py; what remains unautomated is the remote
Stable Diffusion + ControlNet image step, which needs a human to start
the Colab notebook and provide a live tunnel. It stays skipped for that
reason, and a skipped placeholder is not evidence that image generation
passed. Real-model coverage of the local chain lives in
tests/integration/ (opt-in)."""

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
