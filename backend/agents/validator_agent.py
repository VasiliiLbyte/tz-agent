#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import os
import logging
import json
from typing import Dict, Any, List

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

def validate_draft(draft: str) -> Dict[str, Any]:
    prompt = f"""Ты эксперт-валидатор технических заданий по ГОСТ 34.602-2020.
Проверь предоставленный черновик ТЗ на соответствие требованиям ГОСТ 34.602-2020.

Оцени следующие аспекты:
1. Соответствие структуре ГОСТ (наличие всех обязательных разделов).
2. Полнота и корректность каждого раздела.
3. Отсутствие противоречий.
4. Использование правильной терминологии.

Черновик ТЗ:
{draft}

Верни результат строго в формате JSON:
{{
  "passed": true/false,
  "issues": ["список замечаний (если есть)", ...],
  "score": число от 0 до 100
}}
Если passed = true, issues может быть пустым списком.
Если замечаний нет, passed = true.
"""
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Ты строгий валидатор ТЗ по ГОСТ."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.2,
            max_tokens=1000,
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        result = json.loads(content)
        if "passed" not in result:
            result["passed"] = False
        if "issues" not in result:
            result["issues"] = ["Не удалось распарсить ответ валидатора"]
        if "score" not in result:
            result["score"] = 0
        logger.info(f"Валидация завершена. Passed: {result['passed']}, замечаний: {len(result['issues'])}")
        return result
    except Exception as e:
        logger.error(f"Ошибка валидации: {e}")
        return {"passed": False, "issues": [f"Ошибка валидации: {str(e)}"], "score": 0}

def validator_node(state: Dict[str, Any]) -> Dict[str, Any]:
    draft = state.get("draft", "")
    if not draft:
        state["issues"] = ["Черновик пуст"]
        state["passed"] = False
        state["iteration"] = state.get("iteration", 0) + 1
        return state

    validation_result = validate_draft(draft)
    state["issues"] = validation_result.get("issues", [])
    state["passed"] = validation_result.get("passed", False)
    state["validation_score"] = validation_result.get("score", 0)
    state["iteration"] = state.get("iteration", 0) + 1
    return state

if __name__ == "__main__":
    sample_draft = "1. Общие сведения\nНаименование: ТЗ на выпрямитель\nЗаказчик: ООО Пример\nОснование: договор №123"
    result = validate_draft(sample_draft)
    print(json.dumps(result, indent=2, ensure_ascii=False))
