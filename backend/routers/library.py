# backend/routers/library.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import os
import shutil
import hashlib
import logging
from typing import List

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

import chromadb
from chromadb.config import Settings
from openai import OpenAI

logger = logging.getLogger(__name__)
router = APIRouter()

PROJECT_ROOT = Path(__file__).parent.parent.parent
LIBRARY_ROOT = PROJECT_ROOT / "library" / "uploads"
CHROMA_DB_PATH = PROJECT_ROOT / "chroma_db"
COLLECTION_NAME = "tz_library"
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}
MAX_FILE_SIZE_MB = 20

LIBRARY_ROOT.mkdir(parents=True, exist_ok=True)


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


def extract_text(file_path: Path, suffix: str) -> str:
    if suffix == ".txt" or suffix == ".md":
        return file_path.read_text(encoding="utf-8", errors="ignore")
    elif suffix == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(str(file_path)) as pdf:
                return "\n".join(
                    page.extract_text() or "" for page in pdf.pages
                )
        except Exception as e:
            logger.error(f"pdfplumber error: {e}")
            return ""
    elif suffix == ".docx":
        try:
            from docx import Document
            doc = Document(str(file_path))
            return "\n".join(p.text for p in doc.paragraphs)
        except Exception as e:
            logger.error(f"docx error: {e}")
            return ""
    return ""


class DocumentInfo(BaseModel):
    filename: str
    size_kb: float
    chunks: int
    source: str


class ChunkPreview(BaseModel):
    chunk_index: int
    text: str
    source: str


@router.post("/upload", summary="Загрузить документ в библиотеку")
async def upload_document(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Неподдерживаемый формат. Допустимые: {', '.join(SUPPORTED_EXTENSIONS)}"
        )

    # Сохраняем файл
    save_path = LIBRARY_ROOT / file.filename
    content = await file.read()

    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"Файл превышает {MAX_FILE_SIZE_MB} МБ")

    with open(save_path, "wb") as f:
        f.write(content)

    # Извлекаем текст
    text = extract_text(save_path, suffix)
    if not text.strip():
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Не удалось извлечь текст из файла")

    # Разбиваем на чанки
    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=422, detail="Файл не содержит текста")

    # Индексируем в ChromaDB
    collection = get_chroma_collection()
    file_hash = hashlib.md5(content).hexdigest()
    source_path = f"library/uploads/{file.filename}"

    ids, embeddings, documents, metadatas = [], [], [], []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{file_hash}_{i}"
        # Пропускаем если уже есть
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
        metadatas.append({
            "source": source_path,
            "file_name": file.filename,
            "chunk_index": i,
            "total_chunks": len(chunks),
        })

    if ids:
        collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )

    return {
        "status": "indexed",
        "filename": file.filename,
        "chunks_added": len(ids),
        "chunks_total": len(chunks),
        "size_kb": round(len(content) / 1024, 1),
    }


@router.get("/documents", response_model=List[DocumentInfo], summary="Список документов в библиотеке")
def list_documents():
    collection = get_chroma_collection()
    try:
        all_items = collection.get(include=["metadatas"])
    except Exception:
        return []

    # Группируем чанки по файлам
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
        result.append(DocumentInfo(
            filename=fn,
            size_kb=size_kb,
            chunks=info["chunks"],
            source=info["source"],
        ))
    return result


@router.get("/preview", response_model=List[ChunkPreview], summary="Превью чанков файла")
def preview_chunks(filename: str, limit: int = 5):
    collection = get_chroma_collection()
    try:
        results = collection.get(
            where={"file_name": filename},
            include=["documents", "metadatas"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    chunks = []
    docs = results.get("documents") or []
    metas = results.get("metadatas") or []
    for i, (doc, meta) in enumerate(zip(docs, metas)):
        if i >= limit:
            break
        chunks.append(ChunkPreview(
            chunk_index=meta.get("chunk_index", i),
            text=doc[:400],
            source=meta.get("source", ""),
        ))
    return chunks


@router.delete("/documents/{filename}", summary="Удалить документ из библиотеки")
def delete_document(filename: str):
    collection = get_chroma_collection()

    # Находим все id чанков этого файла
    try:
        results = collection.get(where={"file_name": filename}, include=[])
        ids = results.get("ids") or []
        if ids:
            collection.delete(ids=ids)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Удаляем физический файл
    file_path = LIBRARY_ROOT / filename
    if file_path.exists():
        file_path.unlink()

    return {"status": "deleted", "filename": filename, "chunks_removed": len(ids)}
