'use client';
import { useState, useRef } from 'react';

const API = 'http://localhost:8000/api/workshop';

interface DiffLine { type: 'equal' | 'add' | 'remove'; line: string; }

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
        <button onClick={() => setShowAll(!showAll)}
          className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition text-xs">
          {showAll ? 'Скрыть равные' : 'Показать всё'}
        </button>
      </div>
      <div className="font-mono text-xs rounded-xl border border-gray-700 max-h-[55vh] overflow-y-auto">
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

interface ReviewCounts { technical: number; normative: number; completeness: number; }
interface ReviewResult { issues: string[]; counts: ReviewCounts; }

export default function PromptTab({
  itemId,
  onAccept,
}: {
  itemId: string;
  onAccept: (newContent: string, description: string, diff: DiffLine[], changedLines: number) => void;
}) {
  const [promptText, setPromptText] = useState('');
  const [withReview, setWithReview] = useState(false);

  const [loading, setLoading]         = useState(false);
  const [status, setStatus]           = useState('');
  const [stream, setStream]           = useState('');
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null);
  const [patch, setPatch]             = useState<{ diff: DiffLine[]; changedLines: number; newContent: string; description: string } | null>(null);
  const [accepting, setAccepting]     = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const run = async () => {
    if (!promptText.trim()) return;
    setLoading(true); setPatch(null); setStream(''); setStatus(''); setReviewResult(null);

    const res = await fetch(`${API}/${itemId}/prompt-refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, with_review: withReview }),
    });
    if (!res.body) { setLoading(false); return; }

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
          if (msg.type === 'status') {
            setStatus(msg.message);
          } else if (msg.type === 'token') {
            setStream(t => t + msg.text);
            setTimeout(() => streamRef.current?.scrollTo(0, streamRef.current.scrollHeight), 0);
          } else if (msg.type === 'review_issues') {
            setReviewResult({ issues: msg.issues, counts: msg.counts });
          } else if (msg.type === 'patch_ready') {
            setPatch({
              diff: msg.diff,
              changedLines: msg.changed_lines,
              newContent: msg.new_content,
              description: msg.description,
            });
            setStatus('');
          }
        } catch {}
      }
    }
    setLoading(false);
  };

  const accept = async () => {
    if (!patch) return;
    setAccepting(true);
    await onAccept(patch.newContent, patch.description, patch.diff, patch.changedLines);
    setPatch(null); setStream(''); setPromptText(''); setReviewResult(null);
    setAccepting(false);
  };

  const reject = () => { setPatch(null); setStream(''); setReviewResult(null); };

  return (
    <div className="p-6 space-y-4">
      {/* Ввод промпта */}
      <div className="space-y-3">
        <div className="flex gap-3">
          <textarea
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            disabled={loading}
            rows={3}
            placeholder="Например: Улучши раздел 4, добавь больше технических деталей..."
            className="flex-1 p-3 bg-gray-700 border border-gray-600 rounded-xl text-sm
                       focus:ring-2 focus:ring-orange-500 outline-none resize-none disabled:opacity-50"
          />
          <button
            onClick={run}
            disabled={!promptText.trim() || loading}
            className="px-5 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600
                       rounded-xl text-sm font-semibold transition self-end">
            {loading ? '⏳ Работа...' : '▶ Выполнить'}
          </button>
        </div>

        {/* Чекбокс вторичной проверки */}
        <label className={`inline-flex items-center gap-2.5 cursor-pointer select-none
                          px-4 py-2 rounded-xl border transition
                          ${ withReview
                              ? 'border-indigo-600 bg-indigo-900/30 text-indigo-300'
                              : 'border-gray-600 bg-gray-700/40 text-gray-400 hover:border-gray-500' }`}>
          <input
            type="checkbox"
            checked={withReview}
            onChange={e => setWithReview(e.target.checked)}
            disabled={loading}
            className="w-4 h-4 accent-indigo-500"
          />
          <span className="text-sm font-medium">🤖 Вторичная проверка DeepSeek</span>
          <span className="text-xs opacity-60">по 3 осям после GPT-4o</span>
        </label>
      </div>

      {/* Статус */}
      {status && <p className="text-orange-300 text-sm animate-pulse">{status}</p>}

      {/* Стриминг (GPT-4o пишет) */}
      {!patch && (
        <div ref={streamRef}
          className="whitespace-pre-wrap text-sm text-gray-300 font-mono max-h-[50vh] overflow-y-auto">
          {stream}
          {loading && <span className="animate-pulse text-orange-400">█</span>}
        </div>
      )}

      {/* Замечания DeepSeek (если with_review) */}
      {reviewResult && (
        <div className="rounded-xl border border-indigo-800 bg-indigo-900/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-indigo-300">
              🤖 Замечания DeepSeek
              {reviewResult.issues.length === 0 && (
                <span className="ml-2 text-green-400">— замечаний нет ✅</span>
              )}
            </p>
            {reviewResult.issues.length > 0 && (
              <div className="flex gap-3 text-xs">
                {reviewResult.counts.technical > 0 && (
                  <span className="text-blue-400">🔧 тех. {reviewResult.counts.technical}</span>
                )}
                {reviewResult.counts.normative > 0 && (
                  <span className="text-yellow-400">📋 норм. {reviewResult.counts.normative}</span>
                )}
                {reviewResult.counts.completeness > 0 && (
                  <span className="text-orange-400">📐 полн. {reviewResult.counts.completeness}</span>
                )}
              </div>
            )}
          </div>
          {reviewResult.issues.length > 0 && (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {reviewResult.issues.map((iss, i) => (
                <li key={i} className="text-xs text-indigo-200/80">• {iss}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Diff + принять/отклонить */}
      {patch && (
        <div className="space-y-4">
          <DiffViewer diff={patch.diff} changedLines={patch.changedLines} />
          <div className="flex gap-3">
            <button onClick={accept} disabled={accepting}
              className="flex-1 py-2.5 bg-green-700 hover:bg-green-600 disabled:bg-gray-700
                         rounded-xl font-semibold text-sm transition">
              {accepting ? '⏳ Сохранение...' : '✅ Принять правку'}
            </button>
            <button onClick={reject}
              className="flex-1 py-2.5 bg-red-900/60 hover:bg-red-900 rounded-xl
                         font-semibold text-sm transition text-red-300">
              ❌ Отклонить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
