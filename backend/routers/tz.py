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
from backend.agents.writer_agent import stream_draft
from backend.workflows.tz_workflow import run_workflow

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Старый эндпоинт (совместимость) ─────────────────────────────────────────

class LegacyTZRequest(BaseModel):
    title: str
    equipment_type: str
    parameters: str
    requirements: str

@router.post("/generate")
async def generate_tz_legacy(request: LegacyTZRequest):
    """Старый синхронный эндпоинт — оставляем для совместимости."""
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


# ── Новый streaming эндпоинт ─────────────────────────────────────────────────

async def tz_stream_generator(form: TZFormRequest) -> AsyncGenerator[str, None]:
    """
    SSE-генератор: сначала отдаём найденные стандарты,
    затем стримим черновик токен за токеном.
    """
    # 1. RAG-поиск по базе стандартов
    query = f"{form.object_type} {form.description} {form.industry or ''}"
    context_chunks = search(query, n_results=8)

    # Если пользователь указал свои стандарты — добавляем их в метаданные
    # (предполагаем, что в ChromaDB можно фильтровать по standard_id)
    if form.standards:
        for std_id in form.standards:
            extra = search(std_id, n_results=3)
            # дедупликация по тексту
            existing_texts = {c["text"] for c in context_chunks}
            context_chunks += [c for c in extra if c["text"] not in existing_texts]

    # Отдаём список найденных стандартов клиенту
    found_standards = list({
        c["metadata"].get("standard_id")
        for c in context_chunks
        if c["metadata"].get("standard_id")
    })
    yield f"data: {json.dumps({'type': 'standards_found', 'standards': found_standards}, ensure_ascii=False)}\n\n"

    # 2. Стримим генерацию черновика
    form_dict = form.model_dump()
    yield f"data: {json.dumps({'type': 'generation_start'}, ensure_ascii=False)}\n\n"

    async for token in stream_draft(context_chunks, form_dict):
        payload = json.dumps({"type": "token", "text": token}, ensure_ascii=False)
        yield f"data: {payload}\n\n"

    yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"


@router.post("/generate-tz")
async def generate_tz_streaming(request: TZFormRequest):
    """
    Streaming эндпоинт. Возвращает SSE-поток:
      - standards_found: {"type": "standards_found", "standards": [...]}
      - generation_start: {"type": "generation_start"}
      - token: {"type": "token", "text": "..."}
      - done: {"type": "done"}

    Пример curl:
      curl -N -X POST http://localhost:8000/api/tz/generate-tz \\
        -H "Content-Type: application/json" \\
        -d '{"object_type":"насос", "description":"центробежный насос для водоснабжения", "parameters":"Q=50м3/ч, H=40м"}'
    """
    return StreamingResponse(
        tz_stream_generator(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # отключаем буферизацию nginx
        }
    )


# ── Pre-processing: уточняющие вопросы ───────────────────────────────────────

@router.post("/clarify", response_model=ClarifyResponse)
async def clarify_request(request: TZFormRequest):
    """
    Агент задаёт уточняющие вопросы и предлагает стандарты
    до запуска полной генерации.
    """
    from openai import AsyncOpenAI
    import os

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    # RAG для подбора стандартов
    query = f"{request.object_type} {request.description} {request.industry or ''}"
    context_chunks = search(query, n_results=5)
    suggested = list({
        c["metadata"].get("standard_id")
        for c in context_chunks
        if c["metadata"].get("standard_id")
    })

    prompt = f"""Ты помощник по составлению технических заданий. 
Пользователь хочет составить ТЗ на: {request.object_type}.
Описание: {request.description}
Параметры: {request.parameters or "не указаны"}

Задай 3-5 конкретных уточняющих вопроса, ответы на которые критически важны для составления полного ТЗ.
Формат ответа — JSON-список строк. Только JSON, без пояснений.
Пример: ["Вопрос 1?", "Вопрос 2?"]"""

    response = await ai.chat.completions.create(
        model="gpt-4-turbo-preview",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    
    try:
        raw = json.loads(response.choices[0].message.content)
        # GPT может вернуть {"questions": [...]} или просто [...]
        questions = raw if isinstance(raw, list) else raw.get("questions", [])
    except Exception:
        questions = ["Уточните основные технические требования к объекту."]

    return ClarifyResponse(questions=questions, suggested_standards=suggested)


# ── Approve (заглушка из оригинала) ──────────────────────────────────────────

@router.patch("/{tz_id}/approve")
async def approve_tz(tz_id: str):
    # TODO: копировать в library/approved_tz и переиндексировать ChromaDB
    return {"status": "approved", "id": tz_id}
