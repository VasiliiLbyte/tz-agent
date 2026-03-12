#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import re
import logging
from typing import Any, Dict, List

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

TAVILY_URL = "https://api.tavily.com/search"
MAX_RESULTS_PER_QUERY = 6

STANDARD_PATTERNS = [
    re.compile(r"\bГОСТ(?:\s+Р|\s+IEC|\s+ISO|\s+МЭК)?\s+\d+(?:\.\d+)*(?:-\d{2,4})?\b", re.IGNORECASE),
    re.compile(r"\bСП\s+\d+(?:\.\d+)*(?:-\d{2,4})?\b", re.IGNORECASE),
    re.compile(r"\bСНиП\s+[0-9A-Za-zА-Яа-я.\- ]+\b", re.IGNORECASE),
    re.compile(r"\bПУЭ\b", re.IGNORECASE),
    re.compile(r"\bТР\s+ТС\s+\d+/\d{4}\b", re.IGNORECASE),
]

PRIORITY_DOMAINS = (
    "protect.gost.ru",
    "docs.cntd.ru",
    "internet-law.ru",
    "meganorm.ru",
    "normdocs.ru",
)

def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())

def _unique(items: List[str]) -> List[str]:
    seen = set()
    result = []
    for item in items:
        value = _clean(item)
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result

def _base_object(form: Dict[str, Any]) -> str:
    return form.get("object_type") or form.get("equipment_type") or ""

def _base_description(form: Dict[str, Any]) -> str:
    return form.get("description") or form.get("title") or ""

def _keywords(form: Dict[str, Any]) -> List[str]:
    text = " ".join([
        _base_object(form),
        _base_description(form),
        form.get("industry", ""),
        form.get("parameters", ""),
        form.get("extra_requirements") or form.get("requirements", ""),
    ])
    words = re.findall(r"[A-Za-zА-Яа-я0-9]+", text.lower())
    stop = {
        "для", "при", "или", "это", "как", "что", "под", "над", "без", "the",
        "and", "with", "городского", "городской", "система", "системы"
    }
    return [w for w in words if len(w) > 2 and w not in stop]

def build_queries(form: Dict[str, Any]) -> List[str]:
    object_type = _base_object(form)
    description = _base_description(form)
    industry = form.get("industry", "")
    parameters = form.get("parameters", "")

    queries = [
        f"ГОСТ {object_type} {industry}",
        f"нормативные документы {object_type} {description}",
        f"требования безопасности {object_type} {industry}",
        f"технические требования {object_type} {parameters}",
    ]
    return _unique(queries)

def extract_standard_ids(text: str) -> List[str]:
    cleaned = _clean(text)
    found: List[str] = []
    for pattern in STANDARD_PATTERNS:
        for match in pattern.findall(cleaned):
            std = _clean(str(match)).upper()
            found.append(std)
    return _unique(found)

def _score_candidate(std_id: str, text: str, url: str, form: Dict[str, Any]) -> int:
    score = 1
    haystack = f"{text} {url}".lower()

    for kw in _keywords(form):
        if kw in haystack:
            score += 1

    if std_id.upper() in text.upper():
        score += 2

    if any(domain in url for domain in PRIORITY_DOMAINS):
        score += 2

    return score

def _reason(std_id: str, form: Dict[str, Any], snippets: List[str]) -> str:
    object_type = _base_object(form) or "объекта"
    industry = form.get("industry") or "отрасли"
    snippet = _clean(snippets[0])[:220] if snippets else ""
    if snippet:
        return (
            f"{std_id} найден по веб-результатам для '{object_type}' в контексте '{industry}'. "
            f"Опорный фрагмент: {snippet}"
        )
    return f"{std_id} найден по веб-результатам для '{object_type}' в контексте '{industry}'."

