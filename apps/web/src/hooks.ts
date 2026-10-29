import { message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/** Load data with loading/error state and a reload function. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader());
    } catch (e) {
      notifyError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, loading, reload };
}

export function notifyError(e: unknown) {
  const text = e instanceof ApiError ? `${e.status}: ${e.message}` : String(e);
  message.error(text);
}

export const money = (n: number | string | null | undefined, lang: 'ar' | 'en') =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-AE' : 'en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));

export const date = (v: string | null | undefined, lang: 'ar' | 'en') =>
  v ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE' : 'en-GB', { dateStyle: 'medium', timeZone: 'Asia/Dubai' }).format(new Date(v)) : '-';
