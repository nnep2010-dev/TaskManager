import { addDays, formatDate, today } from "@/lib/time";

/** Date picker that works without JavaScript: a GET form plus previous/next links. */
export function DateBar({ date, path, exportDept }: { date: string; path: string; exportDept?: number }) {
  const exportHref = `/api/export?date=${date}${exportDept ? `&department=${exportDept}` : ""}`;
  return (
    <form className="inline" action={path} method="get">
      <a className="btn secondary" href={`${path}?date=${addDays(date, -1)}`} aria-label="Previous day">‹</a>
      <input type="date" name="date" defaultValue={date} max={today()} aria-label="Date" />
      <button type="submit" className="secondary">Go</button>
      {date < today() && <a className="btn secondary" href={`${path}?date=${addDays(date, 1)}`} aria-label="Next day">›</a>}
      <a className="btn secondary" href={exportHref}>Export CSV</a>
      <span className="sub" style={{ margin: 0 }}>{formatDate(date)}</span>
    </form>
  );
}

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    planned: "To do", in_progress: "In progress", done: "Done", not_done: "Not done", pending: "Pending", closed: "Closed",
  };
  return <span className={`pill ${status}`}>{label[status] ?? status}</span>;
}
