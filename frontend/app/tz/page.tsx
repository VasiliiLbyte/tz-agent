'use client';

import { useState, useRef, useEffect } from 'react';
import { Toast, useToast } from '../components/Toast';

const API_TZ = 'http://localhost:8000/api/tz';
const API_LIB = 'http://localhost:8000/api/library';

interface DocumentInfo { filename: string; size_kb: number; chunks: number; }
interface SourceLink { title: string; url: string; standard_id: string; }
interface StandardItem { standard_id: string; score: number; reason: string; }

const STAGE_META: Record<string, { label: string; icon: string; color: string }> = {
  draft:  { label: 'Черновик',        icon: '📝', color: 'text-gray-400' },
  refine: { label: 'Доработка',       icon: '🔧', color: 'text-blue-400' },
  verify: { label: 'Верификация',     icon: '🔬', color: 'text-yellow-400' },
  final:  { label: 'Финальная версия', icon: '✅', color: 'text-green-400' },
};

const ALL_STAGES = ['draft', 'refine', 'verify', 'final'];

export default function TZPage() {
  const { toasts, add: addToast, remove: removeToast, update: updateToast } = useToast();

  const [formData, setFormData] = useState({
    object_type: '', description: '', parameters: '', industry: '', extra_requirements: '',
  });
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [showDocPicker, setShowDocPicker] = useState(false);

  const [loading, setLoading] = useState(false);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [completedStages, setCompletedStages] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState('');

  // Данные по нормативам
  const [localStandards, setLocalStandards] = useState<string[]>([]);
  const [resolvedStandards, setResolvedStandards] = useState<string[]>([]);
  const [standardItems, setStandardItems] = useState<StandardItem[]>([]);
  const [sourceLinks, setSourceLinks] = useState<SourceLink[]>([]);
  const [showSources, setShowSources] = useState(false);

  // Текст по этапам
  const [stageDrafts, setStageDrafts] = useState<Record<string, string>>({});
  const [stageIssues, setStageIssues] = useState<Record<string, string[]>>({});
  const [activeTab, setActiveTab] = useState<string>('draft');
  const [done, setDone] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_LIB}/documents`).then(r => r.json()).then(setDocs).catch(() => {});
  }, []);

  const toggleDoc = (fn: string) =>
    setSelectedDocs(prev => { const n = new Set(prev); n.has(fn) ? n.delete(fn) : n.add(fn); return n; });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setDone(false);
    setStageDrafts({});
    setStageIssues({});
    setCompletedStages(new Set());
    setCurrentStage(null);
    setLocalStandards([]); setResolvedStandards([]); setStandardItems([]); setSourceLinks([]);
    setStatusMessage('');
    setActiveTab('draft');

    const tid = addToast('loading', '🔍 Запуск пайплайна...', true);

    try {
      const response = await fetch(`${API_TZ}/generate-tz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, library_filenames: Array.from(selectedDocs) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('Нет тела ответа');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let activeStage = 'draft';

      while (true) {
        const { done: sd, value } = await reader.read();
        if (sd) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));

            if (msg.type === 'status') {
              setStatusMessage(msg.message);
              updateToast(tid, 'loading', msg.message, true);

            } else if (msg.type === 'standards_found') {
              setLocalStandards(msg.local_standards ?? []);
              setResolvedStandards(msg.resolved_standards ?? []);
              setStandardItems(msg.items ?? []);

            } else if (msg.type === 'reference_sources') {
              setSourceLinks(msg.sources ?? []);

            } else if (msg.type === 'issues') {
              setStageIssues(prev => ({ ...prev, [msg.stage]: msg.issues }));

            } else if (msg.type === 'stage_start') {
              activeStage = msg.stage;
              setCurrentStage(msg.stage);
              setActiveTab(msg.stage);
              const meta = STAGE_META[msg.stage];
              updateToast(tid, 'loading', `${meta.icon} ${meta.label}...`, true);

            } else if (msg.type === 'token') {
              setStageDrafts(prev => ({ ...prev, [msg.stage]: (prev[msg.stage] ?? '') + msg.text }));
              setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);

            } else if (msg.type === 'stage_done') {
              setCompletedStages(prev => new Set([...prev, msg.stage]));

            } else if (msg.type === 'done') {
              setDone(true);
              setCurrentStage(null);
              setStatusMessage('');
              updateToast(tid, 'success', '✅ ТЗ сформировано (4 этапа)');
            }
          } catch {}
        }
      }
    } catch (err: any) {
      updateToast(tid, 'error', `❌ ${err.message}`);
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  };

  const allStandards = Array.from(new Set([...localStandards, ...resolvedStandards])).filter(Boolean);
  const finalText = stageDrafts['final'] || stageDrafts['verify'] || stageDrafts['refine'] || stageDrafts['draft'] || '';

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <Toast toasts={toasts} onRemove={removeToast} />
      <div className="max-w-4xl mx-auto space-y-6">

        <div>
          <h1 className="text-3xl font-bold">📝 Генератор ТЗ</h1>
          <p className="text-gray-400 text-sm mt-1">4 этапа: черновик → доработка (DeepSeek) → верификация → финал</p>
        </div>

        {/* Форма */}
        <form onSubmit={handleSubmit} className="space-y-5 bg-gray-800 p-6 rounded-xl">

          {/* Выбор документов */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-300">
                📚 Документы из библиотеки
                {selectedDocs.size > 0 && <span className="ml-2 text-blue-400 font-bold">({selectedDocs.size} выбрано)</span>}
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
                    <button type="button" onClick={() => toggleDoc(fn)} className="ml-1 hover:text-white">×</button>
                  </span>
                ))}
              </div>
            )}
            {showDocPicker && (
              <div className="bg-gray-700 rounded-xl p-3 space-y-1 max-h-48 overflow-y-auto">
                {docs.length === 0
                  ? <p className="text-sm text-gray-500 text-center py-4">Библиотека пуста — <a href="/library" className="text-blue-400 hover:underline">загрузите документы</a></p>
                  : docs.map(doc => (
                    <label key={doc.filename} className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition ${
                      selectedDocs.has(doc.filename) ? 'bg-blue-900/40' : 'hover:bg-gray-600'
                    }`}>
                      <input type="checkbox" checked={selectedDocs.has(doc.filename)}
                        onChange={() => toggleDoc(doc.filename)} className="w-4 h-4 accent-blue-500" />
                      <span className="text-sm">📄 {doc.filename}</span>
                      <span className="text-xs text-gray-500 ml-auto">{doc.chunks} чанков</span>
                    </label>
                  ))}
              </div>
            )}
          </div>

          <div className="border-t border-gray-700 pt-4 grid grid-cols-1 gap-4">
            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Тип объекта *</label>
              <input type="text" name="object_type" value={formData.object_type} onChange={handleChange} required
                placeholder="насос, ПО, мост, выпрямитель тока..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block mb-1 text-sm font-medium text-gray-300">Описание *</label>
              <textarea name="description" value={formData.description} onChange={handleChange} required rows={3}
                placeholder="Подробное описание назначения и условий эксплуатации..."
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block mb-1 text-sm font-medium text-gray-300">Технические параметры</label>
                <textarea name="parameters" value={formData.parameters} onChange={handleChange} rows={3}
                  placeholder="Q=50 м³/ч, H=40 м, 825 В, 3150 А..."
                  className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div className="space-y-3">
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
                  <label className="block mb-1 text-sm font-medium text-gray-300">Доп. требования</label>
                  <textarea name="extra_requirements" value={formData.extra_requirements} onChange={handleChange} rows={2}
                    placeholder="УХЛ4, IP54, взрывозащита..."
                    className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
            </div>
          </div>

          <button type="submit" disabled={loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded-xl font-semibold transition text-lg">
            {loading ? '⏳ Генерация...' : '🚀 Сформировать ТЗ'}
          </button>
        </form>

        {/* Прогресс пайплайна */}
        {(loading || done) && (
          <div className="bg-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-4">
              {ALL_STAGES.map((sid, idx) => {
                const meta = STAGE_META[sid];
                const isActive = currentStage === sid;
                const isDone = completedStages.has(sid);
                const isPending = !isActive && !isDone;
                return (
                  <div key={sid} className="flex items-center gap-2">
                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                      isDone ? 'bg-green-900/50 text-green-300 border border-green-700'
                      : isActive ? 'bg-blue-900/50 text-blue-300 border border-blue-600 animate-pulse'
                      : 'bg-gray-700 text-gray-500 border border-gray-600'
                    }`}>
                      <span>{isDone ? '✓' : isActive ? '⏳' : meta.icon}</span>
                      <span>{meta.label}</span>
                    </div>
                    {idx < ALL_STAGES.length - 1 && (
                      <span className="text-gray-600">→</span>
                    )}
                  </div>
                );
              })}
            </div>
            {statusMessage && (
              <p className="text-sm text-blue-300 animate-pulse">{statusMessage}</p>
            )}
          </div>
        )}

        {/* Нормативы */}
        {allStandards.length > 0 && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">
                📚 Нормативных документов: <span className="text-blue-400 font-bold">{allStandards.length}</span>
                <span className="ml-2 text-xs text-gray-500">(📁 из библиотеки · 🌐 из интернета)</span>
              </p>
              {sourceLinks.length > 0 && (
                <button onClick={() => setShowSources(!showSources)}
                  className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                  {showSources ? '▲ Скрыть' : `▾ Источники (${sourceLinks.length})`}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {localStandards.filter(Boolean).map(s => (
                <span key={s} className="px-3 py-1 bg-green-900/50 text-green-300 border border-green-800 rounded-full text-xs font-mono">📁 {s}</span>
              ))}
              {resolvedStandards.filter(s => s && !localStandards.includes(s)).map(s => (
                <span key={s} className="px-3 py-1 bg-blue-900/50 text-blue-300 border border-blue-800 rounded-full text-xs font-mono">🌐 {s}</span>
              ))}
            </div>
            {showSources && sourceLinks.length > 0 && (
              <div className="border-t border-gray-700 pt-3 space-y-1">
                {sourceLinks.map((src, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="text-gray-500 font-mono shrink-0 w-32 truncate">{src.standard_id}</span>
                    <a href={src.url} target="_blank" rel="noopener noreferrer"
                      className="text-blue-400 hover:underline truncate">{src.title}</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Вкладки этапов */}
        {Object.keys(stageDrafts).length > 0 && (
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            {/* Табы */}
            <div className="flex border-b border-gray-700">
              {ALL_STAGES.filter(sid => stageDrafts[sid] || completedStages.has(sid) || currentStage === sid).map(sid => {
                const meta = STAGE_META[sid];
                const isDone = completedStages.has(sid);
                const isActive = activeTab === sid;
                const issues = stageIssues[sid] || [];
                return (
                  <button key={sid} onClick={() => setActiveTab(sid)}
                    className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition ${
                      isActive ? 'border-blue-500 text-white bg-gray-700/50'
                      : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-700/30'
                    }`}>
                    <span>{isDone ? '✓' : meta.icon}</span>
                    <span>{meta.label}</span>
                    {issues.length > 0 && (
                      <span className="text-xs bg-orange-900/60 text-orange-300 border border-orange-700 px-1.5 rounded-full">
                        {issues.length}
                      </span>
                    )}
                  </button>
                );
              })}
              {done && (
                <div className="ml-auto flex items-center pr-4 gap-2">
                  <button onClick={() => navigator.clipboard.writeText(finalText)}
                    className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                    📋 Копировать финал
                  </button>
                </div>
              )}
            </div>

            {/* Замечания DeepSeek */}
            {stageIssues[activeTab]?.length > 0 && (
              <div className="border-b border-gray-700 p-4 bg-orange-900/10">
                <p className="text-xs font-semibold text-orange-300 mb-2">🤖 Замечания DeepSeek ({stageIssues[activeTab].length}):</p>
                <ul className="space-y-1">
                  {stageIssues[activeTab].map((issue, i) => (
                    <li key={i} className="text-xs text-orange-200/80 leading-relaxed">• {issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Текст этапа */}
            <div ref={outputRef}
              className="p-6 whitespace-pre-wrap text-sm text-gray-300 leading-relaxed max-h-[65vh] overflow-y-auto font-mono">
              {stageDrafts[activeTab] || ''}
              {currentStage === activeTab && !completedStages.has(activeTab) && (
                <span className="animate-pulse text-blue-400">█</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
