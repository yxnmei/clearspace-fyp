"""
Placeholder so pytest collects this directory from day one (proves the
four-type test structure is real, not aspirational — see README.md here).
Delete this once the first genuine integration test lands.
"""

import pytest


@pytest.mark.integration
@pytest.mark.skip(reason="No app/models implementations exist yet — §3 build order step 5 not reached.")
def test_detection_output_feeds_classification_prompt():
    pass
