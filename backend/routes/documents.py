"""
Document routes — CRUD operations for indexed documents.
"""

import os
import uuid
import json
import shutil
import logging
from pathlib import Path
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.shared import get_shared_client as get_document_client, get_images_dir, get_uploads_dir
from backend.utils import find_node_by_id, map_structure_keys, sanitize_filename

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["documents"])


# --- Pydantic models ---

class RenamePayload(BaseModel):
    new_name: str


# --- Endpoints ---

@router.get("/documents")
async def list_documents():
    client = get_document_client()
    docs = []
    for doc_id, meta in client.documents.items():
        docs.append({
            "doc_id": doc_id,
            "doc_name": meta.get("doc_name", ""),
            "doc_description": meta.get("doc_description", ""),
            "type": meta.get("type", "pdf"),
            "page_count": meta.get("page_count", 0),
            "line_count": meta.get("line_count", 0),
        })
    return docs

@router.get("/documents/{doc_id}")
async def get_document_details(doc_id: str):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    client._ensure_doc_loaded(doc_id)
    mapped_structure = map_structure_keys(doc_info.get("structure", []))
    return {
        "doc_id": doc_id,
        "doc_name": doc_info.get("doc_name", ""),
        "doc_description": doc_info.get("doc_description", ""),
        "type": doc_info.get("type", "pdf"),
        "structure": mapped_structure,
        "page_count": doc_info.get("page_count", 0),
        "line_count": doc_info.get("line_count", 0)
    }

@router.put("/documents/{doc_id}/rename")
async def rename_document(doc_id: str, payload: RenamePayload):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    new_name = payload.new_name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="New name cannot be empty")
        
    # Ensure doc is loaded fully to modify structure/pages
    client._ensure_doc_loaded(doc_id)
    
    old_name = doc_info.get("doc_name")
    
    # 1. Rename images folder on disk if it exists
    images_dir = get_images_dir()
    uploads_dir = get_uploads_dir()
    if old_name:
        old_folder = images_dir / sanitize_filename(old_name)
        new_folder = images_dir / sanitize_filename(new_name)
        if old_folder.exists() and old_folder.is_dir() and old_folder != new_folder:
            try:
                if new_folder.exists():
                    logger.warning(f"New folder {new_folder} already exists. Removing it first.")
                    shutil.rmtree(new_folder)
                os.rename(old_folder, new_folder)
                logger.info(f"Renamed image directory from {old_folder} to {new_folder}")
            except Exception as e:
                logger.error(f"Failed to rename document images folder: {e}")
                
    # 2. Rename original file inside uploads_dir if it exists
    old_path = doc_info.get("path")
    if old_path and os.path.exists(old_path):
        old_path_obj = Path(old_path)
        try:
            if old_path_obj.parent.resolve() == uploads_dir.resolve():
                filename = old_path_obj.name
                parts = filename.split("_", 1)
                prefix = ""
                if len(parts) > 1:
                    prefix = parts[0] + "_"
                ext = old_path_obj.suffix
                new_filename = f"{prefix}{new_name}{ext}"
                new_path = uploads_dir / new_filename
                
                if new_path != old_path_obj:
                    if new_path.exists():
                        new_path = uploads_dir / f"{uuid.uuid4()}_{new_name}{ext}"
                    os.rename(old_path_obj, new_path)
                    doc_info["path"] = str(new_path)
                    logger.info(f"Renamed original file path from {old_path_obj} to {new_path}")
        except Exception as e:
            logger.error(f"Failed to rename original file: {e}")

    # 3. Update in-memory registry doc_name
    doc_info["doc_name"] = new_name
    
    # 4. Persist the document json and metadata _meta.json
    client._save_doc(doc_id)
    
    return {"status": "success", "message": f"Document renamed to {new_name}."}

