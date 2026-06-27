"""
Upload routes — file upload endpoint and background task queue management.
"""

import os
import uuid
import shutil
import asyncio
import logging
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException

from backend.parser import index_document
from backend.shared import STORAGE_DIR, get_uploads_dir, notebook_id_var

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["upload"])

# In-memory task tracking
tasks_queue = asyncio.Queue()
tasks_dict = {}
tasks_list = []


async def task_worker():
    """Background worker that processes upload/indexing tasks from the queue."""
    while True:
        try:
            task_id = await tasks_queue.get()
            task = tasks_dict.get(task_id)
            if not task:
                tasks_queue.task_done()
                continue
            
            notebook_id = task.get("notebook_id", "default")
            token = notebook_id_var.set(notebook_id)
            file_path = get_uploads_dir(notebook_id) / f"{task_id}_{task['filename']}"
            try:
                task["status"] = "processing"
                doc_id = await index_document(str(file_path))
                task["status"] = "completed"
                task["doc_id"] = doc_id
            except Exception as e:
                logger.error(f"Background parsing/indexing failed for {task['filename']}: {e}", exc_info=True)
                task["status"] = "failed"
                task["error"] = str(e)
                # Cleanup uploaded file only on failure
                if file_path.exists():
                    try:
                        os.remove(file_path)
                    except:
                        pass
            finally:
                notebook_id_var.reset(token)
                tasks_queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in task worker loop: {e}", exc_info=True)
            await asyncio.sleep(1)


# --- Endpoints ---

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md", ".docx", ".markdown"]:
        raise HTTPException(status_code=400, detail=f"Unsupported file format: {ext}")
        
    task_id = str(uuid.uuid4())
    notebook_id = notebook_id_var.get()
    temp_path = get_uploads_dir(notebook_id) / f"{task_id}_{file.filename}"
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        task = {
            "task_id": task_id,
            "filename": file.filename,
            "status": "pending",
            "error": None,
            "doc_id": None,
            "notebook_id": notebook_id
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

@router.get("/tasks")
async def get_tasks():
    return tasks_list

@router.post("/tasks/clear")
async def clear_tasks():
    global tasks_list
    completed_or_failed = [t for t in tasks_list if t["status"] in ("completed", "failed")]
    for t in completed_or_failed:
        tasks_dict.pop(t["task_id"], None)
    tasks_list = [t for t in tasks_list if t["status"] not in ("completed", "failed")]
    return {"status": "success", "message": f"Cleared {len(completed_or_failed)} tasks."}
