#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI
from backend.routers import tz

app = FastAPI(title="TZ Generator API")

app.include_router(tz.router, prefix="/api/tz", tags=["ТЗ"])

@app.get("/")
def root():
    return {"message": "TZ Generator API работает"}
