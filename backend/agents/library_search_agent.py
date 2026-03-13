# backend/agents/library_search_agent.py
"""
Агент поиска документов для библиотеки через Tavily API.
Дедупликация по номеру ГОСТ/СНиП, возвращает релевантность в %.
"""

import os
import re
import ssl
import logging
import hashlib
from typing import List, Dict, Any, Optional
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

TAVILY_URL = "https://api.tavily.com/search"
MAX_RESULTS = 15  # Запрашиваем больше, чтобы после дедупликации осталось достаточно

PRIORITY_DOMAINS = (
    "docs.cntd.ru",
    "protect.gost.ru",
    "meganorm.ru",
    "internet-law.ru",
    "normdocs.ru",
    "standartgost.ru",
    "gost.ru",
    "infosait.ru",
    "files.stroyinf.ru",
    "gostrf.com",
)

DOWNLOAD_PATTERN = re.compile(r'\.pdf|\.docx|\.doc', re.IGNORECASE)

# Паттерн для извлечения номера ГОСТ/СНиП/СП из текста
DOC_NUMBER_PATTERN = re.compile(
    r'(?:гост|snip|снип|sp|сп|tu|ту)[\s\-]*(\d+[\.\-]\d+(?:[\.\-]\d+)*)',
    re.IGNORECASE
)


def _extract_doc_number(text: str) -> Optional[str]:
    """Извлекает номер документа (напр. '18142.1-85') из заголовка/URL."""
    m = DOC_NUMBER_PATTERN.search(text)
    if m:
        return re.sub(r'[\s]', '', m.group(1)).lower()
    # Также проверяем просто числовые паттерны в URL
    num = re.search(r'(\d{4,}[\.\-]\d+[\.\-]?\d*)', text)
    if num:
        return re.sub(r'[\s]', '', num.group(1)).lower()
    return None


def _compute_relevance(query: str, title: str, snippet: str, is_pdf: bool, is_priority: bool, tavily_score: float) -> int:
    """
    Вычисляет релевантность в диапазоне 0–100%.

    Компоненты:
    - tavily_score (0–1.0)  → до 50 баллов (релевантность по мнению Tavily)
    - Прямой PDF                → +20
    - Приоритетный домен     → +15
    - Ключевые слова запроса   → до +15 (3 балла за слово)
    """
    score = int(tavily_score * 50)

    if is_pdf:
        score += 20
    if is_priority:
        score += 15

    # Ключевые слова из запроса в title+snippet
    query_words = set(re.findall(r'\w{3,}', query.lower()))
    combined = (title + " " + snippet).lower()
    hits = sum(1 for w in query_words if w in combined)
    score += min(hits * 3, 15)

    return min(score, 100)


def _deduplicate_by_doc_number(candidates: List[Dict]) -> List[Dict]:
    """
    Дедупликация по номеру документа:
    - Если два результата ссылаются на один и тот же ГОСТ (18142.1-85) — оставляем только тот
      что с наибольшей релевантностью (процентом).
    - Даже если номер не распознан — также дедуплицируем по URL.
    """
    seen_numbers: Dict[str, Dict] = {}  # doc_number -> best candidate
    seen_urls: set = set()
    no_number: List[Dict] = []

    for c in candidates:
        url = c.get("url", "")
        if url in seen_urls:
            continue
        seen_urls.add(url)

        doc_num = _extract_doc_number(c["title"] + " " + url)
        if doc_num:
            existing = seen_numbers.get(doc_num)
            if existing is None or c["relevance_pct"] > existing["relevance_pct"]:
                seen_numbers[doc_num] = c
        else:
            no_number.append(c)

    # Собираем: лучшие по номерам + без номера
    result = list(seen_numbers.values()) + no_number
    result.sort(key=lambda x: x["relevance_pct"], reverse=True)
    return result


def _check_already_indexed(filename: str, chroma_collection) -> bool:
    try:
        results = chroma_collection.get(where={"file_name": filename}, include=[])
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
            data = response.json()
            results = data.get("results", [])
    except Exception as e:
        logger.error(f"Tavily search error: {e}")
        return []

    candidates = []
    for r in results:
        url = r.get("url", "")
        if not url:
            continue
        title = r.get("title", "") or url
        snippet = (r.get("content") or "")[:300]
        domain = url.split("/")[2] if url.startswith("http") else ""
        is_pdf = bool(DOWNLOAD_PATTERN.search(url))
        is_priority = any(d in url for d in PRIORITY_DOMAINS)
        tavily_score = float(r.get("score", 0) or 0)

        filename = url.split("/")[-1].split("?")[0] or ""
        already_indexed = False
        if chroma_collection and filename:
            already_indexed = _check_already_indexed(filename, chroma_collection)

        relevance_pct = _compute_relevance(query, title, snippet, is_pdf, is_priority, tavily_score)

        candidates.append({
            "title": title,
            "url": url,
            "snippet": snippet,
            "source_domain": domain,
            "is_direct_pdf": is_pdf,
            "is_priority_source": is_priority,
            "already_indexed": already_indexed,
            "filename": filename,
            "score": relevance_pct,  # обратная совместимость
            "relevance_pct": relevance_pct,
        })

    # Дедупликация по номеру документа
    return _deduplicate_by_doc_number(candidates)


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

    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, verify=False) as client:
            response = await client.get(url)
            response.raise_for_status()
            content = response.content
    except Exception as e:
        return {"status": "error", "detail": f"Ошибка скачивания: {e}"}

    if len(content) > 20 * 1024 * 1024:
        return {"status": "error", "detail": "Файл превышает 20 МБ"}

    content_type = response.headers.get("content-type", "")
    if "text/html" in content_type and suffix == ".pdf":
        return {"status": "error", "detail": "Сайт вернул HTML вместо PDF — прямая ссылка недоступна"}

    with open(save_path, "wb") as f:
        f.write(content)

    text = extract_fn(save_path, suffix)
    if not text.strip():
        save_path.unlink(missing_ok=True)
        return {"status": "error", "detail": "Не удалось извлечь текст"}

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
        collection.add(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)

    return {
        "status": "indexed",
        "filename": filename,
        "chunks_added": len(ids),
        "chunks_total": len(chunks),
        "size_kb": round(len(content) / 1024, 1),
    }
