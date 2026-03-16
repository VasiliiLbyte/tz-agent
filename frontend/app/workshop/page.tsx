'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

const API = 'http://localhost:8000/api/workshop';

interface TZItem {
  id: string; title: string; object_type: string;
  industry: string; status: string; created_at: string;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  saved:    { label: 'Сохранено',   color: 'bg-gray-700 text-gray-300' },
  reviewed: { label: 'Проверено',   color: 'bg-blue-900/60 text-blue-300' },
  refined:  { label: 'Доработано',  color: 'bg-green-900/60 text-green-300' },
};

export default function WorkshopPage() {
  const [items, setItems] = useState<TZItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch(`${API}/list`).then(r => r.json()).then(data => { setItems(data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const del = async (id: string) => {
    if (!confirm('Удалить ТЗ?')) return;
    await fetch(`${API}/${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">🛠️ Мастерская ТЗ</h1>
            <p className="text-gray-400 text-sm mt-1">Сохранённые технические задания для доработки</p>
          </div>
          <Link href="/tz" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition">
            + Новое ТЗ
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-16 text-gray-500">Загрузка...</div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 space-y-4">
            <p className="text-5xl">📭</p>
            <p className="text-gray-400">Нет сохранённых ТЗ</p>
            <Link href="/tz" className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-medium transition">
              Создать первое ТЗ
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map(item => {
              const st = STATUS_LABEL[item.status] || STATUS_LABEL.saved;
              return (
                <div key={item.id} className="bg-gray-800 rounded-xl p-5 flex items-center gap-4 hover:bg-gray-750 transition">
                  <div className="text-3xl">📄</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{item.title}</p>
                    <p className="text-sm text-gray-400 mt-0.5">
                      {item.object_type && <span className="mr-3">🔧 {item.object_type}</span>}
                      {item.industry && <span className="mr-3">🏭 {item.industry}</span>}
                      <span className="text-gray-600">{new Date(item.created_at).toLocaleDateString('ru-RU')}</span>
                    </p>
                  </div>
                  <span className={`text-xs px-3 py-1 rounded-full font-medium ${st.color}`}>{st.label}</span>
                  <div className="flex gap-2">
                    <Link href={`/workshop/${item.id}`}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition">
                      Открыть
                    </Link>
                    <button onClick={() => del(item.id)}
                      className="px-3 py-2 bg-gray-700 hover:bg-red-900/50 hover:text-red-300 rounded-lg text-sm transition">
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
