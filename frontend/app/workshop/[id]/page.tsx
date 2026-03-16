'use client';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const API = 'http://localhost:8000/api/workshop';

interface DiffLine { type: 'equal' | 'add' | 'remove'; line: string; }
interface Question {
  id: string; question: string; section: string; why: string;
  answered: boolean; answer: string;
}
interface ReviewData { technical: string[]; normative: string[]; completeness: string[]; total: number; }

const TAB_META = [
  { id: 'content',   label: '📄 Текст ТЗ' },
  { id: 'review',    label: '🔍 Проверка' },
  { id: 'questions', label: '❓ Вопросы' },
  { id: 'refine',    label: '✍️ Доработка' },
];

// Построчный diff-вьюер
function DiffViewer({ diff, changedLines }: { diff: DiffLine[]; changedLines: number }) {
  const [showEqual, setShowEqual] = useState(false);
  const filtered = showEqual ? diff : diff.filter((d, i) => {
    if (d.type !== 'equal') return true;
    // показываем несколько строк контекста вокруг изменений
    const hasNearby = diff.slice(Math.max(0,i-3), i+4).some(x => x.type !== 'equal');
    return hasNearby;
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>Изменено строк: <span className="text-white font-bold">{changedLines}</span></span>
        <button onClick={() => setShowEqual(!showEqual)}
          className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition">
          {showEqual ? 'Скрыть неизменённые' : 'Показать всё'}
        </button>
      </div>
      <div className="font-mono text-xs rounded-xl overflow-hidden border border-gray-700 max-h-[55vh] overflow-y-auto">
        {filtered.map((d, i) => (
          <div key={i} className={`px-4 py-0.5 flex gap-3 ${
            d.type === 'add'    ? 'bg-green-950 text-green-300'
            : d.type === 'remove' ? 'bg-red-950 text-red-300 line-through opacity-70'
            : 'bg-gray-900 text-gray-500'
          }`}>
            <span className="w-4 shrink-0 select-none">
              {d.type === 'add' ? '+' : d.type === 'remove' ? '−' : ' '}
            </span>
            <span className="whitespace-pre-wrap break-all">{d.line || '\u00a0'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Панель принять/отклонить
function PatchPanel({
  diff, changedLines, newContent, onAccept, onReject, accepting
}: {
  diff: DiffLine[]; changedLines: number; newContent: string;
  onAccept: () => void; onReject: () => void; accepting: boolean;
}) {
  return (
    <div className="space-y-4">
      <DiffViewer diff={diff} changedLines={changedLines} />
      <div className="flex gap-3">
        <button onClick={onAccept} disabled={accepting}
          className="flex-1 py-2.5 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl font-semibold text-sm transition">
          {accepting ? '⏳ Сохранение...' : '✅ Принять правку'}
        </button>
        <button onClick={onReject}
          className="flex-1 py-2.5 bg-red-900/60 hover:bg-red-900 rounded-xl font-semibold text-sm transition text-red-300">
          ❌ Отклонить
        </button>
      </div>
    </div>
  );
}

export default function WorkshopItemPage() {
  const { id } = useParams<{ id: string }>();

  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('content');

  // review
  const [review, setReview] = useState<ReviewData | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  // questions
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [newQCount, setNewQCount] = useState(0);

  // per-question patch state: qId -> {status, diff, newContent, changedLines, issues, streaming, statusMsg}
  const [qPatch, setQPatch] = useState<Record<string, any>>({});
  const [accepting, setAccepting] = useState<string | null>(null); // qId being accepted

  // refine (batch)
  const [refineLoading, setRefineLoading] = useState(false);
  const [refineStatus, setRefineStatus] = useState('');
  const [refineIssues, setRefineIssues] = useState<string[]>([]);
  const [refinePatch, setRefinePatch] = useState<{ diff: DiffLine[]; changedLines: number; newContent: string } | null>(null);
  const [refineAccepting, setRefineAccepting] = useState(false);
  const refineRef = useRef<HTMLDivElement>(null);
  const [refineStream, setRefineStream] = useState('');

  const [copied, setCopied] = useState(false);

  const loadItem = () => {
    fetch(`${API}/${id}`).then(r => r.json()).then(data => {
      setItem(data);
      setQuestions(data.questions || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { loadItem(); }, [id]);

  // ── Review
  const runReview = async () => {
    setReviewLoading(true); setTab('review');
    const res = await fetch(`${API}/${id}/review`, { method: 'POST' });
    setReview(await res.json());
    setReviewLoading(false);
  };

  // ── Questions
  const runQuestions = async () => {
    setQuestionsLoading(true); setTab('questions');
    const res = await fetch(`${API}/${id}/questions`, { method: 'POST' });
    const data = await res.json();
    setQuestions(data.questions || []);
    setNewQCount(data.new_count || 0);
    setQuestionsLoading(false);
  };

  // ── Answer single question → patch
  const answerQuestion = async (q: Question, answer: string) => {
    const qid = q.id;
    setQPatch(prev => ({ ...prev, [qid]: { status: 'streaming', issues: [], statusMsg: '', diff: [], newContent: '', changedLines: 0 } }));
    setTab('questions');

    const res = await fetch(`${API}/${id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q.question, answer, section: q.section }),
    });
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status')
            setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], statusMsg: msg.message } }));
          else if (msg.type === 'issues')
            setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], issues: msg.issues } }));
          else if (msg.type === 'patch_ready')
            setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], status: 'ready', diff: msg.diff, newContent: msg.new_content, changedLines: msg.changed_lines } }));
          else if (msg.type === 'done')
            setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], status: prev[qid]?.status === 'ready' ? 'ready' : 'done' } }));
        } catch {}
      }
    }
    // Отмечаем вопрос отвеченным локально
    setQuestions(prev => prev.map(x => x.id === qid ? { ...x, answered: true, answer } : x));
  };

  const acceptQPatch = async (qid: string) => {
    const patch = qPatch[qid];
    if (!patch?.newContent) return;
    setAccepting(qid);
    await fetch(`${API}/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: patch.newContent, status: 'refined' }),
    });
    setItem((prev: any) => ({ ...prev, content: patch.newContent }));
    setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], status: 'accepted' } }));
    setAccepting(null);
  };

  const rejectQPatch = (qid: string) => {
    setQPatch(prev => ({ ...prev, [qid]: { ...prev[qid], status: 'rejected' } }));
    // Возвращаем вопрос в состояние неотвеченного
    setQuestions(prev => prev.map(x => x.id === qid ? { ...x, answered: false, answer: '' } : x));
  };

  // ── Refine batch
  const runRefine = async () => {
    setRefineLoading(true);
    setRefinePatch(null);
    setRefineIssues([]);
    setRefineStatus('');
    setRefineStream('');
    setTab('refine');

    const answersMap: Record<string, string> = {};
    questions.filter(q => q.answered).forEach(q => { answersMap[q.question] = q.answer; });

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
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status') setRefineStatus(msg.message);
          else if (msg.type === 'issues') setRefineIssues(msg.issues);
          else if (msg.type === 'token') {
            setRefineStream(t => t + msg.text);
            setTimeout(() => refineRef.current?.scrollTo(0, refineRef.current.scrollHeight), 0);
          }
          else if (msg.type === 'patch_ready') {
            setRefinePatch({ diff: msg.diff, changedLines: msg.changed_lines, newContent: msg.new_content });
            setRefineStatus('');
          }
          else if (msg.type === 'done') setRefineStatus('');
        } catch {}
      }
    }
    setRefineLoading(false);
  };

  const acceptRefinePatch = async () => {
    if (!refinePatch) return;
    setRefineAccepting(true);
    await fetch(`${API}/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: refinePatch.newContent, status: 'refined' }),
    });
    setItem((prev: any) => ({ ...prev, content: refinePatch.newContent }));
    setRefinePatch(null);
    setRefineAccepting(false);
  };

  const rejectRefinePatch = () => { setRefinePatch(null); setRefineStream(''); };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text); setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-gray-400">Загрузка...</div>;
  if (!item) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-red-400">ТЗ не найдено</div>;

  const answeredCount = questions.filter(q => q.answered).length;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Шапка */}
        <div className="flex items-start gap-4 flex-wrap">
          <Link href="/workshop" className="text-gray-400 hover:text-white transition pt-1">← Назад</Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{item.title}</h1>
            <p className="text-sm text-gray-400 mt-1">
              {item.object_type && <span className="mr-3">🔧 {item.object_type}</span>}
              {item.industry && <span className="mr-3">🏭 {item.industry}</span>}
              <span className="text-gray-600">{new Date(item.created_at).toLocaleDateString('ru-RU')}</span>
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={runReview} disabled={reviewLoading}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {reviewLoading ? '⏳...' : '🔍 Проверка'}
            </button>
            <button onClick={runQuestions} disabled={questionsLoading}
              className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {questionsLoading ? '⏳...' : `❓ Вопросы${questions.length > 0 ? ` (${questions.length})` : ''}`}
            </button>
            <button onClick={runRefine} disabled={refineLoading}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl text-sm font-medium transition">
              {refineLoading ? '⏳...' : '✍️ Доработать'}
            </button>
          </div>
        </div>

        {/* Вкладки */}
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="flex border-b border-gray-700 overflow-x-auto">
            {TAB_META.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${
                  tab === t.id ? 'border-blue-500 text-white bg-gray-700/50' : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}>
                {t.label}
                {t.id === 'questions' && questions.length > 0 && (
                  <span className="ml-2 text-xs bg-purple-900/60 text-purple-300 border border-purple-700 px-1.5 rounded-full">
                    {answeredCount}/{questions.length}
                  </span>
                )}
              </button>
            ))}
            <div className="ml-auto flex items-center pr-4">
              <button onClick={() => copyText(item.content)}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                {copied ? '✅ Скопировано' : '📋 Копировать'}
              </button>
            </div>
          </div>

          {/* ─ Текст ТЗ */}
          {tab === 'content' && (
            <div className="p-6 whitespace-pre-wrap text-sm text-gray-300 leading-relaxed font-mono max-h-[70vh] overflow-y-auto">
              {item.content}
            </div>
          )}

          {/* ─ Проверка */}
          {tab === 'review' && (
            <div className="p-6 space-y-6">
              {reviewLoading && <p className="text-blue-400 animate-pulse">🤖 DeepSeek анализирует по трём осям...</p>}
              {!reviewLoading && !review && <p className="text-gray-500 text-center py-8">Нажмите «Проверка»</p>}
              {review && (
                <>
                  <div className="text-sm text-gray-400">Всего замечаний: <span className="text-white font-bold">{review.total}</span></div>
                  {[{key:'technical',label:'🔧 Технические'},
                    {key:'normative',label:'📋 Нормативные'},
                    {key:'completeness',label:'📐 Полнота и стиль'}].map(ax => {
                    const iss = (review as any)[ax.key] as string[];
                    if (!iss?.length) return null;
                    return (
                      <div key={ax.key}>
                        <p className="text-sm font-semibold text-gray-300 mb-2">{ax.label} ({iss.length})</p>
                        <ul className="space-y-1.5">
                          {iss.map((iss2, i) => <li key={i} className="text-sm text-gray-300 bg-gray-700/50 rounded-lg p-3">• {iss2}</li>)}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ─ Вопросы */}
          {tab === 'questions' && (
            <div className="p-6 space-y-4">
              {questionsLoading && <p className="text-purple-400 animate-pulse">💭 Формулирую вопросы...</p>}
              {newQCount > 0 && (
                <div className="text-xs text-green-400 bg-green-900/20 border border-green-800 rounded-lg px-3 py-2">
                  + Добавлено {newQCount} новых вопроса
                </div>
              )}
              {!questionsLoading && questions.length === 0 && (
                <p className="text-gray-500 text-center py-8">Нажмите «Вопросы»</p>
              )}
              {questions.map((q) => {
                const patch = qPatch[q.id];
                return (
                  <QuestionCard
                    key={q.id}
                    q={q}
                    patch={patch}
                    accepting={accepting === q.id}
                    onAnswer={(answer) => answerQuestion(q, answer)}
                    onAccept={() => acceptQPatch(q.id)}
                    onReject={() => rejectQPatch(q.id)}
                  />
                );
              })}
            </div>
          )}

          {/* ─ Доработка (batch) */}
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
              {!refinePatch && (
                <div ref={refineRef} className="whitespace-pre-wrap text-sm text-gray-300 font-mono max-h-[50vh] overflow-y-auto">
                  {refineStream}
                  {refineLoading && <span className="animate-pulse text-blue-400">█</span>}
                  {!refineLoading && !refineStream && (
                    <p className="text-gray-500 text-center py-8">Нажмите «Доработать»</p>
                  )}
                </div>
              )}
              {refinePatch && (
                <PatchPanel
                  diff={refinePatch.diff}
                  changedLines={refinePatch.changedLines}
                  newContent={refinePatch.newContent}
                  onAccept={acceptRefinePatch}
                  onReject={rejectRefinePatch}
                  accepting={refineAccepting}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─ Компонент вопроса
function QuestionCard({
  q, patch, accepting, onAnswer, onAccept, onReject
}: {
  q: Question;
  patch: any;
  accepting: boolean;
  onAnswer: (a: string) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [localAnswer, setLocalAnswer] = useState(q.answer || '');
  const isStreaming = patch?.status === 'streaming';
  const isReady = patch?.status === 'ready';
  const isAccepted = patch?.status === 'accepted';
  const isRejected = patch?.status === 'rejected';

  return (
    <div className={`rounded-xl border p-4 space-y-3 transition ${
      isAccepted ? 'border-green-700 bg-green-900/10'
      : isRejected ? 'border-gray-700 bg-gray-800/50 opacity-60'
      : q.answered ? 'border-blue-700 bg-blue-900/10'
      : 'border-gray-700 bg-gray-700/30'
    }`}>
      {/* Вопрос */}
      <div className="flex items-start gap-2">
        <span className={`text-lg shrink-0 mt-0.5`}>
          {isAccepted ? '✅' : isRejected ? '❌' : q.answered ? '🟡' : '❓'}
        </span>
        <div className="flex-1">
          <p className="text-sm font-medium">{q.question}</p>
          {q.section && <p className="text-xs text-gray-500 mt-0.5">{q.section}</p>}
          {q.why && <p className="text-xs text-gray-500 italic">{q.why}</p>}
        </div>
        {isAccepted && <span className="text-xs text-green-400 font-medium">Принято</span>}
        {isRejected && <span className="text-xs text-gray-500 font-medium">Отклонено</span>}
      </div>

      {/* Поле ответа — только если нет патча */}
      {!isAccepted && !isRejected && (
        <div className="flex gap-2">
          <textarea
            value={localAnswer}
            onChange={e => setLocalAnswer(e.target.value)}
            disabled={isStreaming}
            rows={2}
            placeholder="Ваш ответ..."
            className="flex-1 p-2 bg-gray-800 border border-gray-600 rounded-lg text-sm focus:ring-1 focus:ring-blue-500 outline-none resize-none disabled:opacity-50"
          />
          <button
            onClick={() => onAnswer(localAnswer)}
            disabled={!localAnswer.trim() || isStreaming || isReady}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded-lg text-sm font-medium transition self-end">
            {isStreaming ? '⏳' : '→ Предложить правку'}
          </button>
        </div>
      )}

      {/* Статус */}
      {isStreaming && patch?.statusMsg && (
        <p className="text-xs text-blue-400 animate-pulse">{patch.statusMsg}</p>
      )}

      {/* Diff + принять/отклонить */}
      {isReady && (
        <PatchPanel
          diff={patch.diff}
          changedLines={patch.changedLines}
          newContent={patch.newContent}
          onAccept={onAccept}
          onReject={onReject}
          accepting={accepting}
        />
      )}

      {/* Ответ после принятия */}
      {isAccepted && q.answer && (
        <p className="text-xs text-gray-400 bg-gray-800 rounded-lg px-3 py-2">Ответ: {q.answer}</p>
      )}
    </div>
  );
}
