#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import uuid
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from backend.workflows.tz_workflow import run_workflow

router = APIRouter()
logger = logging.getLogger(__name__)

class TZRequest(BaseModel):
    title: str
    equipment_type: str
    parameters: str
    requirements: str

class TZResponse(BaseModel):
    id: str
    status: str
    content: str
    quality_score: int
    issues_resolved: int
    sources: List[str]

@router.post("/generate", response_model=TZResponse)
async def generate_tz(request: TZRequest):
    """
    Генерирует ТЗ на основе входных данных.
    """
    try:
        # Запускаем workflow
        input_data = request.dict()
        result = run_workflow(input_data)
        
        # Формируем ответ
        tz_id = str(uuid.uuid4())
        # Извлекаем источники (можно из context)
        sources = []
        context = result.get("context", [])
        for chunk in context:
            src = chunk.get("metadata", {}).get("source")
            if src and src not in sources:
                sources.append(src)
        
        return TZResponse(
            id=tz_id,
            status="draft",
            content=result.get("final_tz") or result.get("draft", ""),
            quality_score=result.get("quality_score", 0),
            issues_resolved=len(result.get("issues", [])),
            sources=sources[:5]  # ограничим пятью
        )
    except Exception as e:
        logger.error(f"Ошибка при генерации ТЗ: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/{tz_id}/approve")
async def approve_tz(tz_id: str):
    """
    Одобряет ТЗ и добавляет его в библиотеку approved_tz.
    (Заглушка, требует реализации копирования файла и переиндексации)
    """
    # TODO: реализовать копирование в library/approved_tz и переиндексацию
    return {"status": "approved", "id": tz_id}
