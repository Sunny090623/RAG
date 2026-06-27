"""
Notebook routes — CRUD operations and duplication/deletion for notebooks.
"""

import logging
import uuid
import json
import shutil
import datetime
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from backend.shared import STORAGE_DIR, get_shared_client as get_document_client, notebook_id_var

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])


# --- Pydantic models ---

class CreateNotebookPayload(BaseModel):
    title: str

class RenameNotebookPayload(BaseModel):
    title: str


# --- Helper functions ---

def load_notebooks_list() -> List[dict]:
    """Load the list of notebooks from notebooks.json, auto-generating default if missing."""
    file_path = STORAGE_DIR / "notebooks.json"
    if not file_path.exists():
        # Auto-create Default Notebook pointing to original storage
        default_nb = {
            "id": "default",
            "title": "Default Notebook",
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "active_conversation_id": "default-conv"
        }
        save_notebooks_list([default_nb])
        return [default_nb]
    
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            notebooks = json.load(f)
            modified = False
            for nb in notebooks:
                if "active_conversation_id" not in nb:
                    if nb["id"] == "default":
                        nb["active_conversation_id"] = "default-conv"
                    else:
                        nb["active_conversation_id"] = str(uuid.uuid4())
                    modified = True
            if modified:
                save_notebooks_list(notebooks)
            return notebooks
    except Exception as e:
        logger.error(f"Failed to load notebooks list: {e}")
        return []

