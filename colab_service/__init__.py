"""
ClearSpace's Colab-hosted image-generation service.

A separate, independently-deployed runtime from backend/ — it is cloned
into a Colab VM and run there, never imported by or into backend/. It has
no dependency on the backend package; app/models/image_gen_client.py's
contract is the shared source of truth, mirrored here deliberately rather
than imported, so a contract drift is caught by comparing the two files
side by side during review, not hidden behind an accidental cross-import
between two independently-deployed services.

Importing this package, or any module inside it, never loads a model,
downloads a weight, or contacts any external service — see each
submodule's own docstring (schemas.py/resolution.py are pure; depth.py/
pipeline.py defer every heavy import to inside their loader functions,
never at module import time). This is what makes colab_service/tests/
runnable on a plain local machine, no GPU, no Colab, no network.

See colab_service/README.md for architecture, setup (Colab Web and the
VS Code Colab extension), configuration, evaluation findings, and
troubleshooting. Real Colab inference and end-to-end frontend integration
have been verified; the current whole-image preview remains illustrative
because its fidelity is not acceptable.
"""
