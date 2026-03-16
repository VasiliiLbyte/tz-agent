# backend/routers/workshop.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import uuid
import json
import logging
import difflib
import aiosqlite
from datetime import datetime
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, AsyncGenerator

from backend.agents.deepseek_critic_agent import critique
from backend.agents.writer_agent import stream_stage
from backend.rag.retriever import search

router = APIRouter()
logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent.parent / "workshop.db"


# ── DB ──────────────────────────────────────────────────────────────────────

async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS tz_items (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            object_type TEXT,
            industry    TEXT,
            content     TEXT NOT NULL,
            form        TEXT,
            questions   TEXT DEFAULT '[]',
            status      TEXT DEFAULT 'saved',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
    """)
    # миграция: добавляем колонку если её нет
    try:
        await db.execute("ALTER TABLE tz_items ADD COLUMN questions TEXT DEFAULT '[]'")
        await db.commit()
    except Exception:
        pass
    return db


def make_diff(old: str, new: str) -> List[dict]:
    """Построчный diff: [{type: 'equal'|'add'|'remove', line: str}]"""
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    result = []
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == 'equal':
            for line in old_lines[i1:i2]:
                result.append({"type": "equal", "line": line})
        elif op == 'replace':
            for line in old_lines[i1:i2]:
                result.append({"type": "remove", "line": line})
            for line in new_lines[j1:j2]:
                result.append({"type": "add", "line": line})
        elif op == 'delete':
            for line in old_lines[i1:i2]:
                result.append({"type": "remove", "line": line})
        elif op == 'insert':
            for line in new_lines[j1:j2]:
                result.append({"type": "add", "line": line})
    return result


# ── Schemas ──────────────────────────────────────────────────────────────────

class SaveRequest(BaseModel):
    title: str
    object_type: Optional[str] = ""
    industry: Optional[str] = ""
    content: str
    form: Optional[dict] = None

class AcceptRequest(BaseModel):
    content: str          # новая версия которую принимает пользователь
    status: Optional[str] = "refined"

class QuestionAnswerRequest(BaseModel):
    question: str         # текст вопроса
    answer: str           # ответ пользователя
    section: Optional[str] = ""

class RefineRequest(BaseModel):
    answers: Optional[dict] = {}


# ── CRUD ────────────────────────────────────────────────────────────────────

@router.post("/save")
async def save_tz(req: SaveRequest):
    now = datetime.utcnow().isoformat()
    item_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO tz_items (id,title,object_type,industry,content,form,questions,status,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (item_id, req.title, req.object_type, req.industry,
             req.content, json.dumps(req.form or {}, ensure_ascii=False),
             "[]", "saved", now, now)
        )
        await db.commit()
    finally:
        await db.close()
    return {"id": item_id, "status": "saved"}


@router.get("/list")
async def list_tz():
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
            "questions": json.loads(row["questions"] or "[]"),
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


@router.post("/{item_id}/accept")
async def accept_patch(item_id: str, req: AcceptRequest):
    """Пользователь принимает новую версию ТЗ."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE tz_items SET content=?, status=?, updated_at=? WHERE id=?",
            (req.content, req.status, datetime.utcnow().isoformat(), item_id)
        )
        await db.commit()
    finally:
        await db.close()
    return {"status": "accepted"}


# ── Review ─────────────────────────────────────────────────────────────────

