import os
import sys
import json
import asyncio
import logging
import shutil
from pathlib import Path
from typing import Optional, List
from pydantic import BaseModel
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Setup sys path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.provider import (
    set_active_provider, get_active_provider, check_ollama_status, check_xinference_status,
    get_vlm_provider, set_vlm_provider
)
from backend.parser import index_document
from backend.shared import get_shared_client as get_document_client, STORAGE_DIR, WORKSPACE_DIR, IMAGES_DIR
from backend.rag import execute_rag_flow_stream

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

try:
    log_file = Path(__file__).parent.parent / "Log.txt"
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s"))
    logging.getLogger().addHandler(file_handler)
    logger.info(f"Log file handler configured. Logging to {log_file}")
except Exception as e:
    logger.error(f"Failed to setup file log handler: {e}")

from contextlib import asynccontextmanager

# Settings persistence
SETTINGS_FILE = STORAGE_DIR / "settings.json"
SETTINGS_CHAT_FILE = STORAGE_DIR / "settings_chat.json"
SETTINGS_VLM_FILE = STORAGE_DIR / "settings_vlm.json"
UPLOADS_DIR = STORAGE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

class ChatSettingsPayload(BaseModel):
    provider_type: str
    model_name: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None

class VLMSettingsPayload(BaseModel):
    use_vlm: bool = False
    vlm_provider_type: Optional[str] = "ollama"
    vlm_model: Optional[str] = None
    vlm_api_base: Optional[str] = None
    vlm_api_key: Optional[str] = None


def load_settings():
    # If old settings.json exists, remove it to ensure the key is only in the two config files
    if SETTINGS_FILE.exists():
        try:
            os.remove(SETTINGS_FILE)
            logger.info("Old settings.json deleted to enforce single-place persistence of API key.")
        except Exception as e:
            logger.error(f"Failed to delete old settings.json: {e}")

    # Auto-generate settings_chat.json if missing
    if not SETTINGS_CHAT_FILE.exists():
        try:
            default_chat = {
                "provider_type": "ollama",
                "model_name": "gemma4:12b-it-qat",
                "api_base": "http://localhost:11434",
                "api_key": "empty"
            }
            with open(SETTINGS_CHAT_FILE, "w") as f:
                json.dump(default_chat, f, indent=2)
            logger.info("Automatically generated default settings_chat.json")
        except Exception as e:
            logger.error(f"Failed to generate default settings_chat.json: {e}")

    # Auto-generate settings_vlm.json if missing
    if not SETTINGS_VLM_FILE.exists():
        try:
            default_vlm = {
                "use_vlm": False,
                "vlm_provider_type": "ollama",
                "vlm_model": "gemma4:12b-it-qat",
                "vlm_api_base": "http://localhost:11434",
                "vlm_api_key": "empty"
            }
            with open(SETTINGS_VLM_FILE, "w") as f:
                json.dump(default_vlm, f, indent=2)
            logger.info("Automatically generated default settings_vlm.json")
        except Exception as e:
            logger.error(f"Failed to generate default settings_vlm.json: {e}")

    # Load Chat Settings
    chat_loaded = False
    if SETTINGS_CHAT_FILE.exists():
        try:
            with open(SETTINGS_CHAT_FILE, "r") as f:
                data = json.load(f)
                set_active_provider(
                    provider_type=data.get("provider_type", "ollama"),
                    model_name=data.get("model_name", "gemma4:12b-it-qat"),
                    api_base=data.get("api_base"),
                    api_key=data.get("api_key")
                )
                chat_loaded = True
                logger.info("Saved Chat settings loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load saved Chat settings: {e}")
            
    if not chat_loaded:
        set_active_provider("ollama", "gemma4:12b-it-qat", "http://localhost:11434")

    # Load VLM Settings
    vlm_loaded = False
    if SETTINGS_VLM_FILE.exists():
        try:
            with open(SETTINGS_VLM_FILE, "r") as f:
                data = json.load(f)
                set_vlm_provider(
                    use_vlm=True,
                    provider_type=data.get("vlm_provider_type") or "ollama",
                    model_name=data.get("vlm_model") or "gemma4:12b-it-qat",
                    api_base=data.get("vlm_api_base"),
                    api_key=data.get("vlm_api_key")
                )
                vlm_loaded = True
                logger.info("Saved VLM settings loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load saved VLM settings: {e}")
            
    if not vlm_loaded:
        set_vlm_provider(True, "ollama", "gemma4:12b-it-qat", "http://localhost:11434")

