import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Json, Project } from '../shared/types';
export const TOKEN_KEY = 'mindtrust-session-token';
export const SESSION_EXPIRED_EVENT = 'mindtrust-session-expired';
let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!token && csrfToken && init?.method && !['GET', 'HEAD'].includes(init.method.toUpperCase()))
    headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  const data = await response
    .json()
    .catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    const fallback =
      response.status === 403
        ? 'Your workspace role or project access does not permit this action. Ask a workspace administrator for access.'
        : `Request failed (${response.status})`;
    throw new ApiError(data.error || fallback, response.status);
  }
  return data as T;
}
export const post = <T,>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export function useData<T>(path: string | null, refresh = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((x) => x + 1), []);
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    api<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) {
          setError(String(e.message));
          setData(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, refresh, revision]);
  return { data, error, loading, reload };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}
interface Workspace {
  projectId: string;
  project: Project | undefined;
  refresh: number;
  refreshAll: () => void;
  notify: (message: string) => void;
  navigate: (page: string) => void;
}
export const WorkspaceContext = createContext<Workspace>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);
export const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export const numeric = (v: number) =>
  new Intl.NumberFormat('en', {
    notation: v > 9999 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(v);
export const percent = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(1)}%`;
export const duration = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
export const money = (v: number | null | undefined) =>
  v == null
    ? 'Unknown'
    : `$${v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;
export const date = (v: string) =>
  new Date(v).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
export const shortDate = (v: string) =>
  new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const stringify = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
export const compact = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
export function parseJson(value: string, label = 'Input'): Json {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON. Wrap text values in double quotes.`);
  }
}
export async function download(path: string, name: string) {
  const value = await api<unknown>(path);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
