# backend/routers/workshop.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import uuid
import json
import logging
import aiosqlite
from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, AsyncGenerator

from backend.agents.deepseek_critic_agent import critique
from backend.agents.writer_agent import stream_stage
from backend.rag.retriever import search

router = APIRouter()
logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent.parent / "workshop.db"


# ── DB helpers ────────────────────────────────────────────────────────────────

async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("""
        CREATE TABLE IF NOT EXISTS tz_items (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            object_type TEXT,
            industry    TEXT,
            content     TEXT NOT NULL,
            form        TEXT,
            status      TEXT DEFAULT 'saved',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
    """)
    await db.commit()
    return db


# ── Schemas ───────────────────────────────────────────────────────────────────

class SaveRequest(BaseModel):
    title: str
    object_type: Optional[str] = ""
    industry: Optional[str] = ""
    content: str
    form: Optional[dict] = None


class RefineRequest(BaseModel):
    answers: Optional[dict] = {}   # ответы на уточняющие вопросы


# ── Эндпоинты ─────────────────────────────────────────────────────────────────

@router.post("/save")
async def save_tz(req: SaveRequest):
    """Сохранить ТЗ в мастерскую."""
    now = datetime.utcnow().isoformat()
    item_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO tz_items (id,title,object_type,industry,content,form,status,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (item_id, req.title, req.object_type, req.industry,
             req.content, json.dumps(req.form or {}, ensure_ascii=False),
             "saved", now, now)
        )
        await db.commit()
    finally:
        await db.close()
    return {"id": item_id, "status": "saved"}


@router.get("/list")
async def list_tz():
    """Список всех сохранённых ТЗ."""
    db = await get_db()
    try:
        async with db.execute(
            "SELECT id,title,object_type,industry,status,created_at,updated_at FROM tz_items ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "title": r["title"], "object_type": r["object_type"],
                 "industry": r["industry"], "status": r["status"],
                 "created_at": r["created_at"], "updated_at": r["updated_at"]} for r in rows]
    finally:
        await db.close()


@router.get("/{item_id}")
async def get_tz(item_id: str):
    """Получить конкретное ТЗ."""
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ТЗ не найдено")
        return {
            "id": row["id"], "title": row["title"],
            "object_type": row["object_type"], "industry": row["industry"],
            "content": row["content"],
            "form": json.loads(row["form"] or "{}"),
            "status": row["status"],
            "created_at": row["created_at"], "updated_at": row["updated_at"],
        }
    finally:
        await db.close()


@router.delete("/{item_id}")
async def delete_tz(item_id: str):
    db = await get_db()
    try:
        await db.execute("DELETE FROM tz_items WHERE id=?", (item_id,))
        await db.commit()
    finally:
        await db.close()
    return {"status": "deleted"}


@router.post("/{item_id}/review")
async def review_tz(item_id: str):
    """
    DeepSeek делает полный разбор ТЗ.
    Возвращает список замечаний по трём осям: техника, нормативы, полнота.
    """
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ТЗ не найдено")
        content = row["content"]
        form = json.loads(row["form"] or "{}")
    finally:
        await db.close()

    # Три прохода критики разными промптами
    issues_refine  = await critique(content, "refine",  form)
    issues_verify  = await critique(content, "verify",  form)
    issues_final   = await critique(content, "final",   form)

    review = {
        "technical":   issues_refine,
        "normative":   issues_verify,
        "completeness": issues_final,
        "total": len(issues_refine) + len(issues_verify) + len(issues_final),
    }

    # Обновляем статус
    db = await get_db()
    try:
        await db.execute("UPDATE tz_items SET status='reviewed', updated_at=? WHERE id=?",
                         (datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()

    return review


@router.post("/{item_id}/questions")
async def questions_tz(item_id: str):
    """
    GPT-4o формулирует уточняющие вопросы на основе пробелов в ТЗ.
    """
    from openai import AsyncOpenAI
    import os

    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ТЗ не найдено")
        content = row["content"]
        object_type = row["object_type"] or "объект"
    finally:
        await db.close()

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    prompt = f"""Ты эксперт по техническим заданиям.
Проанализируй ТЗ на объект: {object_type}

ТЗ:
{content[:6000]}

Задача: найди информационные пробелы и сформулируй 5–8 конкретных уточняющих вопросов заказчику.
Каждый вопрос должен устранять конкретный пробел в ТЗ.
Формат ответа — JSON: {{"questions": [{{"question": "...", "section": "Раздел X", "why": "..."}}, ...]}}"""

    response = await ai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    try:
        raw = json.loads(response.choices[0].message.content)
        questions = raw.get("questions", [])
    except Exception:
        questions = [{"question": "Уточните технические требования.", "section": "", "why": ""}]

    return {"questions": questions}


async def refine_stream_generator(item_id: str, answers: dict) -> AsyncGenerator[str, None]:
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        content = row["content"]
        form = json.loads(row["form"] or "{}")
        object_type = row["object_type"] or ""
    finally:
        await db.close()

    # Добавляем ответы пользователя в форму
    if answers:
        extras = "; ".join(f"{k}: {v}" for k, v in answers.items())
        form["extra_requirements"] = (form.get("extra_requirements") or "") + "\n" + extras

    # Критика
    yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek анализирует ТЗ...'}, ensure_ascii=False)}\n\n"
    issues = await critique(content, "refine", form)
    if issues:
        yield f"data: {json.dumps({'type':'issues','issues':issues}, ensure_ascii=False)}\n\n"

    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o дорабатывает ТЗ...'}, ensure_ascii=False)}\n\n"

    # RAG контекст
    query = f"{form.get('object_type','')} {form.get('description','')}"
    context_chunks = search(query, n_results=8) if query.strip() else []

    new_tokens = []
    async for token in stream_stage(
        context_chunks=context_chunks,
        form=form,
        issues=issues,
        stage="refine",
        previous_draft=content,
    ):
        new_tokens.append(token)
        yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)

    # Сохраняем обновлённую версию
    db = await get_db()
    try:
        await db.execute(
            "UPDATE tz_items SET content=?, status='refined', updated_at=? WHERE id=?",
            (new_content, datetime.utcnow().isoformat(), item_id)
        )
        await db.commit()
    finally:
        await db.close()

    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/refine")
async def refine_tz(item_id: str, req: RefineRequest):
    """Повторная итерация улучшения ТЗ (streaming)."""
    return StreamingResponse(
        refine_stream_generator(item_id, req.answers or {}),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
