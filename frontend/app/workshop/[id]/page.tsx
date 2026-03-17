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
interface HistoryEntry { id: string; action: string; description: string; changed_lines: number; created_at: string; }

const TAB_META = [
  { id: 'content',   label: '📄 Текст ТЗ' },
  { id: 'review',    label: '🔍 Проверка' },
  { id: 'questions', label: '❓ Вопросы' },
  { id: 'prompt',    label: '💬 Промпт' },
  { id: 'refine',    label: '✍️ Доработка' },
  { id: 'history',   label: '📜 История' },
];

const ACTION_ICON: Record<string, string> = {
  create: '💾', accept: '✅', prompt: '💬', answer: '❓', refine: '✍️', review: '🔍',
};

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ─ DiffViewer
function DiffViewer({ diff, changedLines }: { diff: DiffLine[]; changedLines: number }) {
  const [showAll, setShowAll] = useState(false);
  const filtered = showAll ? diff : diff.filter((d, i) => {
    if (d.type !== 'equal') return true;
    return diff.slice(Math.max(0, i - 3), i + 4).some(x => x.type !== 'equal');
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>Строк изменено: <span className="text-white font-bold">{changedLines}</span></span>
        <button onClick={() => setShowAll(!showAll)} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition">
          {showAll ? 'Скрыть равные' : 'Показать всё'}
        </button>
      </div>
      <div className="font-mono text-xs rounded-xl border border-gray-700 max-h-[55vh] overflow-y-auto">
        {filtered.map((d, i) => (
          <div key={i} className={`px-4 py-0.5 flex gap-3 ${
            d.type === 'add' ? 'bg-green-950 text-green-300'
            : d.type === 'remove' ? 'bg-red-950 text-red-300 line-through opacity-70'
            : 'bg-gray-900 text-gray-500'
          }`}>
            <span className="w-4 shrink-0 select-none">{d.type === 'add' ? '+' : d.type === 'remove' ? '−' : ' '}</span>
            <span className="whitespace-pre-wrap break-all">{d.line || '\u00a0'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─ PatchPanel
function PatchPanel({ diff, changedLines, newContent, onAccept, onReject, accepting }: {
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

// ─ QuestionCard
function QuestionCard({ q, patch, accepting, onAnswer, onAccept, onReject }: {
  q: Question; patch: any; accepting: boolean;
  onAnswer: (a: string) => void; onAccept: () => void; onReject: () => void;
}) {
  const [ans, setAns] = useState(q.answer || '');
  const isStreaming = patch?.status === 'streaming';
  const isReady    = patch?.status === 'ready';
  const isAccepted = patch?.status === 'accepted';
  const isRejected = patch?.status === 'rejected';

  return (
    <div className={`rounded-xl border p-4 space-y-3 transition ${
      isAccepted ? 'border-green-700 bg-green-900/10'
      : isRejected ? 'border-gray-700 opacity-60'
      : q.answered ? 'border-blue-700 bg-blue-900/10'
      : 'border-gray-700 bg-gray-700/30'
    }`}>
      <div className="flex items-start gap-2">
        <span className="text-lg shrink-0">{isAccepted?'✅':isRejected?'❌':q.answered?'🟡':'❓'}</span>
        <div className="flex-1">
          <p className="text-sm font-medium">{q.question}</p>
          {q.section && <p className="text-xs text-gray-500 mt-0.5">{q.section}</p>}
          {q.why && <p className="text-xs text-gray-500 italic">{q.why}</p>}
        </div>
        {isAccepted && <span className="text-xs text-green-400">Принято</span>}
        {isRejected && <span className="text-xs text-gray-500">Отклонено</span>}
      </div>
      {!isAccepted && !isRejected && (
        <div className="flex gap-2">
          <textarea value={ans} onChange={e => setAns(e.target.value)} disabled={isStreaming} rows={2}
            placeholder="Ваш ответ..."
            className="flex-1 p-2 bg-gray-800 border border-gray-600 rounded-lg text-sm focus:ring-1 focus:ring-blue-500 outline-none resize-none disabled:opacity-50" />
          <button onClick={() => onAnswer(ans)} disabled={!ans.trim() || isStreaming || isReady}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded-lg text-sm font-medium transition self-end">
            {isStreaming ? '⏳' : '→ Правка'}
          </button>
        </div>
      )}
      {isStreaming && patch?.statusMsg && <p className="text-xs text-blue-400 animate-pulse">{patch.statusMsg}</p>}
      {isReady && (
        <PatchPanel diff={patch.diff} changedLines={patch.changedLines} newContent={patch.newContent}
          onAccept={onAccept} onReject={onReject} accepting={accepting} />
      )}
      {isAccepted && q.answer && (
        <p className="text-xs text-gray-400 bg-gray-800 rounded-lg px-3 py-2">Ответ: {q.answer}</p>
      )}
    </div>
  );
}

export default function WorkshopItemPage() {
  const { id } = useParams<{ id: string }>();

  const [item, setItem]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('content');

  // review
  const [review, setReview]               = useState<ReviewData | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  // questions
  const [questions, setQuestions]             = useState<Question[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [newQCount, setNewQCount]             = useState(0);
  const [qPatch, setQPatch]                   = useState<Record<string, any>>({});
  const [accepting, setAccepting]             = useState<string | null>(null);

  // prompt refine
  const [promptText, setPromptText]         = useState('');
  const [promptLoading, setPromptLoading]   = useState(false);
  const [promptStatus, setPromptStatus]     = useState('');
  const [promptStream, setPromptStream]     = useState('');
  const [promptPatch, setPromptPatch]       = useState<any>(null);
  const [promptAccepting, setPromptAccepting] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);

  // refine batch
  const [refineLoading, setRefineLoading]   = useState(false);
  const [refineStatus, setRefineStatus]     = useState('');
  const [refineIssues, setRefineIssues]     = useState<string[]>([]);
  const [refinePatch, setRefinePatch]       = useState<any>(null);
  const [refineAccepting, setRefineAccepting] = useState(false);
  const [refineStream, setRefineStream]     = useState('');
  const refineRef = useRef<HTMLDivElement>(null);

  // history
  const [history, setHistory]               = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedEntry, setSelectedEntry]   = useState<any>(null);
  const [entryLoading, setEntryLoading]     = useState(false);

  const [copied, setCopied] = useState(false);

  const loadItem = () => {
    fetch(`${API}/${id}`).then(r => r.json()).then(data => {
      setItem(data); setQuestions(data.questions || []); setLoading(false);
    }).catch(() => setLoading(false));
  };

  const loadHistory = () => {
    setHistoryLoading(true);
    fetch(`${API}/${id}/history`).then(r => r.json()).then(data => {
      setHistory(data); setHistoryLoading(false);
    }).catch(() => setHistoryLoading(false));
  };

  useEffect(() => { loadItem(); }, [id]);

  // --- Review
  const runReview = async () => {
    setReviewLoading(true); setTab('review');
    setReview(await (await fetch(`${API}/${id}/review`, { method: 'POST' })).json());
    setReviewLoading(false);
  };

  // --- Questions
  const runQuestions = async () => {
    setQuestionsLoading(true); setTab('questions');
    const data = await (await fetch(`${API}/${id}/questions`, { method: 'POST' })).json();
    setQuestions(data.questions || []); setNewQCount(data.new_count || 0);
    setQuestionsLoading(false);
  };

  const answerQuestion = async (q: Question, answer: string) => {
    const qid = q.id;
    setQPatch(p => ({ ...p, [qid]: { status: 'streaming', issues: [], statusMsg: '', diff: [], newContent: '', changedLines: 0 } }));
    setTab('questions');
    const res = await fetch(`${API}/${id}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q.question, answer, section: q.section }),
    });
    if (!res.body) return;
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split('\n').slice(0, -1)) {
        buf = buf.slice(line.length + 1);
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status')      setQPatch(p => ({ ...p, [qid]: { ...p[qid], statusMsg: msg.message } }));
          else if (msg.type === 'issues') setQPatch(p => ({ ...p, [qid]: { ...p[qid], issues: msg.issues } }));
          else if (msg.type === 'patch_ready')
            setQPatch(p => ({ ...p, [qid]: { ...p[qid], status: 'ready', diff: msg.diff, newContent: msg.new_content, changedLines: msg.changed_lines, description: msg.description } }));
        } catch {}
      }
    }
    setQuestions(prev => prev.map(x => x.id === qid ? { ...x, answered: true, answer } : x));
  };

  const acceptQPatch = async (qid: string) => {
    const patch = qPatch[qid]; if (!patch?.newContent) return;
    setAccepting(qid);
    await fetch(`${API}/${id}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: patch.newContent, status: 'refined', action: 'answer',
        description: patch.description || 'Ответ на вопрос',
        diff: patch.diff, changed_lines: patch.changedLines }),
    });
    setItem((p: any) => ({ ...p, content: patch.newContent, updated_at: new Date().toISOString() }));
    setQPatch(p => ({ ...p, [qid]: { ...p[qid], status: 'accepted' } }));
    setAccepting(null); loadHistory();
  };

  const rejectQPatch = (qid: string) => {
    setQPatch(p => ({ ...p, [qid]: { ...p[qid], status: 'rejected' } }));
    setQuestions(prev => prev.map(x => x.id === qid ? { ...x, answered: false, answer: '' } : x));
  };

  // --- Prompt refine
  const runPromptRefine = async () => {
    if (!promptText.trim()) return;
    setPromptLoading(true); setPromptPatch(null); setPromptStream(''); setPromptStatus('');
    setTab('prompt');
    const res = await fetch(`${API}/${id}/prompt-refine`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText }),
    });
    if (!res.body) { setPromptLoading(false); return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status') setPromptStatus(msg.message);
          else if (msg.type === 'token') {
            setPromptStream(t => t + msg.text);
            setTimeout(() => promptRef.current?.scrollTo(0, promptRef.current.scrollHeight), 0);
          }
          else if (msg.type === 'patch_ready') {
            setPromptPatch({ diff: msg.diff, changedLines: msg.changed_lines, newContent: msg.new_content, description: msg.description });
            setPromptStatus('');
          }
        } catch {}
      }
    }
    setPromptLoading(false);
  };

  const acceptPromptPatch = async () => {
    if (!promptPatch) return;
    setPromptAccepting(true);
    await fetch(`${API}/${id}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: promptPatch.newContent, status: 'refined', action: 'prompt',
        description: promptPatch.description || `Промпт: ${promptText}`,
        diff: promptPatch.diff, changed_lines: promptPatch.changedLines }),
    });
    setItem((p: any) => ({ ...p, content: promptPatch.newContent, updated_at: new Date().toISOString() }));
    setPromptPatch(null); setPromptStream(''); setPromptText('');
    setPromptAccepting(false); loadHistory();
  };

  const rejectPromptPatch = () => { setPromptPatch(null); setPromptStream(''); };

  // --- Refine batch
  const runRefine = async () => {
    setRefineLoading(true); setRefinePatch(null); setRefineIssues([]); setRefineStatus(''); setRefineStream('');
    setTab('refine');
    const answersMap: Record<string, string> = {};
    questions.filter(q => q.answered).forEach(q => { answersMap[q.question] = q.answer; });
    const res = await fetch(`${API}/${id}/refine`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answersMap }),
    });
    if (!res.body) { setRefineLoading(false); return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'status')      setRefineStatus(msg.message);
          else if (msg.type === 'issues') setRefineIssues(msg.issues);
          else if (msg.type === 'token') {
            setRefineStream(t => t + msg.text);
            setTimeout(() => refineRef.current?.scrollTo(0, refineRef.current.scrollHeight), 0);
          }
          else if (msg.type === 'patch_ready') {
            setRefinePatch({ diff: msg.diff, changedLines: msg.changed_lines, newContent: msg.new_content, description: msg.description });
            setRefineStatus('');
          }
        } catch {}
      }
    }
    setRefineLoading(false);
  };

  const acceptRefinePatch = async () => {
    if (!refinePatch) return;
    setRefineAccepting(true);
    await fetch(`${API}/${id}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: refinePatch.newContent, status: 'refined', action: 'refine',
        description: refinePatch.description || 'Полная доработка',
        diff: refinePatch.diff, changed_lines: refinePatch.changedLines }),
    });
    setItem((p: any) => ({ ...p, content: refinePatch.newContent, updated_at: new Date().toISOString() }));
    setRefinePatch(null); setRefineAccepting(false); loadHistory();
  };

  // --- History entry
  const openHistoryEntry = async (entryId: string) => {
    setEntryLoading(true); setSelectedEntry(null);
    const data = await (await fetch(`${API}/${id}/history/${entryId}`)).json();
    setSelectedEntry(data); setEntryLoading(false);
  };

  if (loading) return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-gray-400">Загрузка...</div>;
  if (!item)   return <div className="min-h-screen bg-gray-900 flex items-center justify-center text-red-400">ТЗ не найдено</div>;

  const answeredCount = questions.filter(q => q.answered).length;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-start gap-4 flex-wrap">
          <Link href="/workshop" className="text-gray-400 hover:text-white transition pt-1">←</Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold truncate">{item.title}</h1>
            <p className="text-sm text-gray-400 mt-1 flex items-center gap-3 flex-wrap">
              {item.object_type && <span>🔧 {item.object_type}</span>}
              {item.industry    && <span>🏭 {item.industry}</span>}
              <span className="text-gray-500">Создано: {fmt(item.created_at)}</span>
              {item.updated_at !== item.created_at && (
                <span className="text-blue-400">Изменено: {fmt(item.updated_at)}</span>
              )}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={runReview} disabled={reviewLoading}
              className="px-3 py-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 rounded-xl text-sm transition">
              {reviewLoading ? '⏳' : '🔍 Проверка'}
            </button>
            <button onClick={runQuestions} disabled={questionsLoading}
              className="px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 rounded-xl text-sm transition">
              {questionsLoading ? '⏳' : `❓ Вопросы${questions.length > 0 ? ` (${questions.length})` : ''}`}
            </button>
            <button onClick={runRefine} disabled={refineLoading}
              className="px-3 py-2 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 rounded-xl text-sm transition">
              {refineLoading ? '⏳' : '✍️ Доработка'}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="flex border-b border-gray-700 overflow-x-auto">
            {TAB_META.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'history') loadHistory(); }}
                className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${
                  tab === t.id ? 'border-blue-500 text-white bg-gray-700/50' : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}>
                {t.label}
                {t.id === 'questions' && questions.length > 0 && (
                  <span className="ml-1.5 text-xs bg-purple-900/60 text-purple-300 border border-purple-700 px-1.5 rounded-full">
                    {answeredCount}/{questions.length}
                  </span>
                )}
              </button>
            ))}
            <div className="ml-auto flex items-center pr-3">
              <button onClick={() => { navigator.clipboard.writeText(item.content); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg transition">
                {copied ? '✅' : '📋 Копир.'}
              </button>
            </div>
          </div>

          {/* ─ Текст */}
          {tab === 'content' && (
            <div className="p-6 whitespace-pre-wrap text-sm text-gray-300 font-mono max-h-[70vh] overflow-y-auto">{item.content}</div>
          )}

          {/* ─ Проверка */}
          {tab === 'review' && (
            <div className="p-6 space-y-6">
              {reviewLoading && <p className="text-blue-400 animate-pulse">🤖 Анализ по 3 осям...</p>}
              {!reviewLoading && !review && <p className="text-gray-500 text-center py-8">Нажмите «Проверка»</p>}
              {review && (
                <>
                  <p className="text-sm text-gray-400">Замечаний: <span className="text-white font-bold">{review.total}</span></p>
                  {[{key:'technical',l:'🔧 Технические'},{key:'normative',l:'📋 Нормативные'},{key:'completeness',l:'📐 Полнота'}].map(ax => {
                    const iss = (review as any)[ax.key] as string[];
                    if (!iss?.length) return null;
                    return (
                      <div key={ax.key}>
                        <p className="text-sm font-semibold text-gray-300 mb-2">{ax.l} ({iss.length})</p>
                        <ul className="space-y-1.5">{iss.map((s,i) => <li key={i} className="text-sm text-gray-300 bg-gray-700/50 rounded-lg p-3">• {s}</li>)}</ul>
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
              {questionsLoading && <p className="text-purple-400 animate-pulse">💭 Генерирую вопросы...</p>}
              {newQCount > 0 && <div className="text-xs text-green-400 bg-green-900/20 border border-green-800 rounded-lg px-3 py-2">+ Добавлено {newQCount} новых</div>}
              {!questionsLoading && questions.length === 0 && <p className="text-gray-500 text-center py-8">Нажмите «Вопросы»</p>}
              {questions.map(q => (
                <QuestionCard key={q.id} q={q} patch={qPatch[q.id]} accepting={accepting === q.id}
                  onAnswer={a => answerQuestion(q, a)}
                  onAccept={() => acceptQPatch(q.id)}
                  onReject={() => rejectQPatch(q.id)} />
              ))}
            </div>
          )}

          {/* ─ Промпт */}
          {tab === 'prompt' && (
            <div className="p-6 space-y-4">
              <div className="flex gap-3">
                <textarea
                  value={promptText}
                  onChange={e => setPromptText(e.target.value)}
                  disabled={promptLoading}
                  rows={3}
                  placeholder="Например: Улучши раздел 4, добавь больше технических деталей..."
                  className="flex-1 p-3 bg-gray-700 border border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none disabled:opacity-50"
                />
                <button onClick={runPromptRefine} disabled={!promptText.trim() || promptLoading}
                  className="px-5 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded-xl text-sm font-semibold transition self-end">
                  {promptLoading ? '⏳ Работа...' : '▶ Выполнить'}
                </button>
              </div>
              {promptStatus && <p className="text-orange-300 text-sm animate-pulse">{promptStatus}</p>}
              {!promptPatch && (
                <div ref={promptRef} className="whitespace-pre-wrap text-sm text-gray-300 font-mono max-h-[50vh] overflow-y-auto">
                  {promptStream}
                  {promptLoading && <span className="animate-pulse text-orange-400">█</span>}
                </div>
              )}
              {promptPatch && (
                <PatchPanel diff={promptPatch.diff} changedLines={promptPatch.changedLines}
                  newContent={promptPatch.newContent}
                  onAccept={acceptPromptPatch} onReject={rejectPromptPatch}
                  accepting={promptAccepting} />
              )}
            </div>
          )}

          {/* ─ Доработка (batch) */}
          {tab === 'refine' && (
            <div className="p-6 space-y-4">
              {refineStatus && <p className="text-blue-400 text-sm animate-pulse">{refineStatus}</p>}
              {refineIssues.length > 0 && (
                <div className="bg-orange-900/20 border border-orange-800 rounded-xl p-4">
                  <p className="text-xs font-semibold text-orange-300 mb-2">🤖 Замечания DeepSeek ({refineIssues.length}):</p>
                  <ul className="space-y-1">{refineIssues.map((s,i) => <li key={i} className="text-xs text-orange-200/80">• {s}</li>)}</ul>
                </div>
              )}
              {!refinePatch && (
                <div ref={refineRef} className="whitespace-pre-wrap text-sm text-gray-300 font-mono max-h-[50vh] overflow-y-auto">
                  {refineStream}
                  {refineLoading && <span className="animate-pulse text-blue-400">█</span>}
                  {!refineLoading && !refineStream && <p className="text-gray-500 text-center py-8">Нажмите «Доработать»</p>}
                </div>
              )}
              {refinePatch && (
                <PatchPanel diff={refinePatch.diff} changedLines={refinePatch.changedLines}
                  newContent={refinePatch.newContent}
                  onAccept={acceptRefinePatch} onReject={() => { setRefinePatch(null); setRefineStream(''); }}
                  accepting={refineAccepting} />
              )}
            </div>
          )}

          {/* ─ История */}
          {tab === 'history' && (
            <div className="p-6 space-y-4">
              {historyLoading && <p className="text-gray-500 animate-pulse">Загрузка...</p>}
              {!historyLoading && history.length === 0 && <p className="text-gray-500 text-center py-8">История пуста</p>}

              <div className="grid grid-cols-1 gap-3">
                {history.map(entry => (
                  <div key={entry.id}
                    onClick={() => openHistoryEntry(entry.id)}
                    className={`flex items-center gap-4 bg-gray-700/40 hover:bg-gray-700 rounded-xl p-4 cursor-pointer transition border ${
                      selectedEntry?.id === entry.id ? 'border-blue-600' : 'border-transparent'
                    }`}>
                    <span className="text-2xl">{ACTION_ICON[entry.action] || '📌'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{entry.description}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{fmt(entry.created_at)}</p>
                    </div>
                    {entry.changed_lines > 0 && (
                      <span className="text-xs text-orange-300 bg-orange-900/30 border border-orange-800 px-2 py-1 rounded-full whitespace-nowrap">
                        {entry.changed_lines} стр.
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Diff выбранной записи */}
              {selectedEntry && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{selectedEntry.description}</p>
                    <button onClick={() => setSelectedEntry(null)} className="text-xs text-gray-500 hover:text-white">× Закрыть</button>
                  </div>
                  {entryLoading ? (
                    <p className="text-gray-500 animate-pulse">Загрузка diff...</p>
                  ) : (
                    <DiffViewer diff={selectedEntry.diff} changedLines={selectedEntry.changed_lines} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
