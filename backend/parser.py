import os
import sys
import uuid
import json
import base64
import asyncio
import concurrent.futures
import logging
from pathlib import Path
import fitz  # PyMuPDF
import docx
import requests
import litellm


from pageindex.page_index import tree_parser
from pageindex.page_index_md import md_to_tree
from pageindex.utils import ConfigLoader, write_node_id, generate_summaries_for_structure, JsonLogger, add_node_text, sanitize_filename
from backend.provider import get_active_provider, get_vlm_provider, active_chat_provider
from backend.shared import get_shared_client, STORAGE_DIR, get_images_dir

logger = logging.getLogger(__name__)


def _call_vlm(img_path):
    """Sends image to the active VLM provider and retrieves layout transcription."""
    provider = get_vlm_provider()
    
    if not provider.use_vlm or not provider.model_name:
        logger.info("VLM not configured or disabled, skipping visual layout call.")
        return None
        
    try:
        with open(img_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode("utf-8")
            
        vlm_model = provider.model_name
        
        if provider.provider_type == "ollama":
            url = f"{provider.api_base.rstrip('/')}/api/chat"
            payload = {
                "model": vlm_model,
                "messages": [
                    {
                        "role": "user",
                        "content": "You are a document structure extractor. Transcribe this page into structured Markdown for building a document outline tree. Rules: 1. Preserve ALL headings/titles EXACTLY as they appear. Use # ## ### for hierarchy. 2. Transcribe body text faithfully under each heading. Do NOT summarize. 3. For images, describe briefly in brackets [Image: description]. 4. Maintain reading order. No meta-commentary. Output structured content directly.",
                        "images": [img_b64]
                    }
                ],
                "stream": False,
                "options": {"temperature": 0}
            }
            res = requests.post(url, json=payload, timeout=90)
            if res.status_code == 200:
                return res.json()["message"]["content"]
                
        else:
            # Xinference or OpenAI via LiteLLM
            data_uri = f"data:image/png;base64,{img_b64}"
            # Ensure model has correct prefix
            model_name = vlm_model
            if provider.provider_type == "xinference":
                model_uid = model_name.split("/")[-1]
                model_name = f"openai/{model_uid}"
                api_base = provider.api_base
                if not api_base.endswith("/v1") and not api_base.endswith("/v1/"):
                    api_base = f"{api_base.rstrip('/')}/v1"
            else:
                if not model_name.startswith("openai/"):
                    model_name = f"openai/{model_name}"
                api_base = provider.api_base

            res = litellm.completion(
                model=model_name,
                api_base=api_base,
                api_key=provider.api_key or "empty",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "You are a document structure extractor. Transcribe this page into structured Markdown for building a document outline tree. Rules: 1. Preserve ALL headings/titles EXACTLY as they appear. Use # ## ### for hierarchy. 2. Transcribe body text faithfully under each heading. Do NOT summarize. 3. For images, describe briefly in brackets [Image: description]. 4. Maintain reading order. No meta-commentary. Output structured content directly."},
                            {"type": "image_url", "image_url": {"url": data_uri}}
                        ]
                    }
                ],
                temperature=0
            )
            return res.choices[0].message.content
            
    except Exception as e:
        logger.error(f"VLM call failed: {e}", exc_info=True)
    return None

def parse_docx(file_path):
    """Converts DOCX paragraphs to Markdown preserving headings."""
    doc_name = os.path.basename(file_path)
    doc = docx.Document(file_path)
    content = []
    for p in doc.paragraphs:
        text = p.text.strip()
        if not text:
            continue
        style = p.style.name.lower()
        if style.startswith("heading 1"):
            content.append(f"# {text}")
        elif style.startswith("heading 2"):
            content.append(f"## {text}")
        elif style.startswith("heading 3"):
            content.append(f"### {text}")
        else:
            content.append(text)
    return f"# {doc_name}\n\n" + "\n\n".join(content)

async def parse_image(file_path, doc_id):
    """Parses a standalone image file using VLM description."""
    doc_name = os.path.basename(file_path)
    ext = os.path.splitext(file_path)[1].lower()
    
    # Save the original image in our storage under its folder
    doc_folder = get_images_dir() / sanitize_filename(doc_name)
    doc_folder.mkdir(parents=True, exist_ok=True)
    cached_img_path = doc_folder / f"{doc_id}_1.png"
    # Convert/copy to png
    import shutil
    shutil.copy(file_path, cached_img_path)
    
    # Generate description using VLM
    description = await asyncio.to_thread(_call_vlm, cached_img_path)
    if not description:
        description = f"Image document: {doc_name}. No multi-modal VLM response was available to describe its contents."
        
    pages = [{"page": 1, "content": description}]
    
    # Structure for 1 page
    structure = [{
        "title": "Document Image Summary",
        "node_id": "0001",
        "start_index": 1,
        "end_index": 1,
        "summary": description[:200] + "..." if len(description) > 200 else description,
        "text": description,
        "nodes": []
    }]
    
    return pages, structure

