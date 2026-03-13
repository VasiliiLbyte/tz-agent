# backend/routers/library.py
import sys
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
from openai import OpenAI

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


def embed_text(text: str) -> List[float]:
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8000],
    )
    return response.data[0].embedding


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
    """
    Прогоняет OCR-текст через GPT-4o-mini для исправления артефактов сканирования.
    Обрабатывает частями по 3000 символов чтобы не превышать лимит контекстного окна.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return raw_text

    client = OpenAI(api_key=api_key)
    CHUNK_SIZE = 3000
    parts = [raw_text[i:i + CHUNK_SIZE] for i in range(0, len(raw_text), CHUNK_SIZE)]
    corrected_parts = []

    SYSTEM_PROMPT = (
        "Ты помощник по обработке OCR-текста русских нормативных документов (ГОСТы, СНИПы, ТУ). "
        "Исправь артефакты OCR: слипшиеся буквы, неправильно разобранные слова, лишние символы, "
        "неправильная пунктуация. Не добавляй и не удаляй содержательную информацию, "
        "только исправляй очевидные ошибки OCR. Верни только исправленный текст без пояснений."
    )

    logger.info(f"GPT OCR correction: {len(parts)} частей...")
    for i, part in enumerate(parts):
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": part},
                ],
                temperature=0.1,
                max_tokens=4096,
            )
            corrected_parts.append(response.choices[0].message.content or part)
            logger.debug(f"GPT correction: часть {i+1}/{len(parts)} готова")
        except Exception as e:
            logger.warning(f"GPT correction ошибка для части {i+1}: {e}, оставляю оригинал")
            corrected_parts.append(part)

    return "\n".join(corrected_parts)


def _ocr_pdf(file_path: Path) -> str:
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        logger.error("pytesseract или pdf2image не установлены. Запустите: pip install pytesseract pdf2image")
        return ""
    try:
        logger.info(f"OCR: обрабатываю файл {file_path.name}")
        images = convert_from_path(str(file_path), dpi=200)
        pages_text = []
        for i, img in enumerate(images):
            text = pytesseract.image_to_string(img, lang="rus+eng")
            pages_text.append(text)
            logger.debug(f"OCR: страница {i+1}/{len(images)} ({len(text)} символов)")
        raw = "\n".join(pages_text)
        logger.info(f"OCR: завершено, {len(raw)} символов. Запускаем GPT-коррекцию...")
        corrected = _correct_ocr_text(raw)
        logger.info(f"GPT-коррекция завершена, {len(corrected)} символов")
        return corrected
    except Exception as e:
        logger.error(f"OCR ошибка: {e}")
        return ""


def _save_text_cache(filename: str, text: str):
    """Cохраняет извлечённый текст в кэш для просмотра в UI."""
    cache_path = TEXT_CACHE_DIR / (filename + ".txt")
    cache_path.write_text(text, encoding="utf-8")


def _load_text_cache(filename: str) -> str | None:
    """Cчитывает кэш текста, если есть."""
    cache_path = TEXT_CACHE_DIR / (filename + ".txt")
    if cache_path.exists():
        return cache_path.read_text(encoding="utf-8")
    return None


def extract_text(file_path: Path, suffix: str) -> str:
    if suffix in (".txt", ".md"):
        return file_path.read_text(encoding="utf-8", errors="ignore")
    elif suffix == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(str(file_path)) as pdf:
                pages = [page.extract_text() or "" for page in pdf.pages]
                text = "\n".join(pages).strip()
            if text:
                logger.info(f"pdfplumber: {len(text)} символов из {file_path.name}")
                return text
        except Exception as e:
            logger.warning(f"pdfplumber не справился: {e}")
        logger.info(f"pdfplumber: текст пустой, запускаем OCR для {file_path.name}")
        return _ocr_pdf(file_path)
    elif suffix == ".docx":
        try:
            from docx import Document
            doc = Document(str(file_path))
            return "\n".join(p.text for p in doc.paragraphs)
        except Exception as e:
            logger.error(f"docx ошибка: {e}")
            return ""
    return ""


def extract_and_cache(file_path: Path, suffix: str, filename: str) -> str:
    """extract_text + сохранение в кэш для просмотра в UI."""
    text = extract_text(file_path, suffix)
    if text.strip():
        _save_text_cache(filename, text)
    return text


# ── Schemas ─────────────────────────────────────────────────────────

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

class ApproveRequest(BaseModel):
    url: str
    filename: str


# ── Upload ─────────────────────────────────────────────────────────

@router.post("/upload", summary="Загрузить документ в библиотеку")
async def upload_document(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Неподдерживаемый формат. Допустимые: {', '.join(SUPPORTED_EXTENSIONS)}")

    save_path = LIBRARY_ROOT / file.filename
    content = await file.read()

    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"Файл превышает {MAX_FILE_SIZE_MB} МБ")

    with open(save_path, "wb") as f:
        f.write(content)

    text = extract_and_cache(save_path, suffix, file.filename)
    if not text.strip():
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Не удалось извлечь текст (даже OCR не помог)")

    chunks = chunk_text(text)
    collection = get_chroma_collection()
    file_hash = hashlib.md5(content).hexdigest()
    source_path = f"library/uploads/{file.filename}"

    ids, embeddings, documents, metadatas = [], [], [], []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{file_hash}_{i}"
        try:
            existing = collection.get(ids=[chunk_id])
            if existing["ids"]:
                continue
        except Exception:
            pass
        emb = embed_text(chunk)
        ids.append(chunk_id)
        embeddings.append(emb)
        documents.append(chunk)
        metadatas.append({"source": source_path, "file_name": file.filename, "chunk_index": i, "total_chunks": len(chunks)})

    if ids:
        collection.add(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)

    return {"status": "indexed", "filename": file.filename, "chunks_added": len(ids), "chunks_total": len(chunks), "size_kb": round(len(content) / 1024, 1)}


# ── Documents ──────────────────────────────────────────────────────

@router.get("/documents", response_model=List[DocumentInfo], summary="Список документов")
def list_documents():
    collection = get_chroma_collection()
    try:
        all_items = collection.get(include=["metadatas"])
    except Exception:
        return []

    files: dict = {}
    for meta in (all_items.get("metadatas") or []):
        fn = meta.get("file_name", "неизвестно")
        src = meta.get("source", "")
        if fn not in files:
            files[fn] = {"filename": fn, "source": src, "chunks": 0}
        files[fn]["chunks"] += 1

    result = []
    for fn, info in files.items():
        file_path = LIBRARY_ROOT / fn
        size_kb = round(file_path.stat().st_size / 1024, 1) if file_path.exists() else 0
        result.append(DocumentInfo(filename=fn, size_kb=size_kb, chunks=info["chunks"], source=info["source"]))
    return result


@router.get("/preview", response_model=List[ChunkPreview], summary="Превью чанков")
def preview_chunks(filename: str, limit: int = 5):
    collection = get_chroma_collection()
    try:
        results = collection.get(where={"file_name": filename}, include=["documents", "metadatas"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    chunks = []
    for i, (doc, meta) in enumerate(zip(results.get("documents") or [], results.get("metadatas") or [])):
        if i >= limit:
            break
        chunks.append(ChunkPreview(chunk_index=meta.get("chunk_index", i), text=doc[:400], source=meta.get("source", "")))
    return chunks


@router.get("/text", summary="Полный извлечённый текст документа")
def get_full_text(filename: str):
    """Возвращает полный текст документа из кэша или извлекает налету если кэш пуст."""
    # Сначала пробуем кэш
    cached = _load_text_cache(filename)
    if cached:
        return {"filename": filename, "text": cached, "from_cache": True}

    # Если кэша нет — извлекаем из файла
    file_path = LIBRARY_ROOT / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден")

    suffix = Path(filename).suffix.lower()
    text = extract_and_cache(file_path, suffix, filename)
    if not text.strip():
        raise HTTPException(status_code=422, detail="Не удалось извлечь текст")

    return {"filename": filename, "text": text, "from_cache": False}


@router.delete("/documents/{filename}", summary="Удалить документ")
def delete_document(filename: str):
    collection = get_chroma_collection()
    try:
        results = collection.get(where={"file_name": filename}, include=[])
        ids = results.get("ids") or []
        if ids:
            collection.delete(ids=ids)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    for path in [LIBRARY_ROOT / filename, TEXT_CACHE_DIR / (filename + ".txt")]:
        if path.exists():
            path.unlink()

    return {"status": "deleted", "filename": filename, "chunks_removed": len(ids)}


# ── Search & Approve ─────────────────────────────────────────────────

@router.post("/search", response_model=List[SearchCandidate], summary="Поиск документов через Tavily")
async def search_documents(req: SearchRequest):
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Запрос не может быть пустым")
    collection = get_chroma_collection()
    candidates = await search_documents_for_library(query=req.query, chroma_collection=collection)
    if not candidates:
        raise HTTPException(status_code=404, detail="Ничего не найдено.")
    return [SearchCandidate(**{k: c[k] for k in SearchCandidate.model_fields}) for c in candidates]


@router.post("/approve", summary="Скачать и проиндексировать документ")
async def approve_document(req: ApproveRequest):
    if not req.url.startswith("http"):
        raise HTTPException(status_code=400, detail="Некорректный URL")
    filename = req.filename or req.url.split("/")[-1].split("?")[0] or "document.pdf"
    if "." not in filename:
        filename = "document.pdf"
    result = await download_and_index(
        url=req.url, filename=filename, library_root=LIBRARY_ROOT,
        collection=get_chroma_collection(), embed_fn=embed_text,
        chunk_fn=chunk_text, extract_fn=lambda p, s: extract_and_cache(p, s, filename),
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=422, detail=result["detail"])
    return result
