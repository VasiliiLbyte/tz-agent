'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';

interface TZData {
  id: string;
  status: string;
  content: string;
  quality_score?: number;
  issues_resolved?: number;
  sources?: string[];
}

export default function TZPage() {
  const params = useParams();
  const id = params.id as string;
  const [tz, setTz] = useState<TZData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    const fetchTZ = async () => {
      try {
        const response = await axios.get(`http://localhost:8000/api/tz/${id}`);
        setTz(response.data);
      } catch (err) {
        setError('Не удалось загрузить ТЗ');
      } finally {
        setLoading(false);
      }
    };
    fetchTZ();
  }, [id]);

  const handleApprove = async () => {
    setApproving(true);
    try {
      await axios.patch(`http://localhost:8000/api/tz/${id}/approve`);
      alert('ТЗ одобрено и добавлено в библиотеку');
    } catch (err) {
      alert('Ошибка при одобрении');
    } finally {
      setApproving(false);
    }
  };

  if (loading) return <div className="p-8 text-center">Загрузка...</div>;
  if (error) return <div className="p-8 text-center text-red-500">{error}</div>;
  if (!tz) return <div className="p-8 text-center">ТЗ не найдено</div>;

  const qualityColor = tz.quality_score !== undefined
    ? tz.quality_score >= 80 ? 'bg-green-600'
      : tz.quality_score >= 60 ? 'bg-yellow-600'
      : 'bg-red-600'
    : 'bg-gray-600';

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Техническое задание</h1>
          {tz.quality_score !== undefined && (
            <span className={`px-3 py-1 rounded-full text-sm font-semibold ${qualityColor}`}>
              Quality: {tz.quality_score}
            </span>
          )}
        </div>
        <div className="bg-gray-800 p-6 rounded-lg mb-6">
          <ReactMarkdown className="prose prose-invert max-w-none">
            {tz.content}
          </ReactMarkdown>
        </div>
        <div className="flex gap-4">
          <button
            onClick={handleApprove}
            disabled={approving}
            className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded-lg"
          >
            {approving ? 'Одобрение...' : 'Одобрить и добавить в библиотеку'}
          </button>
          <button
            onClick={() => window.location.href = '/tz/new'}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"
          >
            Создать новое ТЗ
          </button>
        </div>
      </div>
    </div>
  );
}
