#!/usr/bin/env python
# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

"""
Агент контроля качества: финальная проверка полноты, логики, отсутствия противоречий.
Возвращает итоговый текст ТЗ и оценку качества.
"""

import os
import logging
import json
from typing import Dict, Any

from openai import OpenAI
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY не найден в .env файле")

client = OpenAI(api_key=OPENAI_API_KEY)
MODEL = "gpt-4-turbo-preview"

def quality_check(draft: str, issues: list) -> Dict[str, Any]:
    """
    Проверяет качество ТЗ, исправляет мелкие недочеты, возвращает финальную версию и оценку.
    """
    prompt = f"""Ты финальный редактор технических заданий. У тебя есть черновик ТЗ и список замечаний от валидатора.
Твоя задача:
1. Исправить указанные замечания (если это возможно без привлечения дополнительной информации).
2. Проверить логическую связность, полноту, отсутствие противоречий.
3. Улучшить формулировки, сохраняя технический стиль.
4. Поставить итоговую оценку качества от 0 до 100.

Черновик:
{draft}

Замечания валидатора:
{json.dumps(issues, ensure_ascii=False, indent=2)}

Верни результат строго в формате JSON:
{{
  "final_tz": "исправленный полный текст ТЗ",
  "quality_score": число от 0 до 100,
  "comments": "краткий комментарий о проделанной работе"
}}
"""
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Ты финальный редактор ТЗ."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=4000,
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        result = json.loads(content)
        logger.info(f"Финальная проверка завершена. Оценка: {result.get('quality_score')}")
        return result
    except Exception as e:
        logger.error(f"Ошибка финальной проверки: {e}")
        return {
            "final_tz": draft,
            "quality_score": 0,
            "comments": f"Ошибка при финальной проверке: {str(e)}"
        }

def quality_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """
    Узел для LangGraph: принимает state с draft и issues, возвращает final_tz и quality_score.
    """
    draft = state.get("draft", "")
    issues = state.get("issues", [])
    result = quality_check(draft, issues)
    state["final_tz"] = result.get("final_tz", draft)
    state["quality_score"] = result.get("quality_score", 0)
    state["quality_comments"] = result.get("comments", "")
    return state

if __name__ == "__main__":
    # Пример
    test_draft = "1. Общие сведения\n..."
    test_issues = ["Нет раздела 2", "Термин 'выпрямитель' используется неверно"]
    res = quality_check(test_draft, test_issues)
    print(json.dumps(res, indent=2, ensure_ascii=False))
