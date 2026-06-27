"""
Shared singleton PageIndexClient instance.

All modules (parser.py, rag.py, app.py) should use get_shared_client()
instead of creating their own PageIndexClient instances. This ensures:
1. Data consistency — single in-memory document registry
2. No concurrent write conflicts on _meta.json
3. No redundant disk reads on every API request
"""

from pathlib import Path

from pageindex import PageIndexClient

import contextvars

# Context variable to hold active notebook ID for async task workers/request threads
notebook_id_var = contextvars.ContextVar("notebook_id", default="default")

# Base directories
STORAGE_DIR = Path(__file__).parent / "storage"

def get_current_notebook_id() -> str:
    """Return the active notebook ID from the context variable."""
    return notebook_id_var.get()

def get_workspace_dir(notebook_id: str = None) -> Path:
    """Return the workspace directory path for the given notebook ID."""
    if not notebook_id:
        notebook_id = get_current_notebook_id()
    if notebook_id == "default":
        path = STORAGE_DIR / "workspace"
    else:
        path = STORAGE_DIR / "notebooks" / notebook_id / "workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path

def get_images_dir(notebook_id: str = None) -> Path:
    """Return the images directory path for the given notebook ID."""
    if not notebook_id:
        notebook_id = get_current_notebook_id()
    if notebook_id == "default":
        path = STORAGE_DIR / "images"
    else:
        path = STORAGE_DIR / "notebooks" / notebook_id / "images"
    path.mkdir(parents=True, exist_ok=True)
    return path

def get_uploads_dir(notebook_id: str = None) -> Path:
    """Return the uploads directory path for the given notebook ID."""
    if not notebook_id:
        notebook_id = get_current_notebook_id()
    if notebook_id == "default":
        path = STORAGE_DIR / "uploads"
    else:
        path = STORAGE_DIR / "notebooks" / notebook_id / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path

# To maintain compatibility for imports, define WORKSPACE_DIR and IMAGES_DIR
# pointing to their default paths.
WORKSPACE_DIR = STORAGE_DIR / "workspace"
IMAGES_DIR = STORAGE_DIR / "images"
UPLOADS_DIR = STORAGE_DIR / "uploads"
NOTEBOOKS_DIR = STORAGE_DIR / "notebooks"
CACHE_DIR = STORAGE_DIR / "cache"

for d in [STORAGE_DIR, WORKSPACE_DIR, IMAGES_DIR, UPLOADS_DIR, NOTEBOOKS_DIR, CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Cache dictionary of PageIndexClient registry instances keyed by notebook ID
_clients = {}

def get_shared_client(notebook_id: str = None) -> PageIndexClient:
    """Return the PageIndexClient for the current notebook context, creating it on first call."""
    global _clients
    if not notebook_id:
        notebook_id = get_current_notebook_id()
    if notebook_id not in _clients:
        ws_dir = get_workspace_dir(notebook_id)
        _clients[notebook_id] = PageIndexClient(workspace=str(ws_dir))
    return _clients[notebook_id]
