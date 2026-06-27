"""
Chat routes — RAG chat streaming endpoint.
"""

import logging
import json
import datetime
import asyncio
import uuid
from typing import Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from backend.rag import execute_rag_flow_stream
from backend.shared import notebook_id_var, active_chat_signals
from backend.routes.conversations import append_messages_to_active

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])



class ChatPayload(BaseModel):
    doc_ids: Optional[List[str]] = None
    doc_id: Optional[str] = None
    query: str
    force_search: bool = False
    session_id: Optional[str] = None


@router.post("/chat/stop")
async def stop_chat(session_id: str):
    """Gracefully set the cancellation signal event for a specific chat session."""
    if session_id in active_chat_signals:
        active_chat_signals[session_id].set()
        logger.info(f"Set cancel event for chat session: {session_id}")
        return {"status": "success", "message": f"Stop signal sent for session {session_id}."}
    return {"status": "success", "message": f"No active chat session found for {session_id}."}


async def chat_wrapper_generator(notebook_id, session_id, generator):
    assistant_content = ""
    status_steps = []
    sources = []
    fallback = False
    stats = None
    completed = False
    
    start_time = datetime.datetime.now()
    first_token_time = None
    
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
                elif data.get("type") == "delta":
                    if first_token_time is None:
                        first_token_time = datetime.datetime.now()
                    assistant_content += data.get("content")
                elif data.get("type") == "result":
                    completed = True
                    sources = data.get("sources", [])
                    fallback = data.get("fallback", False)
                    stats = data.get("stats")
                elif data.get("type") == "error":
                    status_steps.append(f"Error: {data.get('content')}")
            except Exception:
                pass
    finally:
        # If stream terminated before final result chunk (e.g. client disconnected), calculate partial stats
        if not completed:
            end_time = datetime.datetime.now()
            duration_sec = (end_time - start_time).total_seconds()
            
            # Estimate tokens generated so far
            try:
                from pageindex.utils import count_tokens
                completion_tokens = count_tokens(assistant_content) if assistant_content else 0
            except Exception:
                completion_tokens = len(assistant_content) // 4 if assistant_content else 0
                
            stats = {
                "prompt_tokens": 0,
                "completion_tokens": completion_tokens,
                "total_tokens": completion_tokens,
                "generation_time_sec": round(duration_sec, 2),
                "speed_tok_per_sec": round(completion_tokens / duration_sec, 1) if duration_sec > 0 else 0,
                "time_to_first_token_sec": round((first_token_time - start_time).total_seconds(), 2) if first_token_time else None,
                "stopped_by_user": True
            }
            
        # Save assistant message on completion
        assistant_msg = {
            "role": "assistant",
            "content": assistant_content,
            "status_steps": status_steps,
            "sources": sources,
            "fallback": fallback,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "stats": stats
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
    session_id = payload.session_id or f"session-{uuid.uuid4()}"
    
    # Register cancellation event for this session
    cancel_event = asyncio.Event()
    active_chat_signals[session_id] = cancel_event
    
    # 1. Save user query immediately so it's not lost
    user_msg = {
        "role": "user",
        "content": payload.query,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    append_messages_to_active(notebook_id, [user_msg])
    
    # 2. Execute RAG flow and return stream wrapped to save response at the end
    async def stream_with_cleanup():
        try:
            generator = execute_rag_flow_stream(doc_ids, payload.query, payload.force_search, session_id=session_id)
            async for chunk in chat_wrapper_generator(notebook_id, session_id, generator):
                yield chunk
        finally:
            # Clean up active signal
            active_chat_signals.pop(session_id, None)
            
    return StreamingResponse(stream_with_cleanup(), media_type="text/event-stream")
