# backend/main.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.routers import tz

app = FastAPI(
    title="TZ Generator API",
    description="Универсальный генератор технических заданий с RAG по стандартам",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:8501"],  # Next.js + Streamlit
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tz.router, prefix="/api/tz", tags=["ТЗ"])

@app.get("/health")
def health():
    return {"status": "ok", "version": "0.2.0"}
