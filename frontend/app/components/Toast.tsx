'use client';
import { useEffect, useState } from 'react';

export type ToastType = 'info' | 'success' | 'error' | 'loading';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  persist?: boolean; // не исчезает автоматически (для loading)
}

interface Props {
  toasts: ToastItem[];
  onRemove: (id: string) => void;
}

const ICONS: Record<ToastType, string> = {
  info: 'ℹ️',
  success: '✅',
  error: '❌',
  loading: '⏳',
};

const COLORS: Record<ToastType, string> = {
  info: 'bg-gray-800 border-gray-600',
  success: 'bg-green-900/80 border-green-700',
  error: 'bg-red-900/80 border-red-700',
  loading: 'bg-blue-900/80 border-blue-700',
};

export function Toast({ toasts, onRemove }: Props) {
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 w-80">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onRemove }: { toast: ToastItem; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    if (!toast.persist) {
      const t = setTimeout(() => onRemove(toast.id), toast.type === 'error' ? 6000 : 4000);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border shadow-xl transition-all duration-300 ${
      COLORS[toast.type]
    } ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
      <span className="text-lg shrink-0">
        {toast.type === 'loading'
          ? <span className="inline-block animate-spin">⏳</span>
          : ICONS[toast.type]}
      </span>
      <p className="text-sm leading-snug flex-1">{toast.message}</p>
      <button onClick={() => onRemove(toast.id)} className="text-gray-500 hover:text-white text-xs mt-0.5">✕</button>
    </div>
  );
}

// Хук для управления тостами
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const add = (type: ToastType, message: string, persist = false): string => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, type, message, persist }]);
    return id;
  };

  const remove = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));

  const update = (id: string, type: ToastType, message: string) =>
    setToasts(prev => prev.map(t => t.id === id ? { ...t, type, message, persist: false } : t));

  return { toasts, add, remove, update };
}
