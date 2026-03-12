'use client';

import { useState, useRef, useEffect } from 'react';

interface DocumentInfo {
  filename: string;
  size_kb: number;
  chunks: number;
  source: string;
}

interface ChunkPreview {
  chunk_index: number;
  text: string;
  source: string;
}

export default function LibraryPage() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkPreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const API = 'http://localhost:8000/api/library';

  useEffect(() => { loadDocuments(); }, []);

  const loadDocuments = async () => {
    try {
      const res = await fetch(`${API}/documents`);
      const data = await res.json();
      setDocuments(data);
    } catch {}
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadResult(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setUploadResult(`✅ ${data.filename} — добавлено ${data.chunks_added} чанков из ${data.chunks_total}`);
        loadDocuments();
      } else {
        setUploadResult(`❌ Ошибка: ${data.detail}`);
      }
    } catch (e: any) {
      setUploadResult(`❌ ${e.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  };

  const loadPreview = async (filename: string) => {
    if (previewFile === filename) { setPreviewFile(null); return; }
    setPreviewFile(filename);
    setLoadingPreview(true);
    try {
      const res = await fetch(`${API}/preview?filename=${encodeURIComponent(filename)}&limit=5`);
      const data = await res.json();
      setChunks(data);
    } catch {}
    setLoadingPreview(false);
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Удалить «${filename}» из библиотеки?`)) return;
    await fetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    setPreviewFile(null);
    loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold">📚 Библиотека документов</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Загружайте ГОСТы, ТЗ-аналоги, паспорта оборудования — они будут использованы при генерации ТЗ.
          </p>
        </div>

        {/* Зона загрузки */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
            dragOver ? 'border-blue-400 bg-blue-900/20' : 'border-gray-600 hover:border-gray-400'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={handleFileChange}
          />
          {uploading ? (
            <p className="text-blue-400 text-lg">⏳ Загрузка и индексация...</p>
          ) : (
            <>
              <p className="text-4xl mb-3">📄</p>
              <p className="text-gray-300 font-medium">Перетащите файл или нажмите для выбора</p>
              <p className="text-gray-500 text-sm mt-1">PDF, DOCX, TXT, MD — до 20 МБ</p>
            </>
          )}
        </div>

        {/* Результат загрузки */}
        {uploadResult && (
          <div className={`p-4 rounded-lg text-sm ${
            uploadResult.startsWith('✅') ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
          }`}>
            {uploadResult}
          </div>
        )}

        {/* Список документов */}
        {documents.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-200">Документы в базе ({documents.length})</h2>
            {documents.map((doc) => (
              <div key={doc.filename} className="bg-gray-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">📄</span>
                    <div>
                      <p className="font-medium text-sm">{doc.filename}</p>
                      <p className="text-xs text-gray-500">{doc.size_kb} КБ · {doc.chunks} чанков</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => loadPreview(doc.filename)}
                      className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition"
                    >
                      {previewFile === doc.filename ? '▲ Скрыть' : '▼ Превью'}
                    </button>
                    <button
                      onClick={() => handleDelete(doc.filename)}
                      className="text-xs px-3 py-1.5 bg-red-900/50 hover:bg-red-800 text-red-300 rounded-lg transition"
                    >
                      🗑 Удалить
                    </button>
                  </div>
                </div>

                {/* Превью чанков */}
                {previewFile === doc.filename && (
                  <div className="border-t border-gray-700 p-4 space-y-3">
                    {loadingPreview ? (
                      <p className="text-sm text-gray-400">Загрузка превью...</p>
                    ) : chunks.length > 0 ? (
                      chunks.map((chunk) => (
                        <div key={chunk.chunk_index} className="bg-gray-700/50 rounded-lg p-3">
                          <p className="text-xs text-gray-500 mb-1">Чанк #{chunk.chunk_index}</p>
                          <p className="text-xs text-gray-300 leading-relaxed">{chunk.text}…</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-gray-500">Чанки не найдены</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-600">
            <p className="text-4xl mb-3">📭</p>
            <p>База пустая — загрузите первый документ</p>
          </div>
        )}
      </div>
    </div>
  );
}
