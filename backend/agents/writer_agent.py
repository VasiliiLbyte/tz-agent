#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
writer_agent.py — GPT-4o пишет/дорабатывает ТЗ.
Используется на всех 4 этапах; при наличии issues — встраивает их в промпт.
"""
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

MODEL = "gpt-4o"

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
    lines = []
    user_standards = form.get("standards") or []
    resolved_standards = form.get("resolved_standards") or []
    standards_catalog = form.get("standards_catalog") or []
    reference_sources = form.get("reference_sources") or []

    if user_standards:
        lines.append("Стандарты, указанные пользователем:")
        for std in user_standards:
            lines.append(f"  - {std}")
    if resolved_standards:
        lines.append("Стандарты, найденные автоматически:")
        for std in resolved_standards:
            lines.append(f"  - {std}")
    if standards_catalog:
        lines.append("Основания выбора нормативов:")
        for item in standards_catalog[:10]:
            lines.append(f"  - {item['standard_id']}: {item.get('reason', '—')}")
    if reference_sources:
        lines.append("Источники (URL):")
        for src in reference_sources[:10]:
            url = src.get("url", "")
            std = src.get("standard_id", "—")
            title = src.get("title", "")
            if url:
                lines.append(f"  - {std}: {title} — {url}")
    return "\n".join(lines) if lines else "Нормативы не найдены — использовать только данные пользователя."


STAGE_INSTRUCTIONS = {
    "draft": """Ты составляешь ЧЕРНОВИК технического задания.
Заполни все разделы структуры. Там где данных нет — пиши «Требуется уточнение заказчиком».
Реквизиты (заказчик, исполнитель, номер договора, дата, сроки, стадия разработки) — ОБЯЗАТЕЛЬНО оставляй пустыми в формате: _______________
Не выдумывай названия организаций, номера договоров и даты.""",

    "refine": """Ты ДОРАБАТЫВАЕШЬ черновик ТЗ на основе замечаний.
Требования:
- Углубляй технические разделы: добавляй конкретные цифры, допуски, условия эксплуатации
- Расширяй таблицы параметров
- Каждый раздел — минимум 6-8 конкретных пунктов с цифрами
- Реквизиты (заказчик, договор, даты) — НЕ трогай, оставляй _______________
- Не сокращай то, что уже хорошо написано""",

    "verify": """Ты ВЕРИФИЦИРУЕШЬ нормативный блок ТЗ и устраняешь пробелы.
Требования:
- Исправь все ошибки в нормативных ссылках (устаревшие → актуальные)
- Добавь пропущенные обязательные документы
- Убери нерелевантные стандарты
- Дополни разделы 6 и 8 согласно замечаниям
- Реквизиты — НЕ трогай, оставляй _______________""",

    "final": """Ты выполняешь ФИНАЛЬНУЮ редактуру ТЗ.
Требования:
- Устрани все противоречия между разделами
- Приведи терминологию к единообразию
- Все внутренние ссылки на нормативы должны совпадать с разделом 3
- Убери маркетинговые и общие фразы, замени инженерными формулировками
- Реквизиты — НЕ трогай, оставляй _______________
- Это финальный документ — он должен быть полным и готовым к использованию""",
}


def build_prompt(
    context_chunks: List[Dict[str, Any]],
    form: Dict[str, Any],
    issues: List[str],
    stage: str,
    previous_draft: str = "",
) -> str:
    context_text = ""
    for i, chunk in enumerate(context_chunks, 1):
        src = chunk["metadata"].get("source", "неизвестно")
        std = chunk["metadata"].get("standard_id", "")
        context_text += f"\n--- [{i}] {src}{f' ({std})' if std else ''} ---\n{chunk['text']}\n"

    issues_block = ""
    if issues:
        issues_block = "\n\n=== ЗАМЕЧАНИЯ ДЛЯ ИСПРАВЛЕНИЯ (от DeepSeek) ===\n"
        issues_block += "\n".join(f"  {i+1}. {issue}" for i, issue in enumerate(issues))
        issues_block += "\n=== КОНЕЦ ЗАМЕЧАНИЙ ===\n"

    previous_block = ""
    if previous_draft:
        previous_block = f"\n\n=== ПРЕДЫДУЩАЯ ВЕРСИЯ ТЗ (дорабатывай её, не пиши с нуля) ===\n{previous_draft}\n=== КОНЕЦ ПРЕДЫДУЩЕЙ ВЕРСИИ ===\n"

    stage_instr = STAGE_INSTRUCTIONS.get(stage, STAGE_INSTRUCTIONS["draft"])
    standards_block = build_standards_block(form)
    sections = "\n".join(f"  {s}" for s in DEFAULT_SECTIONS)

    return f"""ЗАДАЧА ЭТАПА:
{stage_instr}

ЖЁСТКИЕ ПРАВИЛА (для всех этапов):
1. НЕ выдумывай номера стандартов — используй только те, что в блоке нормативов или контексте.
2. НЕ выдумывай технические параметры, которых нет в данных пользователя.
3. Реквизиты (заказчик, исполнитель, № договора, дата, сроки) — ВСЕГДА оставляй: _______________
4. Если данных недостаточно — пиши «Требуется уточнение заказчиком», не придумывай.
5. Стиль — официально-технический, без маркетинга.
6. Каждый раздел — минимум 5 конкретных подпунктов.

КОНТЕКСТ ИЗ БИБЛИОТЕКИ ДОКУМЕНТОВ:
{context_text or '(контекст не найден)'}

ПОДОБРАННЫЕ НОРМАТИВЫ:
{standards_block}

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ:
  - Тип объекта: {form.get('object_type', '—')}
  - Описание: {form.get('description', '—')}
  - Технические параметры: {form.get('parameters') or '—'}
  - Отрасль: {form.get('industry') or '—'}
  - Доп. требования: {form.get('extra_requirements') or '—'}
{previous_block}{issues_block}
СТРУКТУРА ТЗ:
{sections}
"""


async def stream_stage(
    context_chunks: List[Dict[str, Any]],
    form: Dict[str, Any],
    issues: List[str] = None,
    stage: str = "draft",
    previous_draft: str = "",
) -> AsyncGenerator[str, None]:
    """Стримит токены GPT-4o для указанного этапа."""
    client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"), timeout=120.0)
    prompt = build_prompt(context_chunks, form, issues or [], stage, previous_draft)
    try:
        stream = await client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Ты ведущий инженер-проектировщик, эксперт по техническим заданиям."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.25,
            max_tokens=6000,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as e:
        logger.error(f"stream_stage [{stage}] error: {e}")
        yield f"\n\n[ОШИБКА ГЕНЕРАЦИИ: {e}]"


# обратная совместимость со старым кодом
async def stream_draft(
    context_chunks: List[Dict[str, Any]],
    form: Dict[str, Any],
    issues: List[str] = None,
) -> AsyncGenerator[str, None]:
    async for token in stream_stage(context_chunks, form, issues, stage="draft"):
        yield token


def writer_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """Синхронный node для LangGraph workflow."""
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
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
    prompt = build_prompt(state.get("context", []), form, state.get("issues", []), stage="draft")
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Ты ведущий инженер-проектировщик, эксперт по техническим заданиям."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.25,
        max_tokens=6000,
    )
    state["draft"] = response.choices[0].message.content
    state["issues"] = []
    return state
