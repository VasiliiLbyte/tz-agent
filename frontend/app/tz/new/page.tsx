'use client';

import { useState, useRef } from 'react';

export default function NewTZPage() {
  const [formData, setFormData] = useState({
    object_type: '',
    description: '',
    parameters: '',
    industry: '',
    extra_requirements: '',
  });
  const [loading, setLoading] = useState(false);
  const [standards, setStandards] = useState<string[]>([]);
  const [output, setOutput] = useState('');
  const [done, setDone] = useState(false);
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
    setStandards([]);
    setDone(false);

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
              setStandards(msg.standards.filter(Boolean));
            } else if (msg.type === 'token') {
              setOutput((prev) => prev + msg.text);
              // авто-скролл вниз
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
        {standards.length > 0 && (
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-sm text-gray-400 mb-2">📚 Найденные стандарты в базе:</p>
            <div className="flex flex-wrap gap-2">
              {standards.map((s) => (
                <span key={s} className="px-3 py-1 bg-blue-900 text-blue-200 rounded-full text-sm">
                  {s}
                </span>
              ))}
            </div>
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
