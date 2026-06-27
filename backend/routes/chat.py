"""
Chat routes — RAG chat streaming endpoint.
"""

import logging
import json
import datetime
from typing import Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.rag import execute_rag_flow_stream
from backend.shared import notebook_id_var
from backend.routes.conversations import append_messages_to_active

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])


class ChatPayload(BaseModel):
    doc_ids: Optional[List[str]] = None
    doc_id: Optional[str] = None
    query: str
    force_search: bool = False


async def chat_wrapper_generator(notebook_id, generator):
    assistant_content = ""
    status_steps = []
    sources = []
    fallback = False
    
    try:
        async for chunk in generator:
            yield chunk
            
            # Parse chunk line to accumulate content
            try:
                line = chunk.strip()
                if not line:
                    continue
                data = json.loads(line)
                if data.get("type") == "status":
                    status_steps.append(data.get("content"))
                  # Note: delta content is already in raw string format
                elif data.get("type") == "delta":
                    assistant_content += data.get("content")
                elif data.get("type") == "result":
                    sources = data.get("sources", [])
                    fallback = data.get("fallback", False)
                elif data.get("type") == "error":
                    status_steps.append(f"Error: {data.get('content')}")
            except Exception:
                pass
    finally:
        # Save assistant message on completion
        assistant_msg = {
            "role": "assistant",
            "content": assistant_content,
            "status_steps": status_steps,
            "sources": sources,
            "fallback": fallback,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        append_messages_to_active(notebook_id, [assistant_msg])


@router.post("/chat")
async def chat_query(payload: ChatPayload):
    doc_ids = payload.doc_ids
    if not doc_ids and payload.doc_id:
        doc_ids = [payload.doc_id]
    if not doc_ids:
        raise HTTPException(status_code=400, detail="No documents selected for chat.")
        
    notebook_id = notebook_id_var.get()
    
    # 1. Save user query immediately so it's not lost
    user_msg = {
        "role": "user",
        "content": payload.query,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    append_messages_to_active(notebook_id, [user_msg])
    
    # 2. Execute RAG flow and return stream wrapped to save response at the end
    generator = execute_rag_flow_stream(doc_ids, payload.query, payload.force_search)
    wrapped = chat_wrapper_generator(notebook_id, generator)
    return StreamingResponse(wrapped, media_type="text/event-stream")
