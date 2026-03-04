#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import logging
from pathlib import Path
from typing import List, Dict, Any

from dotenv import load_dotenv
import chromadb
from chromadb.config import Settings
from llama_index.embeddings.openai import OpenAIEmbedding

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY не найден в .env файле")

PROJECT_ROOT = Path(__file__).parent.parent.parent
CHROMA_DB_PATH = PROJECT_ROOT / "chroma_db"
COLLECTION_NAME = "tz_library"

_chroma_client = None
_collection = None
_embed_model = None

def get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(
            path=str(CHROMA_DB_PATH),
            settings=Settings(anonymized_telemetry=False),
        )
    return _chroma_client

def get_collection():
    global _collection
    if _collection is None:
        client = get_chroma_client()
        try:
            _collection = client.get_collection(COLLECTION_NAME)
            logger.info(f"Коллекция {COLLECTION_NAME} загружена")
        except Exception as e:
            logger.error(f"Не удалось получить коллекцию {COLLECTION_NAME}: {e}")
            raise
    return _collection

def get_embed_model():
    global _embed_model
    if _embed_model is None:
        _embed_model = OpenAIEmbedding(model="text-embedding-3-small", api_key=OPENAI_API_KEY)
    return _embed_model

def search(query: str, n_results: int = 5) -> List[Dict[str, Any]]:
    try:
        collection = get_collection()
        embed_model = get_embed_model()
        query_embedding = embed_model.get_text_embedding(query)
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            include=["metadatas", "documents", "distances"]
        )
        formatted = []
        if results["ids"] and results["ids"][0]:
            for i in range(len(results["ids"][0])):
                formatted.append({
                    "text": results["documents"][0][i],
                    "metadata": results["metadatas"][0][i],
                    "distance": results["distances"][0][i] if results["distances"] else None,
                })
        logger.info(f"Поиск по запросу '{query}' вернул {len(formatted)} результатов")
        return formatted
    except Exception as e:
        logger.error(f"Ошибка при поиске: {e}")
        return []
