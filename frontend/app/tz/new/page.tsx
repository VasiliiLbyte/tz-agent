'use client';

import { useState, useRef } from 'react';

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

export default function NewTZPage() {
  const [formData, setFormData] = useState({
    object_type: '',
    description: '',
    parameters: '',
    industry: '',
    extra_requirements: '',
  });
  const [loading, setLoading] = useState(false);

  // локальные стандарты из RAG
  const [localStandards, setLocalStandards] = useState<string[]>([]);
  // веб-стандарты из Tavily
  const [resolvedStandards, setResolvedStandards] = useState<string[]>([]);
  // детали по каждому стандарту
  const [standardItems, setStandardItems] = useState<StandardItem[]>([]);
  // ссылки на источники
  const [sourceLinks, setSourceLinks] = useState<SourceLink[]>([]);

  const [output, setOutput] = useState('');
  const [done, setDone] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setOutput('');
    setLocalStandards([]);
    setResolvedStandards([]);
    setStandardItems([]);
    setSourceLinks([]);
    setDone(false);
    setShowSources(false);

    try {
      const response = await fetch('http://localhost:8000/api/tz/generate-tz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
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
            } else if (msg.type === 'reference_sources') {
              setSourceLinks(msg.sources ?? []);
            } else if (msg.type === 'token') {
              setOutput((prev) => prev + msg.text);
              setTimeout(() => {
                outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
              }, 0);
            } else if (msg.type === 'done') {
              setDone(true);
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setOutput(`\n\n[ОШИБКА: ${err.message}]`);
    } finally {
      setLoading(false);
    }
  };

  const allStandards = Array.from(new Set([...localStandards, ...resolvedStandards])).filter(Boolean);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-3xl font-bold">Генератор технического задания</h1>

        {/* Форма */}
        <form onSubmit={handleSubmit} className="space-y-5 bg-gray-800 p-6 rounded-xl">
          <div>
            <label className="block mb-1 text-sm font-medium text-gray-300">
              Тип объекта *
            </label>
            <input
              type="text"
              name="object_type"
              value={formData.object_type}
              onChange={handleChange}
              required
              placeholder="насос, ПО для учёта, мост, система вентиляции..."
              className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm font-medium text-gray-300">
              Описание *
            </label>
            <textarea
              name="description"
              value={formData.description}
              onChange={handleChange}
              required
              rows={3}
              placeholder="Центробежный насос для систем водоснабжения жилых зданий..."
              className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm font-medium text-gray-300">
              Технические параметры
            </label>
            <textarea
              name="parameters"
              value={formData.parameters}
              onChange={handleChange}
              rows={2}
              placeholder="Q=50 м3/ч, H=40 м, мощность 15 кВт..."
              className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block mb-1 text-sm font-medium text-gray-300">Отрасль</label>
            <select
              name="industry"
              value={formData.industry}
              onChange={handleChange}
              className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            >
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
            <label className="block mb-1 text-sm font-medium text-gray-300">
              Дополнительные требования
            </label>
            <textarea
              name="extra_requirements"
              value={formData.extra_requirements}
              onChange={handleChange}
              rows={2}
              placeholder="Климатическое исполнение УХЛ4, взрывозащита..."
              className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-semibold transition"
          >
            {loading ? '⏳ Генерация...' : '🚀 Сгенерировать ТЗ'}
          </button>
        </form>

        {/* Найденные стандарты */}
        {allStandards.length > 0 && (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-300">
                📚 Найдено нормативных документов: <span className="text-blue-400 font-bold">{allStandards.length}</span>
              </p>
              {sourceLinks.length > 0 && (
                <button
                  onClick={() => setShowSources(!showSources)}
                  className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition text-gray-300"
                >
                  {showSources ? '▲ Скрыть источники' : `▼ Источники (${sourceLinks.length})`}
                </button>
              )}
            </div>

            {/* Бейджи стандартов */}
            <div className="flex flex-wrap gap-2">
              {localStandards.filter(Boolean).map((s) => (
                <span key={`local-${s}`} className="px-3 py-1 bg-green-900 text-green-200 rounded-full text-xs font-mono">
                  📁 {s}
                </span>
              ))}
              {resolvedStandards.filter(s => s && !localStandards.includes(s)).map((s) => (
                <span key={`web-${s}`} className="px-3 py-1 bg-blue-900 text-blue-200 rounded-full text-xs font-mono">
                  🌐 {s}
                </span>
              ))}
            </div>

            {/* Детали по стандартам — топ-3 с основаниями */}
            {standardItems.length > 0 && (
              <div className="space-y-2 mt-2">
                {standardItems.slice(0, 3).map((item) => (
                  <div key={item.standard_id} className="bg-gray-700 rounded-lg p-3 text-xs text-gray-400">
                    <span className="text-white font-mono font-semibold">{item.standard_id}</span>
                    {item.reason && (
                      <p className="mt-1 leading-relaxed">{item.reason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Источники (раскрываемый блок) */}
            {showSources && sourceLinks.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-gray-700 pt-3">
                <p className="text-xs text-gray-500 mb-2">🔗 Источники из интернета:</p>
                {sourceLinks.map((src, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-500 font-mono shrink-0">{src.standard_id}</span>
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 hover:underline truncate"
                      title={src.title}
                    >
                      {src.title}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Вывод текста */}
        {output && (
          <div className="bg-gray-800 rounded-xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">
                {done ? '✅ Черновик ТЗ' : '✍️ Генерация...'}
              </h2>
              {done && (
                <button
                  onClick={() => navigator.clipboard.writeText(output)}
                  className="text-sm px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg transition"
                >
                  📋 Скопировать
                </button>
              )}
            </div>
            <div
              ref={outputRef}
              className="whitespace-pre-wrap text-sm text-gray-300 leading-relaxed max-h-[60vh] overflow-y-auto"
            >
              {output}
              {!done && <span className="animate-pulse text-blue-400">▌</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
