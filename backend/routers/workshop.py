# backend/routers/workshop.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import uuid, json, logging, difflib
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


# ── DB ───────────────────────────────────────────────────────────────────────

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
        CREATE TABLE IF NOT EXISTS tz_history (
            id            TEXT PRIMARY KEY,
            tz_id         TEXT NOT NULL,
            action        TEXT NOT NULL,
            description   TEXT NOT NULL,
            old_content   TEXT,
            new_content   TEXT,
            diff          TEXT,
            changed_lines INTEGER DEFAULT 0,
            created_at    TEXT NOT NULL
        );
    """)
    for col_sql in [
        "ALTER TABLE tz_items ADD COLUMN questions TEXT DEFAULT '[]'",
    ]:
        try:
            await db.execute(col_sql)
            await db.commit()
        except Exception:
            pass
    return db


def make_diff(old: str, new: str) -> List[dict]:
    old_lines, new_lines = old.splitlines(), new.splitlines()
    result = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(
            None, old_lines, new_lines, autojunk=False).get_opcodes():
        if op == 'equal':
            for l in old_lines[i1:i2]: result.append({"type": "equal",  "line": l})
        elif op == 'replace':
            for l in old_lines[i1:i2]: result.append({"type": "remove", "line": l})
            for l in new_lines[j1:j2]: result.append({"type": "add",    "line": l})
        elif op == 'delete':
            for l in old_lines[i1:i2]: result.append({"type": "remove", "line": l})
        elif op == 'insert':
            for l in new_lines[j1:j2]: result.append({"type": "add",    "line": l})
    return result


async def add_history(db, tz_id: str, action: str, description: str,
                      old_content: str, new_content: str,
                      diff: List[dict], changed: int):
    await db.execute(
        "INSERT INTO tz_history "
        "(id,tz_id,action,description,old_content,new_content,diff,changed_lines,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), tz_id, action, description,
         old_content, new_content,
         json.dumps(diff, ensure_ascii=False), changed,
         datetime.utcnow().isoformat())
    )
    await db.commit()


# ── Schemas ────────────────────────────────────────────────────────────────────────

class SaveRequest(BaseModel):
    title: str
    object_type: Optional[str] = ""
    industry: Optional[str] = ""
    content: str
    form: Optional[dict] = None

class AcceptRequest(BaseModel):
    content: str
    status: Optional[str] = "refined"
    action: Optional[str] = "accept"
    description: Optional[str] = ""
    diff: Optional[list] = []
    changed_lines: Optional[int] = 0

class QuestionAnswerRequest(BaseModel):
    question: str
    answer: str
    section: Optional[str] = ""

class PromptRefineRequest(BaseModel):
    prompt: str
    with_review: bool = False

class RefineRequest(BaseModel):
    answers: Optional[dict] = {}


# ── CRUD ─────────────────────────────────────────────────────────────────────────

@router.post("/save")
async def save_tz(req: SaveRequest):
    now = datetime.utcnow().isoformat()
    item_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO tz_items "
            "(id,title,object_type,industry,content,form,questions,status,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (item_id, req.title, req.object_type, req.industry,
             req.content, json.dumps(req.form or {}, ensure_ascii=False),
             "[]", "saved", now, now))
        await db.commit()
        await add_history(db, item_id, "create", "ТЗ создано",
                          "", req.content, [], 0)
    finally:
        await db.close()
    return {"id": item_id, "status": "saved"}


@router.get("/list")
async def list_tz():
    db = await get_db()
    try:
        async with db.execute(
            "SELECT id,title,object_type,industry,status,created_at,updated_at "
            "FROM tz_items ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "title": r["title"],
                 "object_type": r["object_type"], "industry": r["industry"],
                 "status": r["status"],
                 "created_at": r["created_at"], "updated_at": r["updated_at"]}
                for r in rows]
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
        await db.execute("DELETE FROM tz_history WHERE tz_id=?", (item_id,))
        await db.commit()
    finally:
        await db.close()
    return {"status": "deleted"}


@router.get("/{item_id}/history")
async def get_history(item_id: str):
    db = await get_db()
    try:
        async with db.execute(
            "SELECT id,action,description,changed_lines,created_at "
            "FROM tz_history WHERE tz_id=? ORDER BY created_at DESC",
            (item_id,)
        ) as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "action": r["action"],
                 "description": r["description"],
                 "changed_lines": r["changed_lines"],
                 "created_at": r["created_at"]} for r in rows]
    finally:
        await db.close()


@router.get("/{item_id}/history/{entry_id}")
async def get_history_entry(item_id: str, entry_id: str):
    db = await get_db()
    try:
        async with db.execute(
            "SELECT * FROM tz_history WHERE id=? AND tz_id=?",
            (entry_id, item_id)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Запись не найдена")
        return {
            "id": row["id"], "action": row["action"],
            "description": row["description"],
            "diff": json.loads(row["diff"] or "[]"),
            "changed_lines": row["changed_lines"],
            "old_content": row["old_content"],
            "new_content": row["new_content"],
            "created_at": row["created_at"],
        }
    finally:
        await db.close()


@router.post("/{item_id}/accept")
async def accept_patch(item_id: str, req: AcceptRequest):
    now = datetime.utcnow().isoformat()
    db = await get_db()
    try:
        async with db.execute(
            "SELECT content FROM tz_items WHERE id=?", (item_id,)
        ) as cur:
            row = await cur.fetchone()
        old_content = row["content"] if row else ""
        await db.execute(
            "UPDATE tz_items SET content=?, status=?, updated_at=? WHERE id=?",
            (req.content, req.status, now, item_id))
        await db.commit()
        diff = req.diff or make_diff(old_content, req.content)
        changed = req.changed_lines or sum(
            1 for d in diff if d.get("type") in ("add", "remove"))
        await add_history(db, item_id, req.action or "accept",
                          req.description or "Изменения приняты",
                          old_content, req.content, diff, changed)
    finally:
        await db.close()
    return {"status": "accepted"}


# ── Review ───────────────────────────────────────────────────────────────────────

@router.post("/{item_id}/review")
async def review_tz(item_id: str):
    db = await get_db()
    try:
        async with db.execute("SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ТЗ не найдено")
        content, form = row["content"], json.loads(row["form"] or "{}")
    finally:
        await db.close()

    issues_r = await critique(content, "refine", form)
    issues_v = await critique(content, "verify", form)
    issues_f = await critique(content, "final",  form)

    db = await get_db()
    try:
        await db.execute(
            "UPDATE tz_items SET status='reviewed', updated_at=? WHERE id=?",
            (datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()
    return {"technical": issues_r, "normative": issues_v,
            "completeness": issues_f,
            "total": len(issues_r) + len(issues_v) + len(issues_f)}


# ── Questions ─────────────────────────────────────────────────────────────────────

@router.post("/{item_id}/questions")
async def questions_tz(item_id: str):
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

    existing_block = ""
    if existing_qs:
        existing_block = (
            "\n\nУЖЕ ЗАДАННЫЕ ВОПРОСЫ (НЕ ДУБЛИРОВАТЬ):\n"
            + "\n".join(f"- {q['question']}" for q in existing_qs)
        )

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    resp = await ai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content":
            f"""Ты эксперт по ТЗ. Объект: {object_type}
