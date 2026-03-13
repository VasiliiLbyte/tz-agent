# backend/routers/library.py
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import os
import hashlib
import logging
from typing import List

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

import chromadb
from chromadb.config import Settings
from openai import OpenAI, APITimeoutError, APIConnectionError, RateLimitError

from backend.agents.library_search_agent import (
    search_documents_for_library,
    download_and_index,
)

logger = logging.getLogger(__name__)
router = APIRouter()

PROJECT_ROOT = Path(__file__).parent.parent.parent
LIBRARY_ROOT = PROJECT_ROOT / "library" / "uploads"
TEXT_CACHE_DIR = PROJECT_ROOT / "library" / "text_cache"
CHROMA_DB_PATH = PROJECT_ROOT / "chroma_db"
COLLECTION_NAME = "tz_library"
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}
MAX_FILE_SIZE_MB = 20

LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)
TEXT_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def get_chroma_collection():
    client = chromadb.PersistentClient(
        path=str(CHROMA_DB_PATH),
        settings=Settings(anonymized_telemetry=False),
    )
    try:
        return client.get_collection(COLLECTION_NAME)
    except Exception:
        return client.create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )


def embed_text(text: str, max_retries: int = 5) -> List[float]:
    """
    Создаёт эмбеддинг через OpenAI.
    При таймауте/ошибке сети — повторяет с exponential backoff: 5→ 10 → 20 → 40 → 60 сек.
    """
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout=60.0,  # увеличенный таймаут
    )
    delays = [5, 10, 20, 40, 60]
    last_exc = None
    for attempt in range(max_retries):
        try:
            response = client.embeddings.create(
                model="text-embedding-3-small",
                input=text[:8000],
            )
            return response.data[0].embedding
        except (APITimeoutError, APIConnectionError) as e:
            wait = delays[min(attempt, len(delays) - 1)]
            logger.warning(f"embed_text: попытка {attempt+1}/{max_retries} не удалась ({type(e).__name__}), жду {wait}с...")
            last_exc = e
            time.sleep(wait)
        except RateLimitError as e:
            wait = delays[min(attempt, len(delays) - 1)]
            logger.warning(f"embed_text: rate limit, жду {wait}с...")
            last_exc = e
            time.sleep(wait)
        except Exception as e:
            # Неизвестная ошибка — не ретраим
            raise
    raise RuntimeError(f"Не удалось получить эмбеддинг после {max_retries} попыток: {last_exc}")


def chunk_text(text: str, chunk_size: int = 800, overlap: int = 150) -> List[str]:
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = " ".join(words[i:i + chunk_size])
        chunks.append(chunk)
        i += chunk_size - overlap
    return chunks


def _correct_ocr_text(raw_text: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return raw_text
    client = OpenAI(api_key=api_key, timeout=60.0)
    CHUNK_SIZE = 3000
    parts = [raw_text[i:i + CHUNK_SIZE] for i in range(0, len(raw_text), CHUNK_SIZE)]
    corrected_parts = []
    SYSTEM_PROMPT = (
        "Ты помощник по обработке OCR-текста русских нормативных документов (ГОСТы, СНИПы, ТУ). "
        "Исправь артефакты OCR: слипшиеся буквы, неправильно разобранные слова, лишние символы, "
        "неправильная пунктуация. Не добавляй и не удаляй содержательную информацию. Верни только исправленный текст."
    )
    logger.info(f"GPT OCR correction: {len(parts)} частей...")
    for i, part in enumerate(parts):
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": part}],
                temperature=0.1, max_tokens=4096,
            )
            corrected_parts.append(response.choices[0].message.content or part)
        except Exception as e:
            logger.warning(f"GPT correction ошибка часть {i+1}: {e}")
            corrected_parts.append(part)
    return "\n".join(corrected_parts)


def _ocr_pdf(file_path: Path) -> str:
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        logger.error("pytesseract или pdf2image не установлены")
        return ""
    try:
        logger.info(f"OCR: {file_path.name}")
        images = convert_from_path(str(file_path), dpi=200)
        raw = "\n".join(pytesseract.image_to_string(img, lang="rus+eng") for img in images)
        logger.info(f"OCR: {len(raw)} симв. Запуск GPT-коррекции...")
        return _correct_ocr_text(raw)
    except Exception as e:
        logger.error(f"OCR ошибка: {e}")
        return ""


def _save_text_cache(filename: str, text: str):
    (TEXT_CACHE_DIR / (filename + ".txt")).write_text(text, encoding="utf-8")


def _load_text_cache(filename: str):
    p = TEXT_CACHE_DIR / (filename + ".txt")
    return p.read_text(encoding="utf-8") if p.exists() else None


def extract_text(file_path: Path, suffix: str) -> str:
    if suffix in (".txt", ".md"):
        return file_path.read_text(encoding="utf-8", errors="ignore")
    elif suffix == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(str(file_path)) as pdf:
                text = "\n".join(p.extract_text() or "" for p in pdf.pages).strip()
            if text:
                return text
        except Exception as e:
            logger.warning(f"pdfplumber: {e}")
        return _ocr_pdf(file_path)
    elif suffix == ".docx":
        try:
            from docx import Document
            return "\n".join(p.text for p in Document(str(file_path)).paragraphs)
        except Exception as e:
            logger.error(f"docx: {e}")
    return ""


def extract_and_cache(file_path: Path, suffix: str, filename: str) -> str:
    text = extract_text(file_path, suffix)
    if text.strip():
        _save_text_cache(filename, text)
    return text


# ── Schemas ─────────────────────────────────────────────────

