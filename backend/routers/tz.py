# backend/routers/tz.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import uuid
import json
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, AsyncGenerator

from backend.schemas.tz_schemas import TZFormRequest, ClarifyResponse
from backend.rag.retriever import search
from backend.agents.writer_agent import stream_stage, stream_draft
from backend.agents.deepseek_critic_agent import critique
from backend.workflows.tz_workflow import run_workflow
from backend.agents.web_standards_agent import resolve_standards_async

router = APIRouter()
logger = logging.getLogger(__name__)


# ─── Вспомогательные функции ────────────────────────────────────────────────

async def _resolve_standards(form: TZFormRequest, context_chunks: list) -> dict:
    """RAG + web: ищет нормативы, возвращает resolved dict."""
    local_found = list({
        c["metadata"].get("standard_id")
        for c in context_chunks
        if c["metadata"].get("standard_id")
    })
    return await resolve_standards_async(
        form=form.model_dump(),
        local_standards=local_found + (form.standards or []),
    )


def _build_form_dict(form: TZFormRequest, resolved: dict) -> dict:
    d = form.model_dump()
    d["resolved_standards"] = resolved["resolved_standards"]
    d["standards_catalog"] = resolved["resolved_items"]
    d["reference_sources"] = resolved["source_links"]
    return d


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ─── Основной 4-этапный генератор ───────────────────────────────────────────

STAGES = [
    {"id": "draft",  "label": "Этап 0 — Черновик",       "critic": False},
    {"id": "refine", "label": "Этап 1 — Доработка",       "critic": True},
    {"id": "verify", "label": "Этап 2 — Верификация",     "critic": True},
    {"id": "final",  "label": "Этап 3 — Финальная версия", "critic": True},
]


async def tz_pipeline_generator(form: TZFormRequest) -> AsyncGenerator[str, None]:
    # 1. RAG-поиск контекста
    query = f"{form.object_type} {form.description} {form.industry or ''}"
    context_chunks = search(query, n_results=10)
    if form.standards:
        for std_id in form.standards:
            extra = search(std_id, n_results=3)
            seen = {c["text"] for c in context_chunks}
            context_chunks += [c for c in extra if c["text"] not in seen]

    # 2. Поиск нормативов (web + RAG)
    yield _sse({"type": "status", "stage": "init", "message": "🔍 Ищу нормативные документы..."})
    resolved = await _resolve_standards(form, context_chunks)
    form_dict = _build_form_dict(form, resolved)

    local_stds = list({
        c["metadata"].get("standard_id")
        for c in context_chunks if c["metadata"].get("standard_id")
    })

    yield _sse({
        "type": "standards_found",
        "local_standards": local_stds,
        "resolved_standards": resolved["resolved_standards"],
        "items": resolved["resolved_items"],
    })
    if resolved["source_links"]:
        yield _sse({"type": "reference_sources", "sources": resolved["source_links"]})

    # 3. Четыре этапа
    current_draft = ""

    for stage_meta in STAGES:
        stage_id = stage_meta["id"]
        stage_label = stage_meta["label"]
        use_critic = stage_meta["critic"]

        # 3a. Критика DeepSeek (кроме этапа 0)
        issues = []
        if use_critic and current_draft:
            yield _sse({
                "type": "status",
                "stage": stage_id,
                "message": f"🤖 DeepSeek анализирует черновик ({stage_label})...",
            })
            issues = await critique(current_draft, stage_id, form_dict)
            if issues:
                yield _sse({
                    "type": "issues",
                    "stage": stage_id,
                    "issues": issues,
                })

        # 3b. GPT-4o пишет/дорабатывает
        yield _sse({
            "type": "stage_start",
            "stage": stage_id,
            "label": stage_label,
            "issues_count": len(issues),
        })

        new_draft_tokens = []
        gen = stream_stage(
            context_chunks=context_chunks,
            form=form_dict,
            issues=issues,
            stage=stage_id,
            previous_draft=current_draft,
        )
        async for token in gen:
            new_draft_tokens.append(token)
            yield _sse({"type": "token", "stage": stage_id, "text": token})

        current_draft = "".join(new_draft_tokens)
        yield _sse({"type": "stage_done", "stage": stage_id, "label": stage_label})

    # 4. Финал
    yield _sse({"type": "done", "draft": current_draft})


@router.post("/generate-tz")
async def generate_tz_streaming(request: TZFormRequest):
    """
    4-этапный SSE-стрим:
      status        — текущее действие
      standards_found — нормативы
      reference_sources — ссылки
      issues        — замечания DeepSeek
      stage_start   — начало этапа {stage, label}
      token         — токен GPT-4o {stage, text}
      stage_done    — этап завершён
      done          — финальный черновик
    """
    return StreamingResponse(
        tz_pipeline_generator(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Старый эндпоинт (совместимость) ────────────────────────────────────────

class LegacyTZRequest(BaseModel):
    title: str
    equipment_type: str
    parameters: str
    requirements: str


@router.post("/generate")
async def generate_tz_legacy(request: LegacyTZRequest):
    try:
        result = run_workflow(request.dict())
        sources = [
            c.get("metadata", {}).get("source")
            for c in result.get("context", [])
            if c.get("metadata", {}).get("source")
        ]
        return {
            "id": str(uuid.uuid4()),
            "status": "draft",
            "content": result.get("final_tz") or result.get("draft", ""),
            "quality_score": result.get("quality_score", 0),
            "sources": list(dict.fromkeys(sources))[:5],
        }
    except Exception as e:
        logger.error(f"Ошибка: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/clarify", response_model=ClarifyResponse)
async def clarify_request(request: TZFormRequest):
    from openai import AsyncOpenAI
    import os
    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    query = f"{request.object_type} {request.description} {request.industry or ''}"
    context_chunks = search(query, n_results=5)
    local_suggested = list({
        c["metadata"].get("standard_id")
        for c in context_chunks if c["metadata"].get("standard_id")
    })
    prompt = f"""Ты помощник по составлению технических заданий.
Пользователь хочет составить ТЗ на: {request.object_type}.
Описание: {request.description}
Параметры: {request.parameters or 'не указаны'}

Задай 3-5 конкретных уточняющих вопроса, ответы на которые критически важны для составления полного ТЗ.
Формат — JSON: {{"questions": ["...", "..."]}}"""
    response = await ai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    try:
        raw = json.loads(response.choices[0].message.content)
        questions = raw.get("questions", [])
    except Exception:
        questions = ["Уточните основные технические требования к объекту."]
    resolved = await resolve_standards_async(form=request.model_dump(), local_standards=local_suggested)
    return ClarifyResponse(
        questions=questions,
        suggested_standards=resolved["resolved_standards"] or local_suggested,
    )


@router.patch("/{tz_id}/approve")
async def approve_tz(tz_id: str):
    return {"status": "approved", "id": tz_id}
