# backend/schemas/tz_schemas.py
from pydantic import BaseModel, Field
from typing import Optional, List

class TZFormRequest(BaseModel):
    object_type: str = Field(..., description="Тип объекта: оборудование, ПО, транспорт, система")
    description: str = Field(..., description="Описание объекта и его назначения")
    parameters: Optional[str] = Field(None, description="Технические параметры")
    standards: Optional[List[str]] = Field(
        default_factory=list,
        description="Список стандартов, указанных пользователем (ГОСТ, ISO, СП). Если пусто — агент подбирает сам"
    )
    industry: Optional[str] = Field(None, description="Отрасль применения (energy, it, construction, transport...)")
    extra_requirements: Optional[str] = Field(None, description="Доп. требования в свободной форме")

class ClarifyResponse(BaseModel):
    questions: List[str]
    suggested_standards: List[str]

class TZSection(BaseModel):
    title: str
    content: str

class StreamChunk(BaseModel):
    type: str   # "section_start" | "content" | "done" | "error"
    section: Optional[str] = None
    text: Optional[str] = None