class DocumentInfo(BaseModel):
    filename: str
    size_kb: float
    chunks: int
    source: str

class ChunkPreview(BaseModel):
    chunk_index: int
    text: str
    source: str

class SearchRequest(BaseModel):
    query: str

class SearchCandidate(BaseModel):
    title: str
    url: str
    snippet: str
    source_domain: str
    is_direct_pdf: bool
    is_priority_source: bool
    already_indexed: bool
    filename: str
    score: int
    relevance_pct: int

class ApproveRequest(BaseModel):
    url: str
    filename: str


# ── Upload ───────────────────────────────────────────────

@router.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Неподдерживаемый формат. Допустимые: {', '.join(SUPPORTED_EXTENSIONS)}")
    content = await file.read()
    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"Файл превышает {MAX_FILE_SIZE_MB} МБ")
    save_path = LIBRARY_ROOT / file.filename
    with open(save_path, "wb") as f:
        f.write(content)
    text = extract_and_cache(save_path, suffix, file.filename)
    if not text.strip():
        save_path.unlink(missing_ok=True)
        raise HTTPException(422, "Не удалось извлечь текст")
    chunks = chunk_text(text)
    collection = get_chroma_collection()
    file_hash = hashlib.md5(content).hexdigest()
    source_path = f"library/uploads/{file.filename}"
    ids, embeddings, documents, metadatas = [], [], [], []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{file_hash}_{i}"
        try:
            if collection.get(ids=[chunk_id])["ids"]:
                continue
        except Exception:
            pass
        ids.append(chunk_id)
        embeddings.append(embed_text(chunk))
        documents.append(chunk)
        metadatas.append({"source": source_path, "file_name": file.filename, "chunk_index": i, "total_chunks": len(chunks)})
    if ids:
        collection.add(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
    return {"status": "indexed", "filename": file.filename, "chunks_added": len(ids), "chunks_total": len(chunks), "size_kb": round(len(content)/1024, 1)}


# ── Documents ───────────────────────────────────────────────

@router.get("/documents", response_model=List[DocumentInfo])
def list_documents():
    collection = get_chroma_collection()
    try:
        all_items = collection.get(include=["metadatas"])
    except Exception:
        return []
    files: dict = {}
    for meta in (all_items.get("metadatas") or []):
        fn = meta.get("file_name", "?")
        if fn not in files:
            files[fn] = {"filename": fn, "source": meta.get("source", ""), "chunks": 0}
        files[fn]["chunks"] += 1
    result = []
    for fn, info in files.items():
        fp = LIBRARY_ROOT / fn
        result.append(DocumentInfo(filename=fn, size_kb=round(fp.stat().st_size/1024, 1) if fp.exists() else 0, chunks=info["chunks"], source=info["source"]))
    return result


@router.get("/preview", response_model=List[ChunkPreview])
def preview_chunks(filename: str, limit: int = 5):
    collection = get_chroma_collection()
    try:
        results = collection.get(where={"file_name": filename}, include=["documents", "metadatas"])
    except Exception as e:
        raise HTTPException(500, str(e))
    chunks = []
    for i, (doc, meta) in enumerate(zip(results.get("documents") or [], results.get("metadatas") or [])):
        if i >= limit: break
        chunks.append(ChunkPreview(chunk_index=meta.get("chunk_index", i), text=doc[:400], source=meta.get("source", "")))
    return chunks


@router.get("/text")
def get_full_text(filename: str):
    cached = _load_text_cache(filename)
    if cached:
        return {"filename": filename, "text": cached, "from_cache": True}
    fp = LIBRARY_ROOT / filename
    if not fp.exists():
        raise HTTPException(404, "Файл не найден")
    text = extract_and_cache(fp, Path(filename).suffix.lower(), filename)
    if not text.strip():
        raise HTTPException(422, "Не удалось извлечь текст")
    return {"filename": filename, "text": text, "from_cache": False}


@router.delete("/documents/{filename}")
def delete_document(filename: str):
    collection = get_chroma_collection()
    try:
        results = collection.get(where={"file_name": filename}, include=[])
        ids = results.get("ids") or []
        if ids: collection.delete(ids=ids)
    except Exception as e:
        raise HTTPException(500, str(e))
    for p in [LIBRARY_ROOT / filename, TEXT_CACHE_DIR / (filename + ".txt")]:
        if p.exists(): p.unlink()
    return {"status": "deleted", "filename": filename, "chunks_removed": len(ids)}


# ── Search & Approve ───────────────────────────────────────────

@router.post("/search", response_model=List[SearchCandidate])
async def search_documents(req: SearchRequest):
    if not req.query.strip():
        raise HTTPException(400, "Запрос не может быть пустым")
    collection = get_chroma_collection()
    candidates = await search_documents_for_library(query=req.query, chroma_collection=collection)
    if not candidates:
        raise HTTPException(404, "Ничего не найдено.")
    return [SearchCandidate(**{k: c[k] for k in SearchCandidate.model_fields}) for c in candidates]


@router.post("/approve")
async def approve_document(req: ApproveRequest):
    if not req.url.startswith("http"):
        raise HTTPException(400, "Некорректный URL")
    filename = req.filename or req.url.split("/")[-1].split("?")[0] or "document.pdf"
    if "." not in filename: filename = "document.pdf"
    result = await download_and_index(
        url=req.url, filename=filename, library_root=LIBRARY_ROOT,
        collection=get_chroma_collection(), embed_fn=embed_text,
        chunk_fn=chunk_text, extract_fn=lambda p, s: extract_and_cache(p, s, filename),
    )
    if result.get("status") == "error":
        raise HTTPException(422, result["detail"])
    return result