def save_notebooks_list(notebooks: List[dict]):
    """Save the list of notebooks to notebooks.json."""
    file_path = STORAGE_DIR / "notebooks.json"
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(notebooks, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save notebooks list: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save notebooks metadata: {e}")


# --- Endpoints ---

@router.get("")
async def list_notebooks():
    """List all notebooks along with their document counts."""
    notebooks = load_notebooks_list()
    result = []
    for nb in notebooks:
        nid = nb["id"]
        # Set notebook ID context temporarily to retrieve the count of documents
        token = notebook_id_var.set(nid)
        try:
            client = get_document_client()
            doc_count = len(client.documents)
        except Exception:
            doc_count = 0
        finally:
            notebook_id_var.reset(token)
            
        result.append({
            "id": nid,
            "title": nb.get("title", "Untitled Notebook"),
            "created_at": nb.get("created_at"),
            "updated_at": nb.get("updated_at"),
            "doc_count": doc_count
        })
    return result

@router.post("")
async def create_notebook(payload: CreateNotebookPayload):
    """Create a new notebook and initialize its storage directories."""
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Notebook title cannot be empty")
        
    notebooks = load_notebooks_list()
    nid = str(uuid.uuid4())
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    new_nb = {
        "id": nid,
        "title": title,
        "created_at": now,
        "updated_at": now,
        "active_conversation_id": str(uuid.uuid4())
    }
    
    # Pre-create directory structures
    try:
        for subdir in ["workspace", "images", "uploads", "conversations"]:
            path = STORAGE_DIR / "notebooks" / nid / subdir
            path.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.error(f"Failed to create notebook directories: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create storage for notebook: {e}")
        
    notebooks.append(new_nb)
    save_notebooks_list(notebooks)
    return new_nb

@router.put("/{notebook_id}/rename")
async def rename_notebook(notebook_id: str, payload: RenameNotebookPayload):
    """Rename an existing notebook."""
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Notebook title cannot be empty")
        
    notebooks = load_notebooks_list()
    for nb in notebooks:
        if nb["id"] == notebook_id:
            nb["title"] = title
            nb["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            save_notebooks_list(notebooks)
            return nb
            
    raise HTTPException(status_code=404, detail="Notebook not found")

@router.post("/{notebook_id}/duplicate")
async def duplicate_notebook(notebook_id: str):
    """Duplicate an existing notebook and clone all of its index files, uploads, and images."""
    notebooks = load_notebooks_list()
    source_nb = None
    for nb in notebooks:
        if nb["id"] == notebook_id:
            source_nb = nb
            break
            
    if not source_nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
        
    new_id = str(uuid.uuid4())
    new_conv_id = str(uuid.uuid4())
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    new_nb = {
        "id": new_id,
        "title": f"Copy of {source_nb['title']}",
        "created_at": now,
        "updated_at": now,
        "active_conversation_id": new_conv_id
    }
    
    # Paths resolve
    if notebook_id == "default":
        src_dir_map = {
            "workspace": STORAGE_DIR / "workspace",
            "images": STORAGE_DIR / "images",
            "uploads": STORAGE_DIR / "uploads"
        }
    else:
        src_dir_map = {
            "workspace": STORAGE_DIR / "notebooks" / notebook_id / "workspace",
            "images": STORAGE_DIR / "notebooks" / notebook_id / "images",
            "uploads": STORAGE_DIR / "notebooks" / notebook_id / "uploads"
        }
        
    dst_base = STORAGE_DIR / "notebooks" / new_id
    
    try:
        for sub, src_path in src_dir_map.items():
            dst_path = dst_base / sub
            dst_path.mkdir(parents=True, exist_ok=True)
            if src_path.exists():
                shutil.copytree(src_path, dst_path, dirs_exist_ok=True)
                
        # Duplicate the conversation history file if exists
        if notebook_id == "default":
            src_conv_dir = STORAGE_DIR / "conversations"
        else:
            src_conv_dir = STORAGE_DIR / "notebooks" / notebook_id / "conversations"
            
        src_conv_file = src_conv_dir / f"{source_nb.get('active_conversation_id')}.json"
        
        dst_conv_dir = STORAGE_DIR / "notebooks" / new_id / "conversations"
        dst_conv_dir.mkdir(parents=True, exist_ok=True)
        dst_conv_file = dst_conv_dir / f"{new_conv_id}.json"
        
        if src_conv_file.exists():
            shutil.copy2(src_conv_file, dst_conv_file)
            
    except Exception as e:
        logger.error(f"Failed to duplicate notebook files from {notebook_id} to {new_id}: {e}", exc_info=True)
        if dst_base.exists():
            try:
                shutil.rmtree(dst_base)
            except:
                pass
        raise HTTPException(status_code=500, detail=f"Failed to copy files: {e}")
        
    notebooks.append(new_nb)
    save_notebooks_list(notebooks)
    return new_nb

@router.delete("/{notebook_id}")
async def delete_notebook(notebook_id: str):
    """Delete a notebook, purging all files from disk."""
    notebooks = load_notebooks_list()
    target_nb = None
    for nb in notebooks:
        if nb["id"] == notebook_id:
            target_nb = nb
            break
            
    if not target_nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
        
    # Delete storage directories
    if notebook_id != "default":
        nb_dir = STORAGE_DIR / "notebooks" / notebook_id
        if nb_dir.exists():
            try:
                shutil.rmtree(nb_dir)
            except Exception as e:
                logger.error(f"Failed to clear directory for notebook {notebook_id}: {e}")
                raise HTTPException(status_code=500, detail=f"Failed to delete directory: {e}")
    else:
        # For default notebook, clear contents to allow clean slate but keep directory definitions
        for sub in ["workspace", "images", "uploads"]:
            path = STORAGE_DIR / sub
            if path.exists():
                try:
                    shutil.rmtree(path)
                    path.mkdir(parents=True, exist_ok=True)
                except Exception as e:
                    logger.error(f"Failed to clear default subdirectory {sub}: {e}")
                    
    # Remove from list
    notebooks = [nb for nb in notebooks if nb["id"] != notebook_id]
    save_notebooks_list(notebooks)
    
    # Delete client from shared dictionary if loaded
    from backend.shared import _clients
    if notebook_id in _clients:
        del _clients[notebook_id]
        
    return {"status": "success"}
