"""
Guarantees the repository root is on sys.path so `import colab_service`
and its siblings resolve regardless of the exact invocation (the intended
invocation is `python -m pytest colab_service/tests` from the repo root
— see colab_service/README.md's "What local tests do and don't prove" —
which already adds the cwd to sys.path via `-m`'s own standard behavior;
this is a defensive belt-and-braces addition, not a workaround for a
known failure).
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
