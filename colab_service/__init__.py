"""Independently deployed Colab image-generation service.

Its contract mirrors the backend client without cross-importing between
runtimes. Imports have no model-loading, download, or network side effects,
which keeps local tests GPU-free. See ``colab_service/README.md`` for setup,
verified integration, and the preview's remaining fidelity limitation.
"""
