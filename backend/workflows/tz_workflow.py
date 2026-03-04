#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import logging
from typing import Dict, Any, Literal
from langgraph.graph import StateGraph, END

from backend.agents.retriever_agent import retrieve_node
from backend.agents.writer_agent import writer_node
from backend.agents.validator_agent import validator_node
from backend.agents.quality_agent import quality_node

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class WorkflowState(Dict[str, Any]):
    pass

def should_continue(state: WorkflowState) -> Literal["writer", "quality"]:
    issues = state.get("issues", [])
    iteration = state.get("iteration", 0)
    max_iterations = 3
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
    initial_state = {
        **input_data,
        "context": [],
        "draft": "",
        "issues": [],
        "passed": False,
        "iteration": 0,
        "final_tz": "",
        "quality_score": 0
    }
    return app.invoke(initial_state)

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
