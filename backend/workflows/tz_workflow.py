#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import logging
from typing import Dict, Any, Literal, TypedDict, List
from langgraph.graph import StateGraph, END

from backend.agents.retriever_agent import retrieve_node
from backend.agents.writer_agent import writer_node
from backend.agents.validator_agent import validator_node
from backend.agents.quality_agent import quality_node
from backend.agents.web_standards_agent import resolve_standards_sync

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class WorkflowState(TypedDict):
    title: str
    equipment_type: str
    object_type: str
    description: str
    parameters: str
    requirements: str
    extra_requirements: str
    industry: str
    standards: List[str]
    resolved_standards: List[str]
    standards_catalog: List[Any]
    reference_sources: List[Any]
    context: List[Any]
    draft: str
    issues: List[str]
    passed: bool
    iteration: int
    final_tz: str
    quality_score: int


def should_continue(state: WorkflowState) -> Literal["writer", "quality"]:
    issues = state.get("issues", [])
    iteration = state.get("iteration", 0)
    max_iterations = 1
    if issues and iteration < max_iterations:
        logger.info(f"Замечания есть ({len(issues)}), итерация {iteration+1}/{max_iterations} -> возврат к writer")
        return "writer"
    else:
        logger.info("Замечаний нет или достигнут лимит итераций -> переход к quality")
        return "quality"


workflow = StateGraph(WorkflowState)
workflow.add_node("retriever", retrieve_node)
workflow.add_node("writer", writer_node)
workflow.add_node("validator", validator_node)
workflow.add_node("quality", quality_node)
workflow.set_entry_point("retriever")
workflow.add_edge("retriever", "writer")
workflow.add_edge("writer", "validator")
workflow.add_conditional_edges("validator", should_continue, {"writer": "writer", "quality": "quality"})
workflow.add_edge("quality", END)
app = workflow.compile()


def run_workflow(input_data: Dict[str, Any]) -> Dict[str, Any]:
    initial_state: WorkflowState = {        # ← 4 пробела, не 3
        "title": input_data.get("title", ""),
        "equipment_type": input_data.get("equipment_type", ""),
        "object_type": input_data.get("object_type") or input_data.get("equipment_type", ""),
        "description": input_data.get("description") or input_data.get("title", ""),
        "parameters": input_data.get("parameters", ""),
        "requirements": input_data.get("requirements", ""),
        "extra_requirements": input_data.get("extra_requirements") or input_data.get("requirements", ""),
        "industry": input_data.get("industry", ""),
        "standards": input_data.get("standards", []),
        "resolved_standards": [],
        "standards_catalog": [],
        "reference_sources": [],
        "context": [],
        "draft": "",
        "issues": [],
        "passed": False,
        "iteration": 0,
        "final_tz": "",
        "quality_score": 0,
    }
    logger.info(f"Передаю в граф состояние с ключами: {list(initial_state.keys())}")
    logger.info(f"Значение title: {initial_state['title']}")

    # Tavily: обогащаем state найденными стандартами ДО запуска графа
    resolved = resolve_standards_sync(
        form=initial_state,
        local_standards=initial_state.get("standards", []),
    )
    initial_state["resolved_standards"] = resolved["resolved_standards"]
    initial_state["standards_catalog"] = resolved["resolved_items"]
    initial_state["reference_sources"] = resolved["source_links"]

    return app.invoke(initial_state)        # ← обязательно должен быть!


if __name__ == "__main__":
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
