#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
LangGraph workflow для генерации ТЗ.
Объединяет агентов: retriever -> writer -> validator (цикл до 3 раз) -> quality.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import logging
from typing import Dict, Any, Literal
from langgraph.graph import StateGraph, END

# Импортируем агентов
from backend.agents.retriever_agent import retrieve_node
from backend.agents.writer_agent import writer_node
from backend.agents.validator_agent import validator_node
from backend.agents.quality_agent import quality_node

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Определяем структуру состояния
class WorkflowState(Dict[str, Any]):
    pass

def should_continue(state: WorkflowState) -> Literal["writer", "quality"]:
    """
    Условный переход: если есть замечания и итераций меньше 3 -> возвращаемся к writer,
    иначе идём к quality.
    """
    issues = state.get("issues", [])
    iteration = state.get("iteration", 0)
    max_iterations = 3
    if issues and iteration < max_iterations:
        logger.info(f"Замечания есть ({len(issues)}), итерация {iteration+1}/{max_iterations} -> возврат к writer")
        return "writer"
    else:
        logger.info("Замечаний нет или достигнут лимит итераций -> переход к quality")
        return "quality"

# Строим граф
workflow = StateGraph(WorkflowState)

# Добавляем узлы
workflow.add_node("retriever", retrieve_node)
workflow.add_node("writer", writer_node)
workflow.add_node("validator", validator_node)
workflow.add_node("quality", quality_node)

# Задаём последовательность: старт с retriever
workflow.set_entry_point("retriever")

# retriever -> writer
workflow.add_edge("retriever", "writer")

# writer -> validator
workflow.add_edge("writer", "validator")

# validator -> условный переход
workflow.add_conditional_edges(
    "validator",
    should_continue,
    {
        "writer": "writer",   # возвращаемся к writer
        "quality": "quality"  # идём к quality
    }
)

# quality -> END
workflow.add_edge("quality", END)

# Компилируем граф
app = workflow.compile()

def run_workflow(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Запускает workflow с заданными входными данными.
    Входные данные распаковываются в корневые поля состояния.
    """
    initial_state = {
        **input_data,        # все поля входных данных на верхнем уровне
        "context": [],
        "draft": "",
        "issues": [],
        "passed": False,
        "iteration": 0,
        "final_tz": "",
        "quality_score": 0
    }
    final_state = app.invoke(initial_state)
    return final_state

if __name__ == "__main__":
    # Тестовый запуск
    test_input = {
        "title": "ТЗ на выпрямитель",
        "equipment_type": "выпрямитель полупроводниковый",
        "parameters": "мощность 100 кВт, напряжение 400В",
        "requirements": "соответствие ГОСТ 34.602-2020"
    }
    result = run_workflow(test_input)
    print("\n=== ИТОГОВЫЙ РЕЗУЛЬТАТ ===")
    print(f"Оценка качества: {result.get('quality_score')}")
    print(f"Финальный ТЗ:\n{result.get('final_tz', result.get('draft'))}")