tasks_queue = asyncio.Queue()
tasks_dict = {}
tasks_list = []

async def task_worker():
    while True:
        try:
            task_id = await tasks_queue.get()
            task = tasks_dict.get(task_id)
            if not task:
                tasks_queue.task_done()
                continue
            
            task["status"] = "processing"
            file_path = UPLOADS_DIR / f"{task_id}_{task['filename']}"
            try:
                doc_id = await index_document(str(file_path))
                task["status"] = "completed"
                task["doc_id"] = doc_id
            except Exception as e:
                logger.error(f"Background parsing/indexing failed for {task['filename']}: {e}", exc_info=True)
                task["status"] = "failed"
                task["error"] = str(e)
            finally:
                if file_path.exists():
                    try:
                        os.remove(file_path)
                    except:
                        pass
                tasks_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in task worker loop: {e}", exc_info=True)
            await asyncio.sleep(1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_settings()
    worker = asyncio.create_task(task_worker())
    yield
    worker.cancel()
    try:
        await worker
    except asyncio.CancelledError:
        pass

# FastAPI
app = FastAPI(title="Local Multi-Modal Vectorless RAG", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Endpoints
@app.get("/api/status")
async def get_status(ollama_base: str = "http://localhost:11434", xinference_base: str = "http://localhost:9997"):
    # Run blocking HTTP status checks in thread pool to avoid blocking the event loop
    ollama_info, xinference_info = await asyncio.gather(
        asyncio.to_thread(check_ollama_status, ollama_base),
        asyncio.to_thread(check_xinference_status, xinference_base)
    )
    
    active = get_active_provider()
    vlm = get_vlm_provider()
    
    return {
        "ollama": ollama_info,
        "xinference": xinference_info,
        "active_provider": {
            "provider_type": active.provider_type,
            "model_name": active.model_name,
            "api_base": active.api_base,
            "api_key": "***" if active.api_key else ""
        },
        "vlm_provider": {
            "use_vlm": vlm.use_vlm,
            "provider_type": vlm.provider_type,
            "model_name": vlm.model_name,
            "api_base": vlm.api_base,
            "api_key": "***" if vlm.api_key else ""
        }
    }

@app.post("/api/settings/chat")
async def update_chat_settings(payload: ChatSettingsPayload):
    try:
        chat_key = payload.api_key
        if chat_key == "***":
            chat_key = get_active_provider().api_key
            
        set_active_provider(
            provider_type=payload.provider_type,
            model_name=payload.model_name,
            api_base=payload.api_base,
            api_key=chat_key
        )
        
        # Save to file
        settings_data = payload.dict()
        if settings_data.get("api_key") == "***":
            settings_data["api_key"] = get_active_provider().api_key
            
        with open(SETTINGS_CHAT_FILE, "w") as f:
            json.dump(settings_data, f, indent=2)
            
        return {"status": "success", "message": "Chat settings updated and saved."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/settings/vlm")
async def update_vlm_settings(payload: VLMSettingsPayload):
    try:
        vlm_key = payload.vlm_api_key
        if vlm_key == "***":
            vlm_key = get_vlm_provider().api_key
            
        set_vlm_provider(
            use_vlm=True,
            provider_type=payload.vlm_provider_type or "ollama",
            model_name=payload.vlm_model or "gemma4:12b-it-qat",
            api_base=payload.vlm_api_base,
            api_key=vlm_key
        )
        
        # Save to file
        settings_data = payload.dict()
        settings_data["use_vlm"] = True
        if settings_data.get("vlm_api_key") == "***":
            settings_data["vlm_api_key"] = get_vlm_provider().api_key
            
        with open(SETTINGS_VLM_FILE, "w") as f:
            json.dump(settings_data, f, indent=2)
            
        return {"status": "success", "message": "VLM settings updated and saved."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md", ".docx", ".markdown"]:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: {ext}")
        
    import uuid
    task_id = str(uuid.uuid4())
    temp_path = UPLOADS_DIR / f"{task_id}_{file.filename}"
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        task = {
            "task_id": task_id,
            "filename": file.filename,
            "status": "pending",
            "error": None,
            "doc_id": None
        }
        tasks_dict[task_id] = task
        tasks_list.append(task)
        await tasks_queue.put(task_id)
        
        return {
            "status": "queued",
            "task_id": task_id,
            "filename": file.filename
        }
    except Exception as e:
        logger.error(f"File upload & queue failed: {e}", exc_info=True)
        if temp_path.exists():
            try:
                os.remove(temp_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tasks")
async def get_tasks():
    return tasks_list

@app.post("/api/tasks/clear")
async def clear_tasks():
    global tasks_list
    completed_or_failed = [t for t in tasks_list if t["status"] in ("completed", "failed")]
    for t in completed_or_failed:
        tasks_dict.pop(t["task_id"], None)
    tasks_list = [t for t in tasks_list if t["status"] not in ("completed", "failed")]
    return {"status": "success", "message": f"Cleared {len(completed_or_failed)} tasks."}

@app.get("/api/documents")
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

@app.get("/api/documents/{doc_id}")
async def get_document_details(doc_id: str):
    client = get_document_client()
    doc_info = client.documents.get(doc_id)
    if not doc_info:
        raise HTTPException(status_code=404, detail="Document not found")
        
    client._ensure_doc_loaded(doc_id)
    return {
        "doc_id": doc_id,
        "doc_name": doc_info.get("doc_name", ""),
        "doc_description": doc_info.get("doc_description", ""),
        "type": doc_info.get("type", "pdf"),
        "structure": doc_info.get("structure", []),
        "page_count": doc_info.get("page_count", 0),
        "line_count": doc_info.get("line_count", 0)
    }

@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    client = get_document_client()
    if doc_id not in client.documents:
        raise HTTPException(status_code=404, detail="Document not found")
        
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
        
    for p in IMAGES_DIR.glob(f"{doc_id}_*.png"):
        try:
            os.remove(p)
        except:
            pass
            
    return {"status": "success", "message": "Document deleted successfully."}

@app.get("/api/documents/{doc_id}/pages/{page_num}/image")
async def get_page_image(doc_id: str, page_num: int):
    img_path = IMAGES_DIR / f"{doc_id}_{page_num}.png"
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Page image not found")
    return FileResponse(str(img_path), media_type="image/png")

@app.get("/api/documents/{doc_id}/pages/{page_num}/text")
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

class ChatPayload(BaseModel):
    doc_ids: Optional[List[str]] = None
    doc_id: Optional[str] = None
    query: str
    force_search: bool = False

@app.post("/api/chat")
async def chat_query(payload: ChatPayload):
    doc_ids = payload.doc_ids
    if not doc_ids and payload.doc_id:
        doc_ids = [payload.doc_id]
    if not doc_ids:
        raise HTTPException(status_code=400, detail="No documents selected for chat.")
    generator = execute_rag_flow_stream(doc_ids, payload.query, payload.force_search)
    return StreamingResponse(generator, media_type="text/event-stream")

# Mount static files
static_dir = Path(__file__).parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)

app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8088)
