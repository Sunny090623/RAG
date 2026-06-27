"""
Conversations routes — loading and clearing conversation histories.
"""

import logging
import json
import datetime
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from backend.shared import STORAGE_DIR, notebook_id_var

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


# --- Helper functions ---

def get_active_conversation_id(notebook_id: str) -> str:
    """Resolve the active conversation ID of the notebook from notebooks.json."""
    if notebook_id == "default":
        return "default-conv"
        
    from backend.routes.notebooks import load_notebooks_list
    notebooks = load_notebooks_list()
    for nb in notebooks:
        if nb["id"] == notebook_id:
            return nb.get("active_conversation_id") or "default-conv"
            
    return "default-conv"

def get_conversation_file_path(notebook_id: str, conversation_id: str) -> Path:
    """Resolve the filepath of the conversation JSON file."""
    if notebook_id == "default":
        conv_dir = STORAGE_DIR / "conversations"
    else:
        conv_dir = STORAGE_DIR / "notebooks" / notebook_id / "conversations"
        
    conv_dir.mkdir(parents=True, exist_ok=True)
    return conv_dir / f"{conversation_id}.json"

def load_conversation_messages(notebook_id: str, conversation_id: str) -> List[dict]:
    """Load messages list from file, returning empty list if missing/corrupt."""
    file_path = get_conversation_file_path(notebook_id, conversation_id)
    if not file_path.exists():
        return []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load conversation messages from {file_path}: {e}")
        return []

def save_conversation_messages(notebook_id: str, conversation_id: str, messages: List[dict]):
    """Save messages list to the conversation file."""
    file_path = get_conversation_file_path(notebook_id, conversation_id)
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(messages, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save conversation messages to {file_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save conversation history: {e}")

def append_messages_to_active(notebook_id: str, new_messages: List[dict]):
    """Helper to append user/assistant messages to active notebook conversation."""
    conversation_id = get_active_conversation_id(notebook_id)
    messages = load_conversation_messages(notebook_id, conversation_id)
    messages.extend(new_messages)
    save_conversation_messages(notebook_id, conversation_id, messages)


# --- Endpoints ---

@router.get("/active")
async def get_active_conversation():
    """Get the active conversation's messages list for the current notebook context."""
    notebook_id = notebook_id_var.get()
    conversation_id = get_active_conversation_id(notebook_id)
    messages = load_conversation_messages(notebook_id, conversation_id)
    return {
        "notebook_id": notebook_id,
        "conversation_id": conversation_id,
        "messages": messages
    }

@router.post("/active/clear")
async def clear_active_conversation():
    """Clear/Reset the active conversation messages."""
    notebook_id = notebook_id_var.get()
    conversation_id = get_active_conversation_id(notebook_id)
    save_conversation_messages(notebook_id, conversation_id, [])
    return {"status": "success", "message": "Conversation history cleared."}
