"use client";

import { useCallback, useSyncExternalStore } from "react";

const KEY = "baska-watchlist";
const listeners = new Set<() => void>();
let cache: string | null = null;

const read = (): number[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};
const snapshot = () => {
  const raw = localStorage.getItem(KEY) ?? "[]";
  if (raw !== cache) cache = raw;
  return cache!;
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
};

/** Starred fund ids, persisted in localStorage and shared across components/tabs. */
export function useWatchlist() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "[]");
  const ids: number[] = JSON.parse(raw);
  const toggle = useCallback((id: number) => {
    const cur = read();
    localStorage.setItem(KEY, JSON.stringify(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    listeners.forEach((l) => l());
  }, []);
  return { ids, has: (id: number) => ids.includes(id), toggle };
}
