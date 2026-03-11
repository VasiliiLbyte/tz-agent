#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import os
import logging
from typing import Dict, Any, List, AsyncGenerator

from openai import AsyncOpenAI, OpenAI
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

MODEL = "gpt-4-turbo-preview"

DEFAULT_SECTIONS = [
    "1. Общие сведения об объекте",
    "2. Назначение и цели",
    "3. Технические характеристики и параметры",
    "4. Требования к объекту",
    "5. Требования к надёжности и безопасности",
    "6. Требования к документации",
    "7. Порядок приёмки и контроля",
    "8. Источники разработки",
]


def build_universal_prompt(
    context_chunks: List[Dict[str, Any]],
    form: Dict[str, Any],
    issues: List[str] = None,
) -> str:
    context_text = ""
    for i, chunk in enumerate(context_chunks, 1):
        src = chunk["metadata"].get("source", "неизвестно")
        std = chunk["metadata"].get("standard_id", "")
        context_text += f"\n--- [{i}] {src} {f'({std})' if std else ''} ---\n{chunk['text']}\n"

    user_standards = form.get("standards") or []
    rag_standards = list({
        c["metadata"].get("standard_id")
        for c in context_chunks
        if c["metadata"].get("standard_id")
    })
    all_standards = user_standards or rag_standards
    standards_line = (
        "Применимые стандарты: " + ", ".join(all_standards)
        if all_standards
        else "Применимые стандарты: определяются по контексту"
    )

    issues_block = ""
    if issues:
        issues_block = "\n\nЗАМЕЧАНИЯ к предыдущей версии (исправь обязательно):\n"
        issues_block += "\n".join(f"  - {i}" for i in issues)

    sections = "\n".join(DEFAULT_SECTIONS)

    return f"""Ты эксперт по техническим заданиям. Составь черновик ТЗ, используя ТОЛЬКО информацию из предоставленного контекста стандартов. Если данных недостаточно — пиши «Требуется уточнение».

КОНТЕКСТ ИЗ БАЗЫ СТАНДАРТОВ:
{context_text or "Контекст не найден. Используй общие принципы составления ТЗ."}

ДАННЫЕ ОТ ПОЛЬЗОВАТЕЛЯ:
- Тип объекта: {form.get("object_type") or form.get("equipment_type", "не указан")}
- Описание: {form.get("description") or form.get("title", "не указано")}
- Технические параметры: {form.get("parameters", "не указаны")}
- Отрасль: {form.get("industry", "не указана")}
- Дополнительные требования: {form.get("extra_requirements") or form.get("requirements", "отсутствуют")}
- {standards_line}
{issues_block}

Структура ТЗ (разделы):
{sections}

Пиши на русском, техническим стилем. Каждый раздел начинай с новой строки и заголовка.
"""


async def stream_draft(
    context_chunks: List[Dict[str, Any]],
    form: Dict[str, Any],
    issues: List[str] = None,
) -> AsyncGenerator[str, None]:
    client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    prompt = build_universal_prompt(context_chunks, form, issues)
    try:
        stream = await client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Ты эксперт по техническим заданиям."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=4000,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as e:
        logger.error(f"Ошибка стриминга: {e}")
        yield f"\n\n[ОШИБКА ГЕНЕРАЦИИ: {e}]"




def writer_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Синхронный node для LangGraph workflow — обратная совместимость."""
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    # Поддержка как старых ключей (equipment_type/title), так и новых (object_type/description)
    form = {
        "object_type": state.get("object_type") or state.get("equipment_type", ""),
        "description": state.get("description") or state.get("title", ""),
        "parameters": state.get("parameters", ""),
        "standards": state.get("standards", []),
        "industry": state.get("industry", ""),
        "extra_requirements": state.get("extra_requirements") or state.get("requirements", ""),
    }

    prompt = build_universal_prompt(state.get("context", []), form, state.get("issues"))
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Ты эксперт по техническим заданиям."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
        max_tokens=4000,
    )
    state["draft"] = response.choices[0].message.content
    state["issues"] = []
    return state


if __name__ == "__main__":
    from backend.rag.retriever import search
    test_form = {
        "object_type": "насос центробежный",
        "description": "насос для систем водоснабжения",
        "parameters": "Q=50 м3/ч, H=40 м",
        "requirements": "",
    }
    ctx = search(f"{test_form['object_type']} {test_form['description']}", n_results=5)
    import asyncio

    async def _test():
        async for token in stream_draft(ctx, test_form):
            print(token, end="", flush=True)

    asyncio.run(_test())
