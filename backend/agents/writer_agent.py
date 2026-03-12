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
    "3. Нормативные документы и основания применения",
    "4. Технические характеристики и параметры",
    "5. Требования к объекту",
    "6. Требования к надёжности, безопасности и эксплуатации",
    "7. Требования к документации",
    "8. Порядок приёмки, испытаний и контроля",
    "9. Источники разработки и использованные материалы",
]

def build_standards_block(form: Dict[str, Any]) -> str:
    user_standards = form.get("standards") or []
    resolved_standards = form.get("resolved_standards") or []
    standards_catalog = form.get("standards_catalog") or []
    reference_sources = form.get("reference_sources") or []

    lines = []

    if user_standards:
        lines.append("Стандарты, указанные пользователем:")
        for std in user_standards:
            lines.append(f"- {std}")

    if resolved_standards:
        lines.append("Стандарты, найденные автоматически:")
        for std in resolved_standards:
            lines.append(f"- {std}")

    if standards_catalog:
        lines.append("Основания выбора нормативов:")
        for item in standards_catalog[:10]:
            lines.append(f"- {item['standard_id']}: {item.get('reason', 'основание не указано')}")

    if reference_sources:
        lines.append("Ссылки на найденные источники:")
        for src in reference_sources[:10]:
            title = src.get("title") or src.get("standard_id") or "источник"
            url = src.get("url") or ""
            std = src.get("standard_id") or "без идентификатора"
            if url:
                lines.append(f"- {std}: {title} — {url}")

    return "\n".join(lines) if lines else "Автоматически подобранные нормативы отсутствуют."

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

    issues_block = ""
    if issues:
        issues_block = "\n\nЗАМЕЧАНИЯ к предыдущей версии (исправь обязательно):\n"
        issues_block += "\n".join(f"  - {i}" for i in issues)

    standards_block = build_standards_block(form)
    sections = "\n".join(DEFAULT_SECTIONS)

    return f"""Ты ведущий инженер-проектировщик и специалист по техническим заданиям.

Составь качественный черновик ТЗ на русском языке в официально-техническом стиле.

ЖЁСТКИЕ ПРАВИЛА:
1. Не выдумывай номера стандартов, пункты стандартов и технические параметры.
2. Используй локальный контекст как основную техническую базу.
3. Используй веб-стандарты только если они логично относятся к объекту, отрасли или требованиям.
4. Если применимость стандарта неочевидна, укажи: «требуется верификация применимости».
5. В разделе нормативных документов указывай не просто перечень, а почему документ релевантен объекту.
6. Если данных недостаточно, прямо пиши «Требуется уточнение».
7. Не используй маркетинговые формулировки, только инженерный стиль.
8. В конце раздела 9 перечисли, какие источники использованы при подготовке черновика.

КОНТЕКСТ ИЗ ВНУТРЕННЕЙ БАЗЫ:
{context_text or "Контекст не найден. Используй только данные пользователя и аккуратные общие формулировки."}

ПОДОБРАННЫЕ НОРМАТИВЫ И ВЕБ-ОСНОВАНИЯ:
{standards_block}

ДАННЫЕ ОТ ПОЛЬЗОВАТЕЛЯ:
- Тип объекта: {form.get("object_type") or form.get("equipment_type", "не указан")}
- Описание: {form.get("description") or form.get("title", "не указано")}
- Технические параметры: {form.get("parameters", "не указаны")}
- Отрасль: {form.get("industry", "не указана")}
- Дополнительные требования: {form.get("extra_requirements") or form.get("requirements", "отсутствуют")}
{issues_block}

Структура ТЗ:
{sections}

Дополнительно:
- В разделе 3 раздели документы на «обязательно применимые» и «предварительно применимые (требуется верификация)», если уверенности недостаточно.
- В разделе 4 и 5 по возможности привязывай требования к найденным нормативам.
- Каждый раздел начинай с новой строки и заголовка.
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
    "resolved_standards": state.get("resolved_standards", []),
    "standards_catalog": state.get("standards_catalog", []),
    "reference_sources": state.get("reference_sources", []),
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