ТЗ:\n{content[:6000]}{existing_block}
Сформулируй 5–8 НОВЫХ вопросов. Не повторяй уже заданные.
JSON: {{"questions": [{{"question": "...", "section": "...", "why": "..."}}]}}"""
        }],
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    try:
        new_qs = json.loads(
            resp.choices[0].message.content).get("questions", [])
    except Exception:
        new_qs = [{"question": "Уточните требования.",
                   "section": "", "why": ""}]

    for q in new_qs:
        q.setdefault("answered", False)
        q.setdefault("answer", "")
        q.setdefault("id", str(uuid.uuid4()))

    all_qs = existing_qs + new_qs
    db = await get_db()
    try:
        await db.execute(
            "UPDATE tz_items SET questions=?, updated_at=? WHERE id=?",
            (json.dumps(all_qs, ensure_ascii=False),
             datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()
    return {"questions": all_qs, "new_count": len(new_qs)}


# ── Answer single question → patch ──────────────────────────────────────────────

async def answer_patch_generator(
        item_id: str, req: QuestionAnswerRequest) -> AsyncGenerator[str, None]:
    db = await get_db()
    try:
        async with db.execute(
                "SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        old_content = row["content"]
        form = json.loads(row["form"] or "{}")
        questions: List[dict] = json.loads(row["questions"] or "[]")
    finally:
        await db.close()

    form_ext = dict(form)
    form_ext["extra_requirements"] = (
        (form.get("extra_requirements") or "")
        + f"\nОтвет на '{req.question}': {req.answer}"
    )

    yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek анализирует...'}, ensure_ascii=False)}\n\n"
    issues = await critique(old_content, "refine", form_ext)
    if issues:
        yield f"data: {json.dumps({'type':'issues','issues':issues}, ensure_ascii=False)}\n\n"

    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o готовит правку...'}, ensure_ascii=False)}\n\n"
    context_chunks = search(
        f"{form.get('object_type','')} {form.get('description','')}",
        n_results=6)

    new_tokens: List[str] = []
    async for token in stream_stage(
            context_chunks=context_chunks, form=form_ext,
            issues=issues, stage="refine", previous_draft=old_content):
        new_tokens.append(token)
        yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)
    diff = make_diff(old_content, new_content)
    changed = sum(1 for d in diff if d["type"] in ("add", "remove"))

    for q in questions:
        if q.get("question") == req.question:
            q["answered"], q["answer"] = True, req.answer

    db = await get_db()
    try:
        await db.execute(
            "UPDATE tz_items SET questions=?, updated_at=? WHERE id=?",
            (json.dumps(questions, ensure_ascii=False),
             datetime.utcnow().isoformat(), item_id))
        await db.commit()
    finally:
        await db.close()

    yield f"data: {json.dumps({'type':'patch_ready','new_content':new_content,'diff':diff,'changed_lines':changed,'description':f'Ответ на вопрос: {req.question[:60]}'}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/answer")
async def answer_question(item_id: str, req: QuestionAnswerRequest):
    return StreamingResponse(
        answer_patch_generator(item_id, req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Auto-expand user prompt ────────────────────────────────────────────────────

async def expand_prompt(user_prompt: str, tz_content: str, form: dict) -> str:
    """
    GPT-4o mini расширяет короткую инструкцию пользователя в детальный
    системный промпт для GPT-4o, учитывая контекст ТЗ.
    """
    from openai import AsyncOpenAI
    import os

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    object_type = form.get("object_type", "объект")
    industry    = form.get("industry", "")
    context_hint = f"Объект: {object_type}"
    if industry:
        context_hint += f", отрасль: {industry}"

    resp = await ai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": (
                "Ты ассистент по подготовке технических заданий. "
                "Преобразуй короткую инструкцию пользователя в детальный промпт для улучшения ТЗ. "
                "Учитывай: тип объекта, отрасль, структуру документа, релевантные нормы и стандарты. "
                "Ответь ТОЛЬКО расширенным промптом, без пояснений и мета-комментариев."
            )},
            {"role": "user", "content": (
                f"{context_hint}\n"
                f"Первые 2000 символов ТЗ:\n{tz_content[:2000]}\n\n"
                f"Инструкция пользователя: {user_prompt}\n\n"
                "Расширь до детального промпта для GPT-4o, который выполнит это улучшение."
            )},
        ],
        temperature=0.3,
        max_tokens=600,
    )
    return resp.choices[0].message.content.strip()


# ── Prompt-based improvement ──────────────────────────────────────────────────

async def prompt_refine_generator(
        item_id: str,
        user_prompt: str,
        with_review: bool = False) -> AsyncGenerator[str, None]:
    """
    0. GPT-4o mini авто-расширяет промпт пользователя (отправляет на фронт чтобы отобразить).
    1. GPT-4o выполняет инструкцию по расширенному промпту (streaming).
    2. Если with_review=True — DeepSeek проверяет результат.
    3. patch_ready.
    """
    from openai import AsyncOpenAI
    import os

    db = await get_db()
    try:
        async with db.execute(
                "SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        old_content = row["content"]
        form = json.loads(row["form"] or "{}")
    finally:
        await db.close()

    ai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    # ─ Шаг 0: авто-расширение промпта (GPT-4o mini, быстро)
    yield f"data: {json.dumps({'type':'status','message':'💡 Расширяю инструкцию...'}, ensure_ascii=False)}\n\n"
    expanded_prompt = await expand_prompt(user_prompt, old_content, form)

    # Отправляем расширенный промпт на фронт
    yield f"data: {json.dumps({'type':'expanded_prompt','text':expanded_prompt}, ensure_ascii=False)}\n\n"

    # ─ Шаг 1: GPT-4o выполняет расширенную инструкцию
    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o выполняет инструкцию...'}, ensure_ascii=False)}\n\n"

    stream = await ai.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system",
             "content": (
                 "Ты эксперт по техническим заданиям. Тебе дано ТЗ и детальная инструкция по его улучшению. "
                 "Выведи полное обновлённое ТЗ целиком, сохраняя все незатронутые разделы."
             )},
            {"role": "user",
             "content": f"Инструкция: {expanded_prompt}\n\nТекущее ТЗ:\n{old_content}"},
        ],
        temperature=0.4,
        stream=True,
    )

    new_tokens: List[str] = []
    async for chunk in stream:
        token = chunk.choices[0].delta.content or ""
        if token:
            new_tokens.append(token)
            yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)

    # ─ Шаг 2 (опционально): вторичная проверка DeepSeek
    review_issues: List[str] = []
    if with_review:
        yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek проверяет результат...'}, ensure_ascii=False)}\n\n"
        r_tech = await critique(new_content, "refine", form)
        r_norm = await critique(new_content, "verify", form)
        r_comp = await critique(new_content, "final",  form)
        review_issues = r_tech + r_norm + r_comp
        yield f"data: {json.dumps({'type':'review_issues','issues':review_issues,'counts':{'technical':len(r_tech),'normative':len(r_norm),'completeness':len(r_comp)}}, ensure_ascii=False)}\n\n"

    # ─ Шаг 3: diff и patch_ready
    diff = make_diff(old_content, new_content)
    changed = sum(1 for d in diff if d["type"] in ("add", "remove"))

    yield f"data: {json.dumps({'type':'patch_ready','new_content':new_content,'diff':diff,'changed_lines':changed,'description':f'Промпт: {user_prompt[:80]}'}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/prompt-refine")
async def prompt_refine(item_id: str, req: PromptRefineRequest):
    return StreamingResponse(
        prompt_refine_generator(item_id, req.prompt, req.with_review),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Refine batch ──────────────────────────────────────────────────────────────────────

async def refine_stream_generator(
        item_id: str, answers: dict) -> AsyncGenerator[str, None]:
    db = await get_db()
    try:
        async with db.execute(
                "SELECT * FROM tz_items WHERE id=?", (item_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            yield f"data: {json.dumps({'type':'error','message':'ТЗ не найдено'}, ensure_ascii=False)}\n\n"
            return
        old_content = row["content"]
        form = json.loads(row["form"] or "{}")
    finally:
        await db.close()

    if answers:
        form["extra_requirements"] = (
            (form.get("extra_requirements") or "")
            + "\n" + "; ".join(f"{k}: {v}" for k, v in answers.items())
        )

    yield f"data: {json.dumps({'type':'status','message':'🤖 DeepSeek анализирует ТЗ...'}, ensure_ascii=False)}\n\n"
    issues = await critique(old_content, "refine", form)
    if issues:
        yield f"data: {json.dumps({'type':'issues','issues':issues}, ensure_ascii=False)}\n\n"

    yield f"data: {json.dumps({'type':'status','message':'✍️ GPT-4o дорабатывает ТЗ...'}, ensure_ascii=False)}\n\n"
    context_chunks = search(
        f"{form.get('object_type','')} {form.get('description','')}",
        n_results=8)

    new_tokens: List[str] = []
    async for token in stream_stage(
            context_chunks=context_chunks, form=form,
            issues=issues, stage="refine", previous_draft=old_content):
        new_tokens.append(token)
        yield f"data: {json.dumps({'type':'token','text':token}, ensure_ascii=False)}\n\n"

    new_content = "".join(new_tokens)
    diff = make_diff(old_content, new_content)
    changed = sum(1 for d in diff if d["type"] in ("add", "remove"))

    yield f"data: {json.dumps({'type':'patch_ready','new_content':new_content,'diff':diff,'changed_lines':changed,'description':'Полная доработка ТЗ'}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type':'done'}, ensure_ascii=False)}\n\n"


@router.post("/{item_id}/refine")
async def refine_tz(item_id: str, req: RefineRequest):
    return StreamingResponse(
        refine_stream_generator(item_id, req.answers or {}),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
