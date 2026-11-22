/**
 * Helper utilities for standardized timezone (Asia/Jakarta / WIB / UTC+7).
 */

export const TIMEZONE = 'Asia/Jakarta';

/**
 * Returns YYYY-MM-DD formatted date in Asia/Jakarta timezone.
 */
export function getJakartaDate(date: Date | string | number = new Date()): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
}

/**
 * Returns Indonesian day name (Senin, Selasa, dll.) in Asia/Jakarta timezone.
 */
export function getJakartaDayName(date: Date | string | number = new Date()): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat('id-ID', { timeZone: TIMEZONE, weekday: 'long' }).format(d);
}

/**
 * Returns formatted date in Indonesian locale (e.g. "22/11/2026") in Asia/Jakarta.
 */
export function formatJakartaDateID(date: Date | string | number = new Date()): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat('id-ID', { timeZone: TIMEZONE }).format(d);
}

/**
 * Returns current month (1-12) and year in Asia/Jakarta timezone.
 */
export function getJakartaMonthYear(date: Date | string | number = new Date()): { month: number; year: number } {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { month: Number(m.month), year: Number(m.year) };
}

/**
 * Returns week range (Sunday to Saturday) in Asia/Jakarta timezone.
 */
export function getJakartaWeekRange(date: Date | string | number = new Date()): {
  today: string;
  dayName: string;
  sundayDate: string;
  saturdayDate: string;
} {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[m.weekday] ?? 0;

  const curDate = new Date(Date.UTC(+m.year, +m.month - 1, +m.day));
  const sunday = new Date(curDate);
  sunday.setUTCDate(curDate.getUTCDate() - dayOfWeek);

  const saturday = new Date(sunday);
  saturday.setUTCDate(sunday.getUTCDate() + 6);

  const fmt = (dt: Date) => dt.toISOString().split('T')[0];

  return {
    today: fmt(curDate),
    dayName: getJakartaDayName(d),
    sundayDate: fmt(sunday),
    saturdayDate: fmt(saturday),
  };
}
