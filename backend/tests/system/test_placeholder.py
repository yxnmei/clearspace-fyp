"""Placeholder — see README.md. Delete once the first real system test lands."""

import pytest


@pytest.mark.skip(reason="No /upload implementation yet — §3 build order step 6 not reached.")
def test_upload_declutter_returns_classified_items():
    pass


@pytest.mark.requires_colab
@pytest.mark.skip(
    reason=(
        "Requires the Colab notebook running with a live ngrok tunnel — see §5. "
        "Not automatable; run manually after starting the notebook."
    )
)
def test_generate_returns_reorganised_image():
    pass
