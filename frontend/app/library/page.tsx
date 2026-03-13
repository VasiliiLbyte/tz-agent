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

interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
  source_domain: string;
  is_direct_pdf: boolean;
  is_priority_source: boolean;
  already_indexed: boolean;
  filename: string;
  score: number;
}

const API = 'http://localhost:8000/api/library';

export default function LibraryPage() {
  const [tab, setTab] = useState<'library' | 'search'>('library');

  // Library tab state
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkPreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search tab state
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [approveResults, setApproveResults] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

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

  // ── Search tab ──
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setCandidates([]);
    setSelected(new Set());
    setApproveResults([]);
    setSearchError(null);
    try {
      const res = await fetch(`${API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      if (res.ok) {
        setCandidates(data);
      } else {
        setSearchError(data.detail || 'Что-то пошло не так');
      }
    } catch (e: any) {
      setSearchError(e.message);
    } finally {
      setSearching(false);
    }
  };

  const toggleSelect = (url: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(url) ? next.delete(url) : next.add(url);
      return next;
    });
  };

  const handleApprove = async () => {
    const toApprove = candidates.filter(c => selected.has(c.url) && !c.already_indexed);
    if (!toApprove.length) return;
    setApproving(true);
    setApproveResults([]);
    const results: string[] = [];
    for (const c of toApprove) {
      try {
        const res = await fetch(`${API}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: c.url, filename: c.filename || c.url.split('/').pop() }),
        });
        const data = await res.json();
        if (res.ok) {
          results.push(`✅ ${data.filename} — ${data.chunks_added} чанков`);
        } else {
          results.push(`❌ ${c.title}: ${data.detail}`);
        }
      } catch (e: any) {
        results.push(`❌ ${c.title}: ${e.message}`);
      }
    }
    setApproveResults(results);
    setApproving(false);
    loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold">📚 Библиотека документов</h1>
          <p className="text-gray-400 mt-1 text-sm">ГОСТы, ТЗ-аналоги, паспорта оборудования — используются при генерации ТЗ</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-700">
          {(['library', 'search'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                tab === t
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'library' ? '📂 Моя библиотека' : '🔍 Найти документы'}
            </button>
          ))}
        </div>

        {/* ── Library tab ── */}
        {tab === 'library' && (
          <div className="space-y-6">
            {/* Drop zone */}
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

            {uploadResult && (
              <div className={`p-4 rounded-lg text-sm ${
                uploadResult.startsWith('✅') ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
              }`}>
                {uploadResult}
              </div>
            )}

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
        )}

        {/* ── Search tab ── */}
        {tab === 'search' && (
          <div className="space-y-6">
            <div className="flex gap-3">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Например: ГОСТ электробезопасность помещений"
                className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSearch}
                disabled={searching || !searchQuery.trim()}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl text-sm font-medium transition"
              >
                {searching ? '⏳ Ищу...' : '🔍 Найти'}
              </button>
            </div>

            {searchError && (
              <div className="p-4 rounded-lg bg-red-900/40 text-red-300 text-sm">{searchError}</div>
            )}

            {candidates.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">Найдено: {candidates.length} документов. Отметьте нужные и нажмите «Добавить».</p>
                  <button
                    onClick={handleApprove}
                    disabled={approving || selected.size === 0}
                    className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-xl text-sm font-medium transition"
                  >
                    {approving ? '⏳ Добавляю...' : `➕ Добавить (${selected.size})`}
                  </button>
                </div>

                {approveResults.length > 0 && (
                  <div className="space-y-1">
                    {approveResults.map((r, i) => (
                      <div key={i} className={`text-xs p-2 rounded ${
                        r.startsWith('✅') ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'
                      }`}>{r}</div>
                    ))}
                  </div>
                )}

                {candidates.map((c) => (
                  <div
                    key={c.url}
                    onClick={() => !c.already_indexed && toggleSelect(c.url)}
                    className={`rounded-xl p-4 border transition cursor-pointer ${
                      c.already_indexed
                        ? 'border-gray-700 bg-gray-800/40 opacity-60 cursor-default'
                        : selected.has(c.url)
                          ? 'border-blue-500 bg-blue-900/20'
                          : 'border-gray-700 bg-gray-800 hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {!c.already_indexed && (
                        <input
                          type="checkbox"
                          checked={selected.has(c.url)}
                          onChange={() => toggleSelect(c.url)}
                          onClick={e => e.stopPropagation()}
                          className="mt-1 w-4 h-4 accent-blue-500"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium truncate">{c.title}</p>
                          {c.is_direct_pdf && (
                            <span className="text-xs bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">PDF</span>
                          )}
                          {c.is_priority_source && (
                            <span className="text-xs bg-green-900/50 text-green-300 px-2 py-0.5 rounded">★ Приоритетный</span>
                          )}
                          {c.already_indexed && (
                            <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded">✓ Уже в базе</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{c.source_domain}</p>
                        {c.snippet && (
                          <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-2">{c.snippet}</p>
                        )}
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-xs text-blue-400 hover:underline mt-1 inline-block truncate max-w-full"
                        >
                          {c.url}
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!searching && candidates.length === 0 && !searchError && (
              <div className="text-center py-16 text-gray-600">
                <p className="text-4xl mb-3">🔍</p>
                <p>Введите тему и нажмите «Найти»</p>
                <p className="text-sm mt-1">Например: «ГОСТ пожарная безопасность»</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
