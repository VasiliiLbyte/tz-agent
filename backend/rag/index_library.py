#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Скрипт индексации библиотеки документов в векторную базу ChromaDB.
Читает все файлы из папок library/gosts, library/templates, library/datasheets,
library/glossary, library/approved_tz, разбивает на чанки, создаёт эмбеддинги
через OpenAI и сохраняет в ChromaDB.

Запуск: python index_library.py
При пустой папке chroma_db скрипт запускается автоматически при старте backend.
"""

import os
import sys
import json
import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional

# Для загрузки переменных окружения
from dotenv import load_dotenv

# LlamaIndex компоненты
from llama_index.core import (
    SimpleDirectoryReader,
    VectorStoreIndex,
    StorageContext,
    Document,
)
from llama_index.core.node_parser import SimpleNodeParser
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.core.schema import MetadataMode

# ChromaDB
import chromadb
from chromadb.config import Settings

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Загружаем переменные окружения из .env (должен лежать в корне проекта)
load_dotenv()

# Константы
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY не найден в .env файле")
    sys.exit(1)

# Определяем корневую директорию проекта (там, где лежат папки library и chroma_db)
def get_project_root() -> Path:
    """Возвращает путь к корню проекта (на два уровня выше от текущего файла)."""
    current_file = Path(__file__).resolve()  # backend/rag/index_library.py
    return current_file.parent.parent.parent  # поднимаемся на два уровня: backend/rag/ -> корень

PROJECT_ROOT = get_project_root()
LIBRARY_ROOT = PROJECT_ROOT / "library"
CHROMA_DB_PATH = PROJECT_ROOT / "chroma_db"
MANIFEST_FILE = PROJECT_ROOT / "validated_manifest.json"

# Папки, которые нужно индексировать (относительно LIBRARY_ROOT)
SOURCE_DIRS = [
    "gosts",
    "templates",
    "datasheets",
    "glossary",
    "approved_tz",
]

# Поддерживаемые расширения файлов
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md", ".rtf"}

# Параметры чанкинга
CHUNK_SIZE = 1024        # размер чанка в токенах
CHUNK_OVERLAP = 200      # перекрытие между чанками

# Имя коллекции в ChromaDB
COLLECTION_NAME = "tz_library"


def compute_file_hash(file_path: Path) -> str:
    """Вычисляет SHA256 хеш содержимого файла."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def load_manifest() -> Dict[str, Any]:
    """Загружает манифест проиндексированных файлов."""
    if MANIFEST_FILE.exists():
        with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"files": {}, "last_indexed": None}


def save_manifest(manifest: Dict[str, Any]):
    """Сохраняет манифест."""
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def get_files_to_index(manifest: Dict[str, Any]) -> List[Path]:
    """
    Сравнивает текущие файлы в папках с записями в манифесте.
    Возвращает список файлов, которые нужно проиндексировать (новые или изменённые).
    """
    files_to_index = []
    all_files = []

    # Собираем все файлы из исходных папок
    for subdir in SOURCE_DIRS:
        dir_path = LIBRARY_ROOT / subdir
        if not dir_path.exists():
            logger.warning(f"Папка {dir_path} не существует, пропускаем")
            continue
        for file_path in dir_path.rglob("*"):
            if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
                all_files.append(file_path)

    # Сравниваем с манифестом
    indexed_files = manifest.get("files", {})

    for file_path in all_files:
        rel_path = str(file_path.relative_to(PROJECT_ROOT))
        current_hash = compute_file_hash(file_path)
        if rel_path not in indexed_files or indexed_files[rel_path]["hash"] != current_hash:
            files_to_index.append(file_path)
            # Обновляем запись в манифесте (хеш будет проставлен позже)
            indexed_files[rel_path] = {
                "hash": current_hash,
                "path": rel_path,
                "indexed": None,  # пока неизвестно, проставим после успеха
            }

    logger.info(f"Найдено {len(all_files)} всего файлов, нужно индексировать {len(files_to_index)}")
    return files_to_index


