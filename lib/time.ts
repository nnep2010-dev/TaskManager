export const TIME_ZONE = process.env.APP_TIME_ZONE ?? "Asia/Kolkata";

/** Today's date (YYYY-MM-DD) in the company's time zone. */
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

export function isValidDate(s: string | undefined | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function formatDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function formatTime(ts: Date | string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });
}

/** A time in the company's time zone; with the date too when it falls on a different day than `onDate`. */
export function formatStamp(ts: Date | string | null, onDate?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (!onDate || today(d) === onDate) return formatTime(d);
  return `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TIME_ZONE })}, ${formatTime(d)}`;
}

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** "12 Nov" for a YYYY-MM-DD date. */
export function shortDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** A call's daily number: "#3" for a call received on `onDate`, "12 Nov #7" for one from another day. */
export function callLabel(callDate: string, dayNo: number, onDate?: string): string {
  return callDate === onDate ? `#${dayNo}` : `${shortDate(callDate)} #${dayNo}`;
}
