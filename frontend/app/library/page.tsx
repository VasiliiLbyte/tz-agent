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

  // Library
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkPreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Full text modal
  const [textModal, setTextModal] = useState<{ filename: string; text: string } | null>(null);
  const [loadingText, setLoadingText] = useState<string | null>(null);

  // Search
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
      setDocuments(await res.json());
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
      setUploadResult(res.ok
        ? `✅ ${data.filename} — ${data.chunks_added} чанков добавлено`
        : `❌ ${data.detail}`);
      if (res.ok) loadDocuments();
    } catch (e: any) {
      setUploadResult(`❌ ${e.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  };

  const loadPreview = async (filename: string) => {
    if (previewFile === filename) { setPreviewFile(null); return; }
    setPreviewFile(filename);
    setLoadingPreview(true);
    try {
      const res = await fetch(`${API}/preview?filename=${encodeURIComponent(filename)}&limit=5`);
      setChunks(await res.json());
    } catch {}
    setLoadingPreview(false);
  };

  const openFullText = async (filename: string) => {
    setLoadingText(filename);
    try {
      const res = await fetch(`${API}/text?filename=${encodeURIComponent(filename)}`);
      const data = await res.json();
      if (res.ok) {
        setTextModal({ filename, text: data.text });
      } else {
        alert(`Ошибка: ${data.detail}`);
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoadingText(null);
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Удалить «${filename}»?`)) return;
    await fetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    setPreviewFile(null);
    loadDocuments();
  };

  // Search
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true); setCandidates([]); setSelected(new Set()); setApproveResults([]); setSearchError(null);
    try {
      const res = await fetch(`${API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      res.ok ? setCandidates(data) : setSearchError(data.detail);
    } catch (e: any) { setSearchError(e.message); }
    setSearching(false);
  };

  const toggleSelect = (url: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  };

  const handleApprove = async () => {
    const toApprove = candidates.filter(c => selected.has(c.url) && !c.already_indexed);
    if (!toApprove.length) return;
    setApproving(true); setApproveResults([]);
    const results: string[] = [];
    for (const c of toApprove) {
      try {
        const res = await fetch(`${API}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: c.url, filename: c.filename }),
        });
        const data = await res.json();
        results.push(res.ok ? `✅ ${data.filename} — ${data.chunks_added} чанков` : `❌ ${c.title}: ${data.detail}`);
      } catch (e: any) { results.push(`❌ ${c.title}: ${e.message}`); }
    }
    setApproveResults(results); setApproving(false); loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto space-y-6">

        <div>
          <h1 className="text-3xl font-bold">📚 Библиотека</h1>
          <p className="text-gray-400 text-sm mt-1">ГОСТы, ТЗ-аналоги, паспорта — используются при генерации ТЗ</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-700">
          {(['library', 'search'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}>
              {t === 'library' ? '📂 Моя библиотека' : '🔍 Найти документы'}
            </button>
          ))}
        </div>

        {/* Library tab */}
        {tab === 'library' && (
          <div className="space-y-5">
            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
                dragOver ? 'border-blue-400 bg-blue-900/20' : 'border-gray-600 hover:border-gray-400'
              }`}>
              <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md"
                className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
              {uploading ? (
                <p className="text-blue-400">⏳ Загрузка и индексация... (скан PDF может занять 1–2 минуты)</p>
              ) : (
                <><p className="text-4xl mb-2">📄</p>
                  <p className="text-gray-300">Перетащите файл или нажмите для выбора</p>
                  <p className="text-gray-500 text-sm mt-1">PDF, DOCX, TXT, MD — до 20 МБ</p></>
              )}
            </div>

            {uploadResult && (
              <div className={`p-3 rounded-lg text-sm ${
                uploadResult.startsWith('✅') ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'
              }`}>{uploadResult}</div>
            )}

            {documents.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold">Документы ({documents.length})</h2>
                {documents.map(doc => (
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
                        <button onClick={() => openFullText(doc.filename)}
                          disabled={loadingText === doc.filename}
                          className="text-xs px-3 py-1.5 bg-indigo-900/50 hover:bg-indigo-800 text-indigo-300 rounded-lg transition disabled:opacity-50">
                          {loadingText === doc.filename ? '⏳' : '📝'} Текст
                        </button>
                        <button onClick={() => loadPreview(doc.filename)}
                          className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                          {previewFile === doc.filename ? '▲ Скрыть' : '▼ Чанки'}
                        </button>
                        <button onClick={() => handleDelete(doc.filename)}
                          className="text-xs px-3 py-1.5 bg-red-900/50 hover:bg-red-800 text-red-300 rounded-lg transition">
                          🗑
                        </button>
                      </div>
                    </div>
                    {previewFile === doc.filename && (
                      <div className="border-t border-gray-700 p-4 space-y-2">
                        {loadingPreview ? <p className="text-sm text-gray-400">Загрузка...</p>
                          : chunks.length > 0 ? chunks.map(chunk => (
                            <div key={chunk.chunk_index} className="bg-gray-700/50 rounded-lg p-3">
                              <p className="text-xs text-gray-500 mb-1">Чанк #{chunk.chunk_index}</p>
                              <p className="text-xs text-gray-300 leading-relaxed">{chunk.text}…</p>
                            </div>
                          )) : <p className="text-sm text-gray-500">Чанки не найдены</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-600">
                <p className="text-4xl mb-2">📭</p>
                <p>База пустая — загрузите первый документ</p>
              </div>
            )}
          </div>
        )}

        {/* Search tab */}
        {tab === 'search' && (
          <div className="space-y-5">
            <div className="flex gap-3">
              <input type="text" value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Например: ГОСТ электробезопасность"
                className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500" />
              <button onClick={handleSearch} disabled={searching || !searchQuery.trim()}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl text-sm font-medium transition">
                {searching ? '⏳ Ищу...' : '🔍 Найти'}
              </button>
            </div>

            {searchError && <div className="p-4 rounded-lg bg-red-900/40 text-red-300 text-sm">{searchError}</div>}

            {candidates.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">Найдено: {candidates.length}. Отметьте нужные.</p>
                  <button onClick={handleApprove} disabled={approving || selected.size === 0}
                    className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-xl text-sm font-medium transition">
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

                {candidates.map(c => (
                  <div key={c.url} onClick={() => !c.already_indexed && toggleSelect(c.url)}
                    className={`rounded-xl p-4 border transition cursor-pointer ${
                      c.already_indexed ? 'border-gray-700 bg-gray-800/40 opacity-60 cursor-default'
                        : selected.has(c.url) ? 'border-blue-500 bg-blue-900/20'
                          : 'border-gray-700 bg-gray-800 hover:border-gray-500'
                    }`}>
                    <div className="flex items-start gap-3">
                      {!c.already_indexed && (
                        <input type="checkbox" checked={selected.has(c.url)}
                          onChange={() => toggleSelect(c.url)}
                          onClick={e => e.stopPropagation()}
                          className="mt-1 w-4 h-4 accent-blue-500" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium truncate">{c.title}</p>
                          {c.is_direct_pdf && <span className="text-xs bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">PDF</span>}
                          {c.is_priority_source && <span className="text-xs bg-green-900/50 text-green-300 px-2 py-0.5 rounded">★ Приоритет</span>}
                          {c.already_indexed && <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded">✓ Уже в базе</span>}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{c.source_domain}</p>
                        {c.snippet && <p className="text-xs text-gray-400 mt-1 line-clamp-2">{c.snippet}</p>}
                        <a href={c.url} target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-xs text-blue-400 hover:underline mt-1 inline-block truncate max-w-full">
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
                <p className="text-4xl mb-2">🔍</p>
                <p>Введите тему и нажмите «Найти»</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Full text modal */}
      {textModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setTextModal(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-700">
              <div>
                <h2 className="font-semibold">📝 {textModal.filename}</h2>
                <p className="text-xs text-gray-500 mt-0.5">Полный извлечённый текст · {textModal.text.length.toLocaleString()} символов</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(textModal.text)}
                  className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                  📋 Копировать
                </button>
                <button onClick={() => setTextModal(null)}
                  className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                  ✕ Закрыть
                </button>
              </div>
            </div>
            <pre className="p-5 overflow-y-auto text-xs text-gray-300 leading-relaxed whitespace-pre-wrap font-mono flex-1">
              {textModal.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
