#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import logging
from typing import Dict, Any, List

from backend.rag import retriever

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def build_query(input_data: Dict[str, Any]) -> str:
    parts = []
    if input_data.get("equipment_type"):
        parts.append(input_data["equipment_type"])
    if input_data.get("parameters"):
        parts.append(input_data["parameters"])
    if input_data.get("requirements"):
        parts.append(input_data["requirements"])
    if input_data.get("title"):
        parts.append(input_data["title"])
    query = " ".join(parts)
    logger.info(f"Сформирован поисковый запрос: {query}")
    return query

def retrieve_context(input_data: Dict[str, Any], n_results: int = 5) -> List[Dict[str, Any]]:
    query = build_query(input_data)
    if not query:
        logger.warning("Поисковый запрос пуст, возвращаем пустой список")
        return []
    results = retriever.search(query, n_results=n_results)
    logger.info(f"Найдено {len(results)} релевантных фрагментов")
    return results

def retrieve_node(state: Dict[str, Any]) -> Dict[str, Any]:
    logger.info(f"retrieve_node получил state с ключами: {list(state.keys())}")
    input_data = {
        "title": state.get("title", ""),
        "equipment_type": state.get("equipment_type", ""),
        "parameters": state.get("parameters", ""),
        "requirements": state.get("requirements", "")
    }
    logger.info(f"Собранные входные данные: {input_data}")
    context = retrieve_context(input_data)
    state["context"] = context
    return state

if __name__ == "__main__":
    test_input = {
        "title": "ТЗ на выпрямитель",
        "equipment_type": "выпрямитель полупроводниковый",
        "parameters": "мощность 100 кВт, напряжение 400В",
        "requirements": "соответствие ГОСТ 34.602-2020"
    }
    ctx = retrieve_context(test_input)
    print(f"Найдено {len(ctx)} чанков")
    for i, c in enumerate(ctx, 1):
        print(f"\n--- Чанк {i} ---")
        print(f"Источник: {c['metadata'].get('source')}")
        print(f"Текст: {c['text'][:200]}...")
