'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';

export default function NewTZPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    title: '',
    equipment_type: '',
    parameters: '',
    requirements: ''
  });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setProgress('Отправка запроса...');
    setErrorDetail(null);

    try {
      console.log('Отправляю данные:', formData);
      const response = await axios.post('/api/tz/generate', formData);
      console.log('Ответ от сервера (полный):', response);
      console.log('Ответ data:', response.data);
      
      // Показываем alert с содержимым ответа
      alert('Ответ сервера: ' + JSON.stringify(response.data, null, 2));
      
      const tzId = response.data.id;
      if (!tzId) {
        throw new Error('В ответе нет поля id. Поля ответа: ' + Object.keys(response.data).join(', '));
      }
      
      setProgress('ТЗ создано, перенаправление...');
      router.push(`/tz/${tzId}`);
    } catch (error: any) {
      console.error('Детальная ошибка:', error);
      
      let errorMessage = 'Неизвестная ошибка';
      if (error.response) {
        errorMessage = `Ошибка ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      } else if (error.request) {
        errorMessage = 'Сервер не отвечает. Проверьте, запущен ли бэкенд.';
      } else {
        errorMessage = error.message;
      }
      
      setProgress(`Ошибка: ${errorMessage}`);
      setErrorDetail(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Создание нового технического задания</h1>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block mb-2 text-sm font-medium">Название ТЗ</label>
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleChange}
              required
              className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block mb-2 text-sm font-medium">Тип оборудования</label>
            <input
              type="text"
              name="equipment_type"
              value={formData.equipment_type}
              onChange={handleChange}
              required
              className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block mb-2 text-sm font-medium">Технические параметры</label>
            <textarea
              name="parameters"
              value={formData.parameters}
              onChange={handleChange}
              rows={4}
              required
              className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block mb-2 text-sm font-medium">Дополнительные требования</label>
            <textarea
              name="requirements"
              value={formData.requirements}
              onChange={handleChange}
              rows={4}
              className="w-full p-3 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-medium transition"
          >
            {loading ? 'Генерация...' : 'Сгенерировать ТЗ'}
          </button>
          {progress && <p className="text-center text-gray-400">{progress}</p>}
          {errorDetail && <p className="text-center text-red-500">{errorDetail}</p>}
        </form>
      </div>
    </div>
  );
}
