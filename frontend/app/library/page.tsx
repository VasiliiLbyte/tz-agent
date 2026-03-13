'use client';

import { useState, useRef, useEffect } from 'react';
import { Toast, useToast } from '../components/Toast';

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
  relevance_pct: number;
}

const API = 'http://localhost:8000/api/library';

function RelevanceBadge({ pct }: { pct: number }) {
  const color =
    pct >= 75 ? 'bg-green-900/60 text-green-300 border-green-700'
    : pct >= 50 ? 'bg-yellow-900/60 text-yellow-300 border-yellow-700'
    : 'bg-gray-800 text-gray-400 border-gray-600';
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${color}`}>
      {pct}%
    </span>
  );
}

// Прогресс-бар для длинных операций
function ProgressBar({ label, step, total }: { label: string; step: number; total: number }) {
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <div className="flex justify-between text-sm mb-2">
        <span className="text-gray-300">{label}</span>
        <span className="text-blue-400 font-medium">{pct}%</span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div
          className="bg-blue-500 h-2 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1">{step} / {total}</p>
    </div>
  );
}

export default function LibraryPage() {
  const [tab, setTab] = useState<'library' | 'search'>('library');
  const { toasts, add: addToast, remove: removeToast, update: updateToast } = useToast();

  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ step: number; total: number; label: string } | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkPreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [textModal, setTextModal] = useState<{ filename: string; text: string } | null>(null);
  const [loadingText, setLoadingText] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [approveProgress, setApproveProgress] = useState<{ step: number; total: number } | null>(null);
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
    setUploadProgress(null);
    const tid = addToast('loading', `📄 Загружаю ${file.name}...`, true);

    // Показываем этапы
    const steps = [
      'Читаю файл...',
      'Извлекаю текст...',
      'Создаю эмбеддинги...',
      'Сохраняю в базу...',
    ];
    let stepIdx = 0;
    setUploadProgress({ step: 0, total: steps.length, label: steps[0] });

    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      setUploadProgress({ step: stepIdx, total: steps.length, label: steps[stepIdx] });
      updateToast(tid, 'loading', `⏳ ${steps[stepIdx]}`);
    }, 3000);

    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      clearInterval(stepTimer);
      setUploadProgress(null);
      if (res.ok) {
        updateToast(tid, 'success', `✅ ${data.filename} — ${data.chunks_added} чанков добавлено`);
        loadDocuments();
      } else {
        updateToast(tid, 'error', `❌ ${data.detail}`);
      }
    } catch (e: any) {
      clearInterval(stepTimer);
      setUploadProgress(null);
      updateToast(tid, 'error', `❌ ${e.message}`);
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
    setPreviewFile(filename); setLoadingPreview(true);
    try {
      const res = await fetch(`${API}/preview?filename=${encodeURIComponent(filename)}&limit=5`);
      setChunks(await res.json());
    } catch {}
    setLoadingPreview(false);
  };

  const openFullText = async (filename: string) => {
    setLoadingText(filename);
    const tid = addToast('loading', `📖 Загружаю текст ${filename}...`, true);
    try {
      const res = await fetch(`${API}/text?filename=${encodeURIComponent(filename)}`);
      const data = await res.json();
      if (res.ok) {
        updateToast(tid, 'success', `✅ Текст загружен (${data.text.length.toLocaleString()} символов)`);
        setTextModal({ filename, text: data.text });
      } else {
        updateToast(tid, 'error', `❌ ${data.detail}`);
      }
    } catch (e: any) {
      updateToast(tid, 'error', `❌ ${e.message}`);
    } finally {
      setLoadingText(null);
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Удалить «${filename}»?`)) return;
    const tid = addToast('loading', `🗑 Удаляю ${filename}...`, true);
    await fetch(`${API}/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    updateToast(tid, 'success', `✅ ${filename} удалён`);
    setPreviewFile(null);
    loadDocuments();
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setCandidates([]); setSelected(new Set()); setSearchError(null);
    const tid = addToast('loading', `🔍 Ищу документы по запросу...`, true);
    try {
      const res = await fetch(`${API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      if (res.ok) {
        updateToast(tid, 'success', `✅ Найдено ${data.length} уникальных документов`);
        setCandidates(data);
      } else {
        updateToast(tid, 'error', `❌ ${data.detail}`);
        setSearchError(data.detail);
      }
    } catch (e: any) {
      updateToast(tid, 'error', `❌ ${e.message}`);
      setSearchError(e.message);
    }
    setSearching(false);
  };

  const toggleSelect = (url: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n; });
  };

  const handleApprove = async () => {
    const toApprove = candidates.filter(c => selected.has(c.url) && !c.already_indexed);
    if (!toApprove.length) return;
    setApproving(true);
    setApproveProgress({ step: 0, total: toApprove.length });
    const globalTid = addToast('loading', `⬇️ Скачиваю ${toApprove.length} документов...`, true);

    let ok = 0; let fail = 0;
    for (let i = 0; i < toApprove.length; i++) {
      const c = toApprove[i];
      const tid = addToast('loading', `⬇️ [${i+1}/${toApprove.length}] ${c.title.slice(0, 50)}...`, true);
      try {
        const res = await fetch(`${API}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: c.url, filename: c.filename }),
        });
        const data = await res.json();
        if (res.ok) {
          updateToast(tid, 'success', `✅ ${data.filename} — ${data.chunks_added} чанков`);
          ok++;
        } else {
          updateToast(tid, 'error', `❌ ${c.filename}: ${data.detail}`);
          fail++;
        }
      } catch (e: any) {
        updateToast(tid, 'error', `❌ ${c.filename}: ${e.message}`);
        fail++;
      }
      setApproveProgress({ step: i + 1, total: toApprove.length });
    }

    updateToast(globalTid, fail === 0 ? 'success' : 'info',
      `Готово: ${ok} добавлено${fail > 0 ? `, ${fail} ошибок` : ''}`);
    setApproving(false);
    setApproveProgress(null);
    loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <Toast toasts={toasts} onRemove={removeToast} />
      <div className="max-w-4xl mx-auto space-y-6">

        <div>
          <h1 className="text-3xl font-bold">📚 Библиотека</h1>
          <p className="text-gray-400 text-sm mt-1">ГОСТы, ТЗ-аналоги, паспорта — используются при генерации ТЗ</p>
        </div>

        <div className="flex gap-2 border-b border-gray-700">
          {(['library', 'search'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}>
              {t === 'library' ? '📂 Мои документы' : '🔍 Найти документы'}
            </button>
          ))}
        </div>

        {tab === 'library' && (
          <div className="space-y-5">
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !uploading && fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 text-center transition ${
                uploading ? 'border-blue-500 bg-blue-900/10 cursor-wait'
                  : dragOver ? 'border-blue-400 bg-blue-900/20 cursor-copy'
                  : 'border-gray-600 hover:border-gray-400 cursor-pointer'
              }`}>
              <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md"
                className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
              {uploading ? (
                <div className="space-y-3">
                  <p className="text-blue-400 text-lg">⏳ Обрабатываю файл...</p>
                  {uploadProgress && (
                    <ProgressBar
                      label={uploadProgress.label}
                      step={uploadProgress.step}
                      total={uploadProgress.total}
                    />
                  )}
                </div>
              ) : (
                <>
                  <p className="text-4xl mb-2">📄</p>
                  <p className="text-gray-300">Перетащите файл или нажмите для выбора</p>
                  <p className="text-gray-500 text-sm mt-1">PDF, DOCX, TXT, MD — до 20 МБ</p>
                </>
              )}
            </div>

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
                        <button onClick={() => openFullText(doc.filename)} disabled={loadingText === doc.filename}
                          className="text-xs px-3 py-1.5 bg-indigo-900/50 hover:bg-indigo-800 text-indigo-300 rounded-lg transition disabled:opacity-50">
                          {loadingText === doc.filename ? '⏳' : '📝'} Текст
                        </button>
                        <button onClick={() => loadPreview(doc.filename)}
                          className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                          {previewFile === doc.filename ? '▲ Скрыть' : '▾ Чанки'}
                        </button>
                        <button onClick={() => handleDelete(doc.filename)}
                          className="text-xs px-3 py-1.5 bg-red-900/50 hover:bg-red-800 text-red-300 rounded-lg transition">
                          🗑
                        </button>
                      </div>
                    </div>
                    {previewFile === doc.filename && (
                      <div className="border-t border-gray-700 p-4 space-y-2">
                        {loadingPreview
                          ? <p className="text-sm text-gray-400">Загрузка...</p>
                          : chunks.map(chunk => (
                            <div key={chunk.chunk_index} className="bg-gray-700/50 rounded-lg p-3">
                              <p className="text-xs text-gray-500 mb-1">Чанк #{chunk.chunk_index}</p>
                              <p className="text-xs text-gray-300 leading-relaxed">{chunk.text}…</p>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-600">
                <p className="text-4xl mb-2">🗄️</p>
                <p>База пустая — загрузите первый документ</p>
              </div>
            )}
          </div>
        )}

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

            {searching && (
              <div className="flex items-center gap-3 text-blue-400 text-sm bg-blue-900/20 border border-blue-800 rounded-xl p-4">
                <span className="animate-spin text-lg">⏳</span>
                <span>Отправляю запрос в Tavily, ищу по ГОСТ-базам...</span>
              </div>
            )}

            {searchError && <div className="p-4 rounded-lg bg-red-900/40 text-red-300 text-sm">{searchError}</div>}

            {candidates.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">
                    Найдено: <span className="text-white font-medium">{candidates.length}</span> уникальных документов
                  </p>
                  <button onClick={handleApprove} disabled={approving || selected.size === 0}
                    className="px-5 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded-xl text-sm font-medium transition">
                    {approving ? '⏳ Добавляю...' : `➕ Добавить (${selected.size})`}
                  </button>
                </div>

                {approveProgress && (
                  <ProgressBar
                    label="Скачивание и индексация..."
                    step={approveProgress.step}
                    total={approveProgress.total}
                  />
                )}

                {candidates.map(c => (
                  <div key={c.url}
                    onClick={() => !c.already_indexed && toggleSelect(c.url)}
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
                          <p className="text-sm font-medium truncate flex-1">{c.title}</p>
                          <RelevanceBadge pct={c.relevance_pct} />
                          {c.is_direct_pdf && <span className="text-xs bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">PDF</span>}
                          {c.is_priority_source && <span className="text-xs bg-green-900/50 text-green-300 px-2 py-0.5 rounded">★</span>}
                          {c.already_indexed && <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded">✓ В базе</span>}
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

      {textModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setTextModal(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-700">
              <div>
                <h2 className="font-semibold">📝 {textModal.filename}</h2>
                <p className="text-xs text-gray-500 mt-0.5">{textModal.text.length.toLocaleString()} символов</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => navigator.clipboard.writeText(textModal.text)}
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