@router.post("/{item_id}/review")
async def review_tz(item_id: str):
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

    issues_refine = await critique(content, "refine", form)
    issues_verify = await critique(content, "verify", form)
    issues_final  = await critique(content, "final",  form)

    db = await get_db()
    try:
        await db.execute("UPDATE tz_items SET status='reviewed', updated_at=? WHERE id=?",
                         (datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()

    return {
        "technical":    issues_refine,
        "normative":    issues_verify,
        "completeness": issues_final,
        "total": len(issues_refine) + len(issues_verify) + len(issues_final),
    }


# ── Questions ──────────────────────────────────────────────────────────────

@router.post("/{item_id}/questions")
async def questions_tz(item_id: str):
    """
    GPT-4o генерирует вопросы.
    Существующие вопросы передаются в промпт чтобы избежать дублей.
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
        existing_qs: List[dict] = json.loads(row["questions"] or "[]")
    finally:
        await db.close()

    existing_texts = [q["question"] for q in existing_qs]
    existing_block = ""
    if existing_texts:
        existing_block = "\n\nУЖЕ ЗАДАННЫЕ ВОПРОСЫ (НЕ ДУБЛИРОВАТЬ):\n" + "\n".join(f"- {q}" for q in existing_texts)

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    prompt = f"""Ты эксперт по техническим заданиям.
Проанализируй ТЗ на объект: {object_type}

ТЗ:
{content[:6000]}
{existing_block}

Задача: найди ИНФОРМАЦИОННЫЕ ПРОБЕЛЫ и сформулируй 5–8 НОВЫХ вопросов.
Не повторяй уже заданные вопросы даже по смыслу.
Формат — JSON: {{"questions": [{{"question": "...", "section": "Раздел X", "why": "..."}}, ...]}}"""

    response = await ai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    try:
        raw = json.loads(response.choices[0].message.content)
        new_questions = raw.get("questions", [])
    except Exception:
        new_questions = [{"question": "Уточните технические требования.", "section": "", "why": ""}]

    # Добавляем поле answered=False если его нет
    for q in new_questions:
        q.setdefault("answered", False)
        q.setdefault("answer", "")
        q.setdefault("id", str(uuid.uuid4()))

    # Мержим со старыми
    all_questions = existing_qs + new_questions

    db = await get_db()
    try:
        await db.execute("UPDATE tz_items SET questions=?, updated_at=? WHERE id=?",
                         (json.dumps(all_questions, ensure_ascii=False),
                          datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()

    return {"questions": all_questions, "new_count": len(new_questions)}


# ── Answer single question → patch ───────────────────────────────────────────

async def answer_patch_generator(item_id: str, req: QuestionAnswerRequest) -> AsyncGenerator[str, None]:
    """Генерирует патч ТЗ на основе ответа на один вопрос. Не сохраняет автоматически."""
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        old_content = row["content"]
        form = json.loads(row["form"] or "{}")
        questions: List[dict] = json.loads(row["questions"] or "[]")
    finally:
        await db.close()

    # Добавляем ответ в форму
    extra = f"Ответ на вопрос '{req.question}': {req.answer}"
    form_with_answer = dict(form)
    form_with_answer["extra_requirements"] = (form.get("extra_requirements") or "") + "\n" + extra

    yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek анализирует...'}, ensure_ascii=False)}\n\n"
    issues = await critique(old_content, "refine", form_with_answer)
    if issues:
        yield f"data: {json.dumps({'type':'issues','issues':issues}, ensure_ascii=False)}\n\n"

    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o готовит правку...'}, ensure_ascii=False)}\n\n"

    query = f"{form.get('object_type','')} {form.get('description','')}"
    context_chunks = search(query, n_results=6) if query.strip() else []

    new_tokens: List[str] = []
    async for token in stream_stage(
        context_chunks=context_chunks,
        form=form_with_answer,
        issues=issues,
        stage="refine",
        previous_draft=old_content,
    ):
        new_tokens.append(token)
        yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)

    # Строим diff
    diff = make_diff(old_content, new_content)
    # Считаем количество изменений
    changed = sum(1 for d in diff if d["type"] in ("add", "remove"))

    # Отмечаем вопрос как отвеченный в хранилище
    for q in questions:
        if q.get("question") == req.question:
            q["answered"] = True
            q["answer"] = req.answer

    db = await get_db()
    try:
        await db.execute("UPDATE tz_items SET questions=?, updated_at=? WHERE id=?",
                         (json.dumps(questions, ensure_ascii=False),
                          datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()

    # Отправляем diff и новый контент на согласование
    yield f"data: {json.dumps({'type':'patch_ready','new_content':new_content,'diff':diff,'changed_lines':changed}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/answer")
async def answer_question(item_id: str, req: QuestionAnswerRequest):
    """Ответ на один вопрос → предлагает патч (не сохраняет автоматически)."""
    return StreamingResponse(
        answer_patch_generator(item_id, req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Refine (batch) ────────────────────────────────────────────────────────────────

async def refine_stream_generator(item_id: str, answers: dict) -> AsyncGenerator[str, None]:
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        old_content = row["content"]
        form = json.loads(row["form"] or "{}")
    finally:
        await db.close()

    if answers:
        extras = "; ".join(f"{k}: {v}" for k, v in answers.items())
        form["extra_requirements"] = (form.get("extra_requirements") or "") + "\n" + extras

    yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek анализирует ТЗ...'}, ensure_ascii=False)}\n\n"
    issues = await critique(old_content, "refine", form)
    if issues:
        yield f"data: {json.dumps({'type':'issues','issues':issues}, ensure_ascii=False)}\n\n"

    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o дорабатывает ТЗ...'}, ensure_ascii=False)}\n\n"

    query = f"{form.get('object_type','')} {form.get('description','')}"
    context_chunks = search(query, n_results=8) if query.strip() else []

    new_tokens: List[str] = []
    async for token in stream_stage(
        context_chunks=context_chunks,
        form=form,
        issues=issues,
        stage="refine",
        previous_draft=old_content,
    ):
        new_tokens.append(token)
        yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)
    diff = make_diff(old_content, new_content)
    changed = sum(1 for d in diff if d["type"] in ("add", "remove"))

    # Не сохраняем — отправляем на согласование
    yield f"data: {json.dumps({'type':'patch_ready','new_content':new_content,'diff':diff,'changed_lines':changed}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/refine")
async def refine_tz(item_id: str, req: RefineRequest):
    """Batch-доработка (не сохраняет автоматически, даёт patch_ready)."""
    return StreamingResponse(
        refine_stream_generator(item_id, req.answers or {}),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
