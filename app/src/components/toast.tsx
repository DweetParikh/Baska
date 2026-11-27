"use client";

import { createContext, useCallback, useContext, useState } from "react";

type Tone = "info" | "success" | "error";
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  href?: string;
  hrefLabel?: string;
}
interface Ctx {
  push: (t: Omit<Toast, "id">, ttlMs?: number) => number;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<Ctx>({ push: () => 0, dismiss: () => {} });
export const useToast = () => useContext(ToastCtx);

const TONES: Record<Tone, string> = {
  info: "border-brand/30 bg-panel text-ink",
  success: "border-up/40 bg-panel text-ink",
  error: "border-down/40 bg-panel text-ink",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">, ttlMs = 9000) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      if (ttlMs > 0) setTimeout(() => dismiss(id), ttlMs);
      return id;
    },
    [dismiss]
  );
  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto rounded-xl border p-3 text-sm shadow-lg ${TONES[t.tone]}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="font-semibold">{t.title}</div>
              <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="-mt-1 text-lg leading-none opacity-60 hover:opacity-100">
                ×
              </button>
            </div>
            {t.body && <div className="mt-1 break-words opacity-90">{t.body}</div>}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer" className="mt-1 inline-block font-medium underline">
                {t.hrefLabel ?? "View on Explorer"}
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
