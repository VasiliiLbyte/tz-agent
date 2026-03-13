# backend/agents/deepseek_critic_agent.py
"""
DeepSeek-агент-критик.
Принимает черновик ТЗ и возвращает структурированный список замечаний.
Использует DeepSeek Reasoner (deepseek-reasoner) через OpenAI-совместимый API.
"""
import os
import logging
from typing import List, Dict, Any
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-reasoner"


def _get_client() -> AsyncOpenAI:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY не задан в .env")
    return AsyncOpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL)


STAGE_PROMPTS: Dict[str, str] = {
    "refine": """Ты — старший инженер-проектировщик. Твоя задача — УГЛУБИТЬ технические разделы ТЗ.

Проанализируй черновик и выдай список конкретных замечаний в формате:
- Каждое замечание начинается с номера раздела (например «Раздел 4:»)
- Указывай что именно не хватает: конкретные параметры, допуски, условия
- Если в разделе общие фразы вместо цифр — требуй конкретику
- Если таблица параметров неполная — укажи какие строки добавить
- Не трогай реквизиты (заказчик, договор, даты) — они должны оставаться пустыми

Отвечай ТОЛЬКО списком замечаний, без вступления. Максимум 12 замечаний.""",

    "verify": """Ты — эксперт по нормативной базе РФ и ЕАЭС. Твоя задача — ВЕРИФИЦИРОВАТЬ нормативный раздел ТЗ.

Проверь:
1. Все ли нормативные документы корректно указаны (номер + год + название)
2. Нет ли устаревших стандартов (заменённых актуальными)
3. Нет ли лишних стандартов, не относящихся к объекту
4. Нет ли пропущенных обязательных документов (ТР ТС, ГОСТ Р, СП)
5. Правильно ли указаны основания применения каждого документа

Также проверь разделы 6 (безопасность) и 8 (испытания) на полноту.

Отвечай ТОЛЬКО списком замечаний. Максимум 10 замечаний.""",

    "final": """Ты — технический редактор. Твоя задача — финальная ШЛИФОВКА ТЗ.

Проверь:
1. Единообразие стиля и терминологии во всём документе
2. Отсутствие противоречий между разделами
3. Все ли ссылки на нормативы внутри текста соответствуют разделу 3
4. Нет ли незаполненных мест типа «[указать]», «[уточнить]» кроме реквизитов
5. Логичность и полнота структуры
6. Правильность единиц измерения и форматов записи параметров

Отвечай ТОЛЬКО списком замечаний для финальной доработки. Максимум 8 замечаний.""",
}


async def critique(
    draft: str,
    stage: str,
    form: Dict[str, Any],
) -> List[str]:
    """
    Запрашивает DeepSeek Reasoner для анализа черновика.
    Возвращает список строк-замечаний.
    """
    system_prompt = STAGE_PROMPTS.get(stage, STAGE_PROMPTS["refine"])

    user_content = f"""ОБЪЕКТ ТЗ: {form.get('object_type', '—')}
ОТРАСЛЬ: {form.get('industry', '—')}

=== ТЕКУЩИЙ ЧЕРНОВИК ТЗ ===
{draft}

=== ЗАДАЧА ===
Выдай список замечаний согласно инструкции."""

    client = _get_client()
    try:
        response = await client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
            max_tokens=2048,
        )
        raw = response.choices[0].message.content or ""
        # Разбиваем на строки, фильтруем пустые
        issues = [line.strip() for line in raw.strip().splitlines() if line.strip()]
        logger.info(f"DeepSeek [{stage}]: {len(issues)} замечаний")
        return issues
    except Exception as e:
        logger.error(f"DeepSeek critique error [{stage}]: {e}")
        # Не падаем — возвращаем пустой список, пайплайн продолжится
        return []