@router.get("/documents/{doc_id}/view")
async def view_original_document(doc_id: str):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    file_path = doc_info.get("path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Original document file not found")
        
    media_type = "application/pdf"
    if doc_info.get("type") == "md":
        media_type = "text/markdown"
    elif file_path.lower().endswith(".png"):
        media_type = "image/png"
    elif file_path.lower().endswith(".jpg") or file_path.lower().endswith(".jpeg"):
        media_type = "image/jpeg"
        
    return FileResponse(file_path, media_type=media_type, filename=os.path.basename(file_path))

@router.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    # Delete original file
    orig_path = doc_info.get("path")
    if orig_path and os.path.exists(orig_path):
        try:
            os.remove(orig_path)
            logger.info(f"Deleted original document file: {orig_path}")
        except Exception as e:
            logger.error(f"Failed to delete original file: {e}")
            
    # 1. Update _meta.json first (most critical for consistency)
    meta_path = WORKSPACE_DIR / "_meta.json"
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta.pop(doc_id, None)
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"Failed to update metadata index before deletion: {e}")
    
    # 2. Remove from in-memory client registry
    client.documents.pop(doc_id, None)
    
    # 3. Delete physical files (workspace JSON + page images)
    doc_file = WORKSPACE_DIR / f"{doc_id}.json"
    if doc_file.exists():
        try:
            os.remove(doc_file)
        except Exception as e:
            logger.error(f"Failed to delete document JSON: {e}")
        
    # Delete folder-based visual images
    images_dir = get_images_dir()
    doc_name = doc_info.get("doc_name")
    if doc_name:
        doc_folder = images_dir / sanitize_filename(doc_name)
        if doc_folder.exists() and doc_folder.is_dir():
            try:
                shutil.rmtree(doc_folder)
            except Exception as e:
                logger.error(f"Failed to delete document images folder: {e}")
                
    # Also fallback to delete flat visual images
    for p in images_dir.glob(f"{doc_id}_*.png"):
        try:
            os.remove(p)
        except:
            pass
            
    return {"status": "success", "message": "Document deleted successfully."}

@router.get("/documents/{doc_id}/pages/{page_num}/image")
async def get_page_image(doc_id: str, page_num: int):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    doc_name = doc_info.get("doc_name")
    if not doc_name:
        raise HTTPException(status_code=404, detail="Document name not found")
        
    images_dir = get_images_dir()
    doc_folder = images_dir / sanitize_filename(doc_name)
    img_path = doc_folder / f"{doc_id}_{page_num}.png"
    
    # Fallback to the old flat path for legacy documents
    if not img_path.exists():
        img_path = images_dir / f"{doc_id}_{page_num}.png"
        
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Page image not found")
        
    return FileResponse(str(img_path), media_type="image/png")

@router.get("/documents/{doc_id}/nodes/{node_id}/text")
async def get_node_text(doc_id: str, node_id: str):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    client._ensure_doc_loaded(doc_id)
    structure = doc_info.get("structure", [])
    node = find_node_by_id(structure, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
        
    node_text = node.get("text")
    if node_text:
        return {"content": node_text}
        
    # Fallback to page-based text if text is missing (legacy support)
    start_page = node.get("start_index")
    end_page = node.get("end_index", start_page)
    if start_page is not None:
        pages_str = f"{start_page}-{end_page}" if end_page else str(start_page)
        content_json = client.get_page_content(doc_id, pages_str)
        try:
            content_list = json.loads(content_json)
            if isinstance(content_list, list) and len(content_list) > 0:
                combined = "\n\n".join(c["content"] for c in content_list if "content" in c)
                return {"content": combined}
        except Exception as e:
            logger.error(f"Fallback reading node pages failed: {e}")
            
    raise HTTPException(status_code=404, detail="Node content not found")

@router.get("/documents/{doc_id}/pages/{page_num}/text")
async def get_page_text(doc_id: str, page_num: int):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    client._ensure_doc_loaded(doc_id)
    content_json = client.get_page_content(doc_id, str(page_num))
    try:
        content_list = json.loads(content_json)
        if isinstance(content_list, list) and len(content_list) > 0:
            return {"content": content_list[0]["content"]}
    except:
        pass
    raise HTTPException(status_code=404, detail="Page content not found")