async def parse_pdf_hybrid(file_path, doc_id):
    """Performs hybrid text/visual PDF parsing."""
    pages = []
    
    doc_name = os.path.basename(file_path)
    doc_folder = get_images_dir() / sanitize_filename(doc_name)
    doc_folder.mkdir(parents=True, exist_ok=True)
    
    with fitz.open(file_path) as doc:
        for i in range(len(doc)):
            page_num = i + 1
            page = doc[i]
            
            # Check text content and images
            raw_text = page.get_text().strip()
            image_list = page.get_images()
            
            page_text = ""
            cached_img_path = doc_folder / f"{doc_id}_{page_num}.png"
            
            # Scanned page or contains images/charts
            if not raw_text or len(image_list) > 0:
                # Render page to PNG for VLM and frontend viewer
                pix = page.get_pixmap(dpi=150)
                pix.save(str(cached_img_path))
                
                # VLM call
                vlm_text = await asyncio.to_thread(_call_vlm, cached_img_path)
                
                if vlm_text:
                    # VLM output is well-structured (respects visual layout),
                    # so use it as primary content for better tree_parser recognition.
                    # Append raw_text as supplementary reference if available.
                    if raw_text:
                        page_text = vlm_text + "\n\n### [Raw Text Layer (Supplementary Reference)]\n" + raw_text
                    else:
                        page_text = vlm_text
                elif raw_text:
                    page_text = raw_text
                else:
                    page_text = f"[Scanned page {page_num} contains no extractable digital text]"
            else:
                # Just extract text
                page_text = raw_text
                # Render to image anyway for frontend right-panel original page viewing
                pix = page.get_pixmap(dpi=150)
                pix.save(str(cached_img_path))
                
            pages.append({"page": page_num, "content": page_text})
        
    return pages

async def index_document(file_path, workspace_path=None):
    """Indexes any supported file and registers it in the PageIndexClient workspace."""
    file_path = os.path.abspath(os.path.expanduser(file_path))
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
        
    doc_id = str(uuid.uuid4())
    ext = os.path.splitext(file_path)[1].lower()
    doc_name = os.path.basename(file_path)
    
    client = get_shared_client()
    
    # Determine which LLM model to use for PageIndex operations (tree parsing, summaries, etc.)
    # Prefer VLM provider when enabled (e.g. local ollama), fall back to Chat provider
    vlm = get_vlm_provider()
    if vlm.use_vlm and vlm.model_name:
        provider = vlm
    else:
        provider = get_active_provider()
    logger.info(f"Using LLM for indexing: {provider.provider_type}/{provider.model_name}")
    
    # 1. Parse content based on file type
    if ext == ".pdf":
        logger.info(f"Parsing PDF: {file_path}")
        pages = await parse_pdf_hybrid(file_path, doc_id)
        
        # Build PageIndex page_list format: (text, token_length)
        from pageindex.utils import count_tokens
        page_list = []
        for p in pages:
            t = p["content"]
            page_list.append((t, count_tokens(t, model=provider.model_name)))
            
        # Build structural tree using PageIndex modules
        opt = ConfigLoader().load({"model": provider.model_name})
        pi_logger = JsonLogger(file_path)
        
        # Run tree parser
        structure = await tree_parser(page_list, opt, doc=file_path, logger=pi_logger)
        write_node_id(structure)
        add_node_text(structure, page_list)
        # Add node summaries
        await generate_summaries_for_structure(structure, model=opt.model)
            
        client.documents[doc_id] = {
            'id': doc_id,
            'type': 'pdf',
            'path': file_path,
            'doc_name': doc_name,
            'doc_description': f"PageIndex parsed PDF: {doc_name}",
            'page_count': len(pages),
            'structure': structure,
            'pages': pages,
        }
        
    elif ext in [".png", ".jpg", ".jpeg"]:
        logger.info(f"Parsing Image: {file_path}")
        pages, structure = await parse_image(file_path, doc_id)
        
        client.documents[doc_id] = {
            'id': doc_id,
            'type': 'pdf',  # Indexed as page-based doc for uniform UI inspector display
            'path': file_path,
            'doc_name': doc_name,
            'doc_description': f"Image content: {doc_name}",
            'page_count': 1,
            'structure': structure,
            'pages': pages,
        }
        
    elif ext in [".md", ".markdown", ".txt", ".docx"]:
        logger.info(f"Parsing Text: {file_path}")
        
        # Convert to md if txt or docx
        if ext == ".docx":
            md_content = parse_docx(file_path)
            # Write to temp md file
            temp_md_path = STORAGE_DIR / f"{doc_id}_temp.md"
            with open(temp_md_path, "w", encoding="utf-8") as f:
                f.write(md_content)
            parse_target = str(temp_md_path)
        elif ext == ".txt":
            with open(file_path, "r", encoding="utf-8") as f:
                txt_content = f.read()
            md_content = f"# {doc_name}\n\n{txt_content}"
            temp_md_path = STORAGE_DIR / f"{doc_id}_temp.md"
            with open(temp_md_path, "w", encoding="utf-8") as f:
                f.write(md_content)
            parse_target = str(temp_md_path)
        else:
            parse_target = file_path
            
        # Parse Markdown structure
        result = await md_to_tree(
            md_path=parse_target,
            if_thinning=False,
            if_add_node_summary='yes',
            summary_token_threshold=200,
            model=provider.model_name,
            if_add_doc_description='yes',
            if_add_node_text='yes',
            if_add_node_id='yes'
        )
            
        # Clean up temp files
        if ext in [".docx", ".txt"]:
            try:
                os.remove(parse_target)
            except:
                pass
                
        client.documents[doc_id] = {
            'id': doc_id,
            'type': 'md',
            'path': file_path,
            'doc_name': doc_name,
            'doc_description': result.get('doc_description', ''),
            'line_count': result.get('line_count', 0),
            'structure': result['structure'],
        }
    else:
        raise ValueError(f"Unsupported file format: {ext}")
        
    # Persist document in PageIndex client workspace
    client._save_doc(doc_id)
    return doc_id
