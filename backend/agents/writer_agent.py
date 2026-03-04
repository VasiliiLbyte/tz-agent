#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

"""
Агент-писатель: генерирует черновик ТЗ на основе контекста, входных данных и предыдущих замечаний.
"""

import os
import logging
from typing import Dict, Any, List
import json

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

def build_prompt(context: List[Dict[str, Any]], input_data: Dict[str, Any], issues: List[str] = None) -> str:
    """
    Строит промпт для GPT на основе контекста, входных данных и предыдущих замечаний.
    """
    context_text = ""
    for i, chunk in enumerate(context, 1):
        source = chunk['metadata'].get('source', 'неизвестно')
        context_text += f"\n--- Источник {i}: {source} ---\n"
        context_text += chunk['text'] + "\n"
    
    title = input_data.get("title", "Техническое задание")
    equipment_type = input_data.get("equipment_type", "не указано")
    parameters = input_data.get("parameters", "не указаны")
    requirements = input_data.get("requirements", "не указаны")
    
    issues_text = ""
    if issues:
        issues_text = "Предыдущие замечания, которые нужно исправить:\n" + "\n".join(f"- {issue}" for issue in issues)
    
    prompt = f"""Ты эксперт по написанию технических заданий (ТЗ) на промышленное оборудование, особенно выпрямители и силовую электронику. Твоя задача — составить черновик ТЗ в соответствии с ГОСТ 34.602-2020, используя ТОЛЬКО предоставленный ниже контекст из библиотеки документов. Не придумывай информацию, которой нет в контексте. Если в контексте недостаточно данных, напиши разделы с пометкой "Требуется уточнение".

Ниже представлены фрагменты из библиотеки:

{context_text}

Теперь данные от пользователя:
- Название ТЗ: {title}
- Тип оборудования: {equipment_type}
- Технические параметры: {parameters}
- Дополнительные требования: {requirements}

{issues_text}

Составь черновик ТЗ, следуя структуре ГОСТ 34.602-2020. Разделы должны включать:
1. Общие сведения
2. Назначение и цели создания системы
3. Характеристика объекта автоматизации
4. Требования к системе
5. Состав и содержание работ по созданию системы
6. Порядок контроля и приёмки
7. Требования к документированию
8. Источники разработки

Используй данные из контекста для заполнения разделов. Если были замечания, обязательно исправь их в новой версии. Пиши на русском языке, техническим стилем.
"""
    return prompt

def generate_draft(context: List[Dict[str, Any]], input_data: Dict[str, Any], issues: List[str] = None) -> str:
    """
    Генерирует черновик ТЗ через OpenAI.
    """
    prompt = build_prompt(context, input_data, issues)
    
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Ты эксперт по написанию технических заданий по ГОСТ."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=4000,
        )
        draft = response.choices[0].message.content
        logger.info("Черновик успешно сгенерирован")
        return draft
    except Exception as e:
        logger.error(f"Ошибка при генерации черновика: {e}")
        return "Ошибка генерации черновика."

def writer_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """
    Узел для LangGraph: принимает state, генерирует draft, сохраняет в state.
    Учитывает issues из предыдущей валидации.
    """
    context = state.get("context", [])
    input_data = state.get("input", {})
    issues = state.get("issues", [])
    
    if not input_data:
        input_data = {
            "title": state.get("title", ""),
            "equipment_type": state.get("equipment_type", ""),
            "parameters": state.get("parameters", ""),
            "requirements": state.get("requirements", "")
        }
    
    draft = generate_draft(context, input_data, issues)
    state["draft"] = draft
    # Очищаем issues перед следующей валидацией (будут заново получены)
    state["issues"] = []
    return state

if __name__ == "__main__":
    from backend.agents.retriever_agent import retrieve_context
    
    test_input = {
        "title": "ТЗ на выпрямитель",
        "equipment_type": "выпрямитель полупроводниковый",
        "parameters": "мощность 100 кВт, напряжение 400В",
        "requirements": "соответствие ГОСТ 34.602-2020"
    }
    print("Получаем контекст...")
    ctx = retrieve_context(test_input, n_results=5)
    print(f"Получено {len(ctx)} чанков. Генерируем черновик...")
    draft = generate_draft(ctx, test_input)
    print("\n" + "="*60)
    print("ЧЕРНОВИК ТЗ:")
    print(draft)
    print("="*60)