async def _tavily_search_async(query: str) -> List[Dict[str, Any]]:
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        logger.warning("TAVILY_API_KEY не задан")
        return []

    payload = {
        "api_key": api_key,
        "query": query,
        "topic": "general",
        "search_depth": "advanced",
        "include_answer": False,
        "include_raw_content": True,
        "max_results": MAX_RESULTS_PER_QUERY,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(TAVILY_URL, json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("results", [])

def _tavily_search_sync(query: str) -> List[Dict[str, Any]]:
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        logger.warning("TAVILY_API_KEY не задан")
        return []

    payload = {
        "api_key": api_key,
        "query": query,
        "topic": "general",
        "search_depth": "advanced",
        "include_answer": False,
        "include_raw_content": True,
        "max_results": MAX_RESULTS_PER_QUERY,
    }

    with httpx.Client(timeout=30.0) as client:
        response = client.post(TAVILY_URL, json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get("results", [])

def _merge_results(
    form: Dict[str, Any],
    local_standards: List[str],
    batches: List[Dict[str, Any]],
) -> Dict[str, Any]:
    candidates: Dict[str, Dict[str, Any]] = {}

    for batch in batches:
        query = batch["query"]
        for result in batch["results"]:
            title = result.get("title", "")
            content = result.get("content", "")
            raw_content = (result.get("raw_content") or "")[:4000]
            url = result.get("url", "")

            merged_text = _clean(" ".join([title, content, raw_content]))
            if not merged_text:
                continue

            std_ids = extract_standard_ids(merged_text)
            for std_id in std_ids:
                item = candidates.setdefault(std_id, {
                    "standard_id": std_id,
                    "score": 0,
                    "mentions": 0,
                    "queries": [],
                    "snippets": [],
                    "sources": [],
                })

                item["score"] += _score_candidate(std_id, merged_text, url, form)
                item["mentions"] += 1
                item["queries"].append(query)

                snippet = _clean(content or raw_content or title)[:350]
                if snippet:
                    item["snippets"].append(snippet)

                item["sources"].append({
                    "title": title or std_id,
                    "url": url,
                    "query": query,
                })

    for std_id in local_standards or []:
        item = candidates.setdefault(std_id, {
            "standard_id": std_id,
            "score": 0,
            "mentions": 0,
            "queries": [],
            "snippets": [],
            "sources": [],
        })
        item["score"] += 8
        item["mentions"] += 1
        item["queries"].append("internal_rag")
        item["snippets"].append("Найден во внутренней базе стандартов проекта.")
        item["sources"].append({
            "title": "Внутренняя база стандартов",
            "url": "",
            "query": "internal_rag",
        })

    ranked = sorted(
        candidates.values(),
        key=lambda x: (x["score"], x["mentions"], len(x["sources"])),
        reverse=True
    )

    resolved_items = []
    source_links = []

    for item in ranked[:12]:
        sources = []
        seen_urls = set()
        for src in item["sources"]:
            url = src.get("url", "")
            key = (src.get("title", ""), url)
            if key in seen_urls:
                continue
            seen_urls.add(key)
            sources.append(src)
            if url:
                source_links.append({
                    "title": src.get("title", item["standard_id"]),
                    "url": url,
                    "standard_id": item["standard_id"],
                })

        resolved_items.append({
            "standard_id": item["standard_id"],
            "score": item["score"],
            "mentions": item["mentions"],
            "queries": _unique(item["queries"]),
            "reason": _reason(item["standard_id"], form, item["snippets"]),
            "sources": sources[:5],
            "evidence": _unique(item["snippets"])[:3],
        })

    unique_source_links = []
    seen_links = set()
    for src in source_links:
        key = (src["standard_id"], src["url"])
        if src["url"] and key not in seen_links:
            seen_links.add(key)
            unique_source_links.append(src)

    return {
        "queries": [b["query"] for b in batches],
        "resolved_standards": [x["standard_id"] for x in resolved_items],
        "resolved_items": resolved_items,
        "source_links": unique_source_links[:20],
    }

async def resolve_standards_async(
    form: Dict[str, Any],
    local_standards: List[str] | None = None,
) -> Dict[str, Any]:
    queries = build_queries(form)
    batches = []

    for query in queries:
        try:
            results = await _tavily_search_async(query)
            batches.append({"query": query, "results": results})
        except Exception as e:
            logger.warning("Tavily async search failed for '%s': %s", query, e)
            batches.append({"query": query, "results": []})

    return _merge_results(form, local_standards or [], batches)

def resolve_standards_sync(
    form: Dict[str, Any],
    local_standards: List[str] | None = None,
) -> Dict[str, Any]:
    queries = build_queries(form)
    batches = []

    for query in queries:
        try:
            results = _tavily_search_sync(query)
            batches.append({"query": query, "results": results})
        except Exception as e:
            logger.warning("Tavily sync search failed for '%s': %s", query, e)
            batches.append({"query": query, "results": []})

    return _merge_results(form, local_standards or [], batches)