def index_files(file_paths: List[Path]):
    """
    Основная функция индексации.
    Принимает список путей к файлам, читает их, разбивает на чанки,
    создаёт эмбеддинги и сохраняет в ChromaDB.
    """
    if not file_paths:
        logger.info("Нет файлов для индексации.")
        return

    # Инициализируем эмбеддинг модель OpenAI
    embed_model = OpenAIEmbedding(
        model="text-embedding-3-small",
        api_key=OPENAI_API_KEY,
    )

    # Подключаемся к ChromaDB (постоянное хранилище)
    chroma_client = chromadb.PersistentClient(
        path=str(CHROMA_DB_PATH),
        settings=Settings(anonymized_telemetry=False),
    )

    # Получаем или создаём коллекцию
    try:
        collection = chroma_client.get_collection(COLLECTION_NAME)
        logger.info(f"Коллекция {COLLECTION_NAME} существует, очищаем для перезаписи")
        chroma_client.delete_collection(COLLECTION_NAME)
    except Exception:
        logger.info(f"Коллекция {COLLECTION_NAME} не найдена, будет создана новая")

    collection = chroma_client.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}  # для косинусного расстояния
    )

    # Создаем векторное хранилище LlamaIndex поверх ChromaDB
    vector_store = ChromaVectorStore(chroma_collection=collection)
    storage_context = StorageContext.from_defaults(vector_store=vector_store)

    # Парсер для разбиения на чанки (пока используем простой, по токенам)
    # В будущем можно заменить на иерархический парсер для выделения разделов
    node_parser = SimpleNodeParser.from_defaults(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
    )

    # Загружаем документы из файлов
    logger.info(f"Начинаем загрузку {len(file_paths)} файлов...")
    documents = []
    for file_path in file_paths:
        try:
            # SimpleDirectoryReader умеет определять тип файла по расширению
            reader = SimpleDirectoryReader(input_files=[str(file_path)])
            docs = reader.load_data()
            # Добавляем метаданные: источник, путь
            for doc in docs:
                doc.metadata["source"] = str(file_path.relative_to(PROJECT_ROOT))
                doc.metadata["file_name"] = file_path.name
                doc.metadata["folder"] = file_path.parent.name
            documents.extend(docs)
            logger.debug(f"Загружен {file_path.name}")
        except Exception as e:
            logger.error(f"Ошибка загрузки файла {file_path}: {e}")

    if not documents:
        logger.warning("Не удалось загрузить ни одного документа.")
        return

    logger.info(f"Загружено {len(documents)} документов. Разбиваем на чанки...")

    # Разбиваем документы на узлы (чанки)
    nodes = node_parser.get_nodes_from_documents(documents)

    # Добавляем к узлам метаданные о происхождении (если нужно)
    for node in nodes:
        # Для наглядности можно добавить текст в метаданные, но обычно не надо
        node.metadata["chunk_id"] = node.node_id
        # Можно также добавить префикс раздела, если удастся извлечь из документа
        # Пока оставляем как есть

    logger.info(f"Получено {len(nodes)} чанков. Создаём индекс...")

    # Создаём индекс из узлов и сохраняем в storage_context (который уже связан с ChromaDB)
    VectorStoreIndex(
        nodes=nodes,
        storage_context=storage_context,
        embed_model=embed_model,
        show_progress=True,
    )

    logger.info(f"Индексация завершена. Сохранено {len(nodes)} чанков в коллекцию {COLLECTION_NAME}.")


def update_manifest_after_indexing(file_paths: List[Path]):
    """
    После успешной индексации обновляет манифест: проставляет дату индексации для файлов.
    """
    manifest = load_manifest()
    now = datetime.now().isoformat()
    for file_path in file_paths:
        rel_path = str(file_path.relative_to(PROJECT_ROOT))
        if rel_path in manifest["files"]:
            manifest["files"][rel_path]["indexed"] = now
    manifest["last_indexed"] = now
    save_manifest(manifest)
    logger.info("Манифест обновлён.")


def main():
    logger.info("=" * 50)
    logger.info("Запуск индексации библиотеки документов")
    logger.info(f"Корень проекта: {PROJECT_ROOT}")
    logger.info(f"Папка библиотеки: {LIBRARY_ROOT}")
    logger.info(f"Папка ChromaDB: {CHROMA_DB_PATH}")
    logger.info("=" * 50)

    # Загружаем манифест
    manifest = load_manifest()
    logger.info(f"Манифест загружен, проиндексировано ранее: {len(manifest['files'])} файлов")

    # Определяем файлы, которые нужно индексировать
    files_to_index = get_files_to_index(manifest)

    if not files_to_index:
        logger.info("Все файлы уже проиндексированы и не изменились. Выход.")
        return

    logger.info(f"Будет проиндексировано {len(files_to_index)} файлов:")
    for f in files_to_index:
        logger.info(f"  - {f.relative_to(PROJECT_ROOT)}")

    # Выполняем индексацию
    index_files(files_to_index)

    # Обновляем манифест
    update_manifest_after_indexing(files_to_index)

    logger.info("Индексация успешно завершена.")


if __name__ == "__main__":
    main()
