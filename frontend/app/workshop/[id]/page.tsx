'use client';
import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const API = 'http://localhost:8000/api/workshop';

interface Question { question: string; section: string; why: string; }
interface ReviewData {
  technical: string[]; normative: string[]; completeness: string[]; total: number;
}

const TAB_META = [
  { id: 'content',   label: '📄 Текст ТЗ' },
  { id: 'review',    label: '🔍 Проверка' },
  { id: 'questions', label: '❓ Вопросы' },
  { id: 'refine',    label: '✍️ Доработка' },
];

export default function WorkshopItemPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('content');

  // review
  const [review, setReview] = useState<ReviewData | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  // questions
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  // refine
  const [refineText, setRefineText] = useState('');
  const [refineIssues, setRefineIssues] = useState<string[]>([]);
  const [refineLoading, setRefineLoading] = useState(false);
  const [refineDone, setRefineDone] = useState(false);
  const [refineStatus, setRefineStatus] = useState('');
  const refineRef = useRef<HTMLDivElement>(null);

  // copy
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`${API}/${id}`).then(r => r.json()).then(data => { setItem(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  const runReview = async () => {
    setReviewLoading(true);
    setTab('review');
    const res = await fetch(`${API}/${id}/review`, { method: 'POST' });
    const data = await res.json();
    setReview(data);
    setReviewLoading(false);
  };

  const runQuestions = async () => {
    setQuestionsLoading(true);
    setTab('questions');
    const res = await fetch(`${API}/${id}/questions`, { method: 'POST' });
    const data = await res.json();
    setQuestions(data.questions || []);
    setQuestionsLoading(false);
  };

  const runRefine = async () => {
    setRefineLoading(true);
    setRefineDone(false);
    setRefineText('');
    setRefineIssues([]);
    setRefineStatus('');
    setTab('refine');

    const answersMap: Record<string, string> = {};
    questions.forEach((q, i) => { if (answers[i]) answersMap[q.question] = answers[i]; });

    const res = await fetch(`${API}/${id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answersMap }),
    });
    if (!res.body) { setRefineLoading(false); return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status') setRefineStatus(msg.message);
          else if (msg.type === 'issues') setRefineIssues(msg.issues);
          else if (msg.type === 'token') {
            setRefineText(t => t + msg.text);
            setTimeout(() => refineRef.current?.scrollTo(0, refineRef.current.scrollHeight), 0);
          }
          else if (msg.type === 'done') { setRefineDone(true); setRefineStatus(''); }
        } catch {}
      }
    }
    setRefineLoading(false);
    // обновим item
    fetch(`${API}/${id}`).then(r => r.json()).then(setItem);
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-gray-400">Загрузка...</div>;
  if (!item) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-red-400">ТЗ не найдено</div>;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Шапка */}
        <div className="flex items-start gap-4">
          <Link href="/workshop" className="text-gray-400 hover:text-white transition pt-1">← Назад</Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{item.title}</h1>
            <p className="text-sm text-gray-400 mt-1">
              {item.object_type && <span className="mr-3">🔧 {item.object_type}</span>}
              {item.industry && <span className="mr-3">🏭 {item.industry}</span>}
              <span className="text-gray-600">{new Date(item.created_at).toLocaleDateString('ru-RU')}</span>
            </p>
          </div>
          {/* Инструменты */}
          <div className="flex gap-2 flex-wrap justify-end">
            <button onClick={runReview} disabled={reviewLoading}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {reviewLoading ? '⏳ Проверка...' : '🔍 Проверить'}
            </button>
            <button onClick={runQuestions} disabled={questionsLoading}
              className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {questionsLoading ? '⏳ Вопросы...' : '❓ Вопросы'}
            </button>
            <button onClick={runRefine} disabled={refineLoading}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {refineLoading ? '⏳ Доработка...' : '✍️ Доработать'}
            </button>
          </div>
        </div>

        {/* Вкладки */}
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="flex border-b border-gray-700">
            {TAB_META.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition ${
                  tab === t.id ? 'border-blue-500 text-white bg-gray-700/50' : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}>
                {t.label}
              </button>
            ))}
            <div className="ml-auto flex items-center pr-4">
              <button onClick={() => copyText(refineDone ? refineText : item.content)}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                {copied ? '✅ Скопировано' : '📋 Копировать'}
              </button>
            </div>
          </div>

          {/* Текст ТЗ */}
          {tab === 'content' && (
            <div className="p-6 whitespace-pre-wrap text-sm text-gray-300 leading-relaxed font-mono max-h-[70vh] overflow-y-auto">
              {item.content}
            </div>
          )}

          {/* Проверка */}
          {tab === 'review' && (
            <div className="p-6 space-y-6">
              {reviewLoading && <p className="text-blue-400 animate-pulse">🤖 DeepSeek анализирует ТЗ по трём осям...</p>}
              {!reviewLoading && !review && (
                <p className="text-gray-500 text-center py-8">Нажмите «Проверить» для анализа</p>
              )}
              {review && (
                <>
                  <div className="text-sm text-gray-400 mb-2">Всего замечаний: <span className="text-white font-bold">{review.total}</span></div>
                  {[{key:'technical', label:'🔧 Технические', color:'blue'},
                    {key:'normative', label:'📋 Нормативные', color:'yellow'},
                    {key:'completeness', label:'📐 Полнота и стиль', color:'orange'}].map(axis => {
                    const issues = (review as any)[axis.key] as string[];
                    if (!issues?.length) return null;
                    return (
                      <div key={axis.key}>
                        <p className="text-sm font-semibold text-gray-300 mb-2">{axis.label} ({issues.length})</p>
                        <ul className="space-y-1.5">
                          {issues.map((iss, i) => (
                            <li key={i} className="text-sm text-gray-300 bg-gray-700/50 rounded-lg p-3 leading-relaxed">• {iss}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* Вопросы */}
          {tab === 'questions' && (
            <div className="p-6 space-y-4">
              {questionsLoading && <p className="text-purple-400 animate-pulse">💭 Формулирую вопросы...</p>}
              {!questionsLoading && questions.length === 0 && (
                <p className="text-gray-500 text-center py-8">Нажмите «Вопросы» для генерации</p>
              )}
              {questions.map((q, i) => (
                <div key={i} className="bg-gray-700/50 rounded-xl p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-blue-400 font-bold text-sm shrink-0">{i + 1}.</span>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{q.question}</p>
                      {q.section && <p className="text-xs text-gray-500 mt-0.5">{q.section}</p>}
                      {q.why && <p className="text-xs text-gray-500 italic mt-0.5">{q.why}</p>}
                    </div>
                  </div>
                  <textarea
                    value={answers[i] || ''}
                    onChange={e => setAnswers(prev => ({ ...prev, [i]: e.target.value }))}
                    rows={2}
                    placeholder="Ваш ответ..."
                    className="w-full p-2 bg-gray-800 border border-gray-600 rounded-lg text-sm focus:ring-1 focus:ring-blue-500 outline-none resize-none"
                  />
                </div>
              ))}
              {questions.length > 0 && (
                <button onClick={runRefine} disabled={refineLoading}
                  className="w-full py-3 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl font-semibold transition">
                  {refineLoading ? '⏳ Дорабатываю...' : '✍️ Доработать с учётом ответов'}
                </button>
              )}
            </div>
          )}

          {/* Доработка */}
          {tab === 'refine' && (
            <div className="p-6 space-y-4">
              {refineStatus && <p className="text-blue-400 text-sm animate-pulse">{refineStatus}</p>}
              {refineIssues.length > 0 && (
                <div className="bg-orange-900/20 border border-orange-800 rounded-xl p-4">
                  <p className="text-xs font-semibold text-orange-300 mb-2">🤖 Замечания DeepSeek ({refineIssues.length}):</p>
                  <ul className="space-y-1">
                    {refineIssues.map((iss, i) => <li key={i} className="text-xs text-orange-200/80">• {iss}</li>)}
                  </ul>
                </div>
              )}
              {!refineText && !refineLoading && (
                <p className="text-gray-500 text-center py-8">Нажмите «Доработать» для улучшения ТЗ</p>
              )}
              <div ref={refineRef}
                className="whitespace-pre-wrap text-sm text-gray-300 leading-relaxed font-mono max-h-[60vh] overflow-y-auto">
                {refineText}
                {refineLoading && !refineDone && <span className="animate-pulse text-blue-400">█</span>}
              </div>
              {refineDone && (
                <div className="text-center text-green-400 text-sm font-medium">✅ Доработка завершена и сохранена</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
