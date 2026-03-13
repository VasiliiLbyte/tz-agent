'use client';

import { useState, useRef, useEffect } from 'react';
import { Toast, useToast } from '../components/Toast';

const API_TZ = 'http://localhost:8000/api/tz';
const API_LIB = 'http://localhost:8000/api/library';

interface DocumentInfo {
  filename: string;
  size_kb: number;
  chunks: number;
}

interface SourceLink {
  title: string;
  url: string;
  standard_id: string;
}

interface StandardItem {
  standard_id: string;
  score: number;
  reason: string;
  evidence: string[];
}

export default function TZPage() {
  const { toasts, add: addToast, remove: removeToast, update: updateToast } = useToast();

  const [formData, setFormData] = useState({
    object_type: '',
    description: '',
    parameters: '',
    industry: '',
    extra_requirements: '',
  });

  // Библиотека
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [showDocPicker, setShowDocPicker] = useState(false);

  // Результаты
  const [loading, setLoading] = useState(false);
  const [localStandards, setLocalStandards] = useState<string[]>([]);
  const [resolvedStandards, setResolvedStandards] = useState<string[]>([]);
  const [standardItems, setStandardItems] = useState<StandardItem[]>([]);
  const [sourceLinks, setSourceLinks] = useState<SourceLink[]>([]);
  const [output, setOutput] = useState('');
  const [done, setDone] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [streamStep, setStreamStep] = useState<string>('');
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_LIB}/documents`)
      .then(r => r.json())
      .then(setDocs)
      .catch(() => {});
  }, []);

  const toggleDoc = (filename: string) => {
    setSelectedDocs(prev => {
      const n = new Set(prev);
      n.has(filename) ? n.delete(filename) : n.add(filename);
      return n;
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setOutput('');
    setLocalStandards([]); setResolvedStandards([]); setStandardItems([]); setSourceLinks([]);
    setDone(false); setShowSources(false);
    setStreamStep('🔍 Ищу нормативные документы...');

    const tid = addToast('loading', '🔍 Ищу нормативы...', true);

    try {
      const body = {
        ...formData,
        library_filenames: Array.from(selectedDocs),
      };

      const response = await fetch(`${API_TZ}/generate-tz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('Нет тела ответа');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.type === 'standards_found') {
              setLocalStandards((msg.local_standards ?? []).filter(Boolean));
              setResolvedStandards((msg.resolved_standards ?? []).filter(Boolean));
              setStandardItems(msg.items ?? []);
              const cnt = (msg.local_standards ?? []).length + (msg.resolved_standards ?? []).length;
              setStreamStep(`✅ Найдено ${cnt} нормативов. Генерирую ТЗ...`);
              updateToast(tid, 'loading', `✅ Найдено ${cnt} нормативов. Генерирую ТЗ...`, true);
            } else if (msg.type === 'reference_sources') {
              setSourceLinks(msg.sources ?? []);
            } else if (msg.type === 'token') {
              setOutput(prev => prev + msg.text);
              setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
            } else if (msg.type === 'done') {
              setDone(true);
              setStreamStep('');
              updateToast(tid, 'success', '✅ ТЗ успешно сформировано');
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setOutput(`\n\n[ОШИБКА: ${err.message}]`);
      updateToast(tid, 'error', `❌ ${err.message}`);
      setStreamStep('');
    } finally {
      setLoading(false);
    }
  };

  const allStandards = Array.from(new Set([...localStandards, ...resolvedStandards])).filter(Boolean);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <Toast toasts={toasts} onRemove={removeToast} />
      <div className="max-w-3xl mx-auto space-y-6">

        <div>
          <h1 className="text-3xl font-bold">📝 Генератор ТЗ</h1>
          <p className="text-gray-400 text-sm mt-1">Автоматически формирует ТЗ на основе вашего описания и нормативной базы</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 bg-gray-800 p-6 rounded-xl">

          {/* Выбор документов из библиотеки */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-300">
                📚 Документы из библиотеки
                {selectedDocs.size > 0 && (
                  <span className="ml-2 text-blue-400 font-bold">({selectedDocs.size} выбрано)</span>
                )}
              </label>
              <button type="button" onClick={() => setShowDocPicker(p => !p)}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                {showDocPicker ? '▲ Свернуть' : '▾ Выбрать'}
              </button>
            </div>

            {selectedDocs.size > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {Array.from(selectedDocs).map(fn => (
                  <span key={fn} className="flex items-center gap-1 text-xs bg-blue-900/50 text-blue-300 border border-blue-700 px-2 py-1 rounded-lg">
                    📄 {fn}
                    <button type="button" onClick={() => toggleDoc(fn)} className="text-blue-400 hover:text-white ml-1">×</button>
                  </span>
                ))}
              </div>
            )}

            {showDocPicker && (
              <div className="bg-gray-700 rounded-xl p-3 space-y-2 max-h-52 overflow-y-auto">
                {docs.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">
                    Библиотека пуста — <a href="/library" className="text-blue-400 hover:underline">загрузите документы</a>
                  </p>
                ) : docs.map(doc => (
                  <label key={doc.filename}
                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition ${
                      selectedDocs.has(doc.filename) ? 'bg-blue-900/40' : 'hover:bg-gray-600'
                    }`}>
                    <input type="checkbox" checked={selectedDocs.has(doc.filename)}
                      onChange={() => toggleDoc(doc.filename)}
                      className="w-4 h-4 accent-blue-500" />
                    <span className="text-sm">📄 {doc.filename}</span>
                    <span className="text-xs text-gray-500 ml-auto">{doc.chunks} чанков</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-gray-700 pt-5 space-y-4">
            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Тип объекта *</label>
              <input type="text" name="object_type" value={formData.object_type} onChange={handleChange} required
                placeholder="насос, ПО для учёта, мост, система вентиляции..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>

            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Описание *</label>
              <textarea name="description" value={formData.description} onChange={handleChange} required rows={3}
                placeholder="Центробежный насос для систем водоснабжения..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>

            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Технические параметры</label>
              <textarea name="parameters" value={formData.parameters} onChange={handleChange} rows={2}
                placeholder="Q=50 м3/ч, H=40 м, мощность 15 кВт..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>

            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Отрасль</label>
              <select name="industry" value={formData.industry} onChange={handleChange}
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">— не указана —</option>
                <option value="construction">Строительство</option>
                <option value="energy">Энергетика</option>
                <option value="it">Информационные технологии</option>
                <option value="transport">Транспорт</option>
                <option value="industry">Промышленность</option>
                <option value="water">Водоснабжение / ЖКХ</option>
              </select>
            </div>

            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Дополнительные требования</label>
              <textarea name="extra_requirements" value={formData.extra_requirements} onChange={handleChange} rows={2}
                placeholder="Климатическое исполнение УХЛ4, взрывозащита..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
          </div>

          <button type="submit" disabled={loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded-xl font-semibold transition text-lg">
            {loading ? '⏳ Генерация...' : '🚀 Сформировать ТЗ'}
          </button>
        </form>

        {/* Статус генерации */}
        {loading && streamStep && (
          <div className="flex items-center gap-3 text-blue-400 text-sm bg-blue-900/20 border border-blue-800 rounded-xl p-4">
            <span className="animate-spin text-lg">⏳</span>
            <span>{streamStep}</span>
          </div>
        )}

        {/* Найденные стандарты */}
        {allStandards.length > 0 && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">
                📚 Найдено нормативных документов: <span className="text-blue-400 font-bold">{allStandards.length}</span>
              </p>
              {sourceLinks.length > 0 && (
                <button onClick={() => setShowSources(!showSources)}
                  className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition text-gray-300">
                  {showSources ? '▲ Скрыть' : `▾ Источники (${sourceLinks.length})`}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {localStandards.filter(Boolean).map(s => (
                <span key={s} className="px-3 py-1 bg-green-900 text-green-200 rounded-full text-xs font-mono">📁 {s}</span>
              ))}
              {resolvedStandards.filter(s => s && !localStandards.includes(s)).map(s => (
                <span key={s} className="px-3 py-1 bg-blue-900 text-blue-200 rounded-full text-xs font-mono">🌐 {s}</span>
              ))}
            </div>
            {standardItems.slice(0, 3).map(item => (
              <div key={item.standard_id} className="bg-gray-700 rounded-lg p-3 text-xs text-gray-400">
                <span className="text-white font-mono font-semibold">{item.standard_id}</span>
                {item.reason && <p className="mt-1">{item.reason}</p>}
              </div>
            ))}
            {showSources && sourceLinks.length > 0 && (
              <div className="border-t border-gray-700 pt-3 space-y-1">
                {sourceLinks.map((src, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="text-gray-500 font-mono shrink-0">{src.standard_id}</span>
                    <a href={src.url} target="_blank" rel="noopener noreferrer"
                      className="text-blue-400 hover:underline truncate">{src.title}</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Текст ТЗ */}
        {output && (
          <div className="bg-gray-800 rounded-xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">
                {done ? '✅ Черновик ТЗ' : '✍️ Генерация...'}
              </h2>
              {done && (
                <button onClick={() => navigator.clipboard.writeText(output)}
                  className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                  📋 Скопировать
                </button>
              )}
            </div>
            <div ref={outputRef}
              className="whitespace-pre-wrap text-sm text-gray-300 leading-relaxed max-h-[60vh] overflow-y-auto">
              {output}
              {!done && <span className="animate-pulse text-blue-400">█</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
