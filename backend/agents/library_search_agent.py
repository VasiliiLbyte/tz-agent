# backend/agents/library_search_agent.py
"""
Агент поиска документов для библиотеки через Tavily API.
Ищет PDF/DOCX по теме, проверяет дубликаты в ChromaDB, возвращает кандидатов для подтверждения.
"""

import os
import re
import ssl
import logging
import hashlib
from typing import List, Dict, Any
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

TAVILY_URL = "https://api.tavily.com/search"
MAX_RESULTS = 10

PRIORITY_DOMAINS = (
    "docs.cntd.ru",
    "protect.gost.ru",
    "meganorm.ru",
    "internet-law.ru",
    "normdocs.ru",
    "standartgost.ru",
    "gost.ru",
)

DOWNLOAD_PATTERN = re.compile(r'\.pdf|\.docx|\.doc', re.IGNORECASE)

# SSL-контекст без проверки сертификата (нужно для macOS где не установлены корневые сертификаты Python)
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE


def _deduplicate_by_url(candidates: List[Dict]) -> List[Dict]:
    seen = set()
    result = []
    for c in candidates:
        url = c.get("url", "")
        if url and url not in seen:
            seen.add(url)
            result.append(c)
    return result


def _check_already_indexed(filename: str, chroma_collection) -> bool:
    """Проверяет, есть ли файл с таким именем в ChromaDB."""
    try:
        results = chroma_collection.get(
            where={"file_name": filename},
            include=[],
        )
        return len(results.get("ids") or []) > 0
    except Exception:
        return False


async def search_documents_for_library(
    query: str,
    chroma_collection=None,
) -> List[Dict[str, Any]]:
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        logger.warning("TAVILY_API_KEY не задан")
        return []

    enriched_query = f"{query} ГОСТ норматив PDF скачать"

    payload = {
        "api_key": api_key,
        "query": enriched_query,
        "topic": "general",
        "search_depth": "advanced",
        "include_answer": False,
        "include_raw_content": False,
        "max_results": MAX_RESULTS,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
            response = await client.post(TAVILY_URL, json=payload)
            response.raise_for_status()
            results = response.json().get("results", [])
    except Exception as e:
        logger.error(f"Tavily search error: {e}")
        return []

    candidates = []
    for r in results:
        url = r.get("url", "")
        title = r.get("title", "") or url
        snippet = (r.get("content") or "")[:300]
        domain = url.split("/")[2] if url.startswith("http") else ""
        is_pdf = bool(DOWNLOAD_PATTERN.search(url))
        is_priority = any(d in url for d in PRIORITY_DOMAINS)

        if not url:
            continue

        filename = url.split("/")[-1].split("?")[0] or ""
        already_indexed = False
        if chroma_collection and filename:
            already_indexed = _check_already_indexed(filename, chroma_collection)

        score = 0
        if is_pdf:
            score += 3
        if is_priority:
            score += 2
        if any(kw in (title + snippet).lower() for kw in ["гост", "снип", "норм", "стандарт", "требован"]):
            score += 1

        candidates.append({
            "title": title,
            "url": url,
            "snippet": snippet,
            "source_domain": domain,
            "is_direct_pdf": is_pdf,
            "is_priority_source": is_priority,
            "already_indexed": already_indexed,
            "filename": filename,
            "score": score,
        })

    candidates.sort(key=lambda x: x["score"], reverse=True)
    return _deduplicate_by_url(candidates)


async def download_and_index(
    url: str,
    filename: str,
    library_root: Path,
    collection,
    embed_fn,
    chunk_fn,
    extract_fn,
) -> Dict[str, Any]:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".pdf", ".docx", ".txt", ".md"}:
        return {"status": "error", "detail": f"Неподдерживаемый формат: {suffix}"}

    save_path = library_root / filename

    # Скачиваем с отключённой проверкой SSL (решение для macOS)
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, verify=False) as client:
            response = await client.get(url)
            response.raise_for_status()
            content = response.content
    except Exception as e:
        return {"status": "error", "detail": f"Ошибка скачивания: {e}"}

    if len(content) > 20 * 1024 * 1024:
        return {"status": "error", "detail": "Файл превышает 20 МБ"}

    # Проверяем что это действительно файл, а не HTML-страница
    content_type = response.headers.get("content-type", "")
    if "text/html" in content_type and suffix == ".pdf":
        save_path.unlink(missing_ok=True) if save_path.exists() else None
        return {"status": "error", "detail": "Сайт вернул HTML вместо PDF — прямая ссылка недоступна"}

    with open(save_path, "wb") as f:
        f.write(content)

    text = extract_fn(save_path, suffix)
    if not text.strip():
        save_path.unlink(missing_ok=True)
        return {"status": "error", "detail": "Не удалось извлечь текст (файл пустой или защищён паролем)"}

    chunks = chunk_fn(text)
    file_hash = hashlib.md5(content).hexdigest()
    source_path = f"library/uploads/{filename}"

    ids, embeddings, documents, metadatas = [], [], [], []
    for i, chunk in enumerate(chunks):
        chunk_id = f"{file_hash}_{i}"
        try:
            existing = collection.get(ids=[chunk_id])
            if existing["ids"]:
                continue
        except Exception:
            pass
        emb = embed_fn(chunk)
        ids.append(chunk_id)
        embeddings.append(emb)
        documents.append(chunk)
        metadatas.append({
            "source": source_path,
            "file_name": filename,
            "chunk_index": i,
            "total_chunks": len(chunks),
            "origin_url": url,
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
        "filename": filename,
        "chunks_added": len(ids),
        "chunks_total": len(chunks),
        "size_kb": round(len(content) / 1024, 1),
    }
