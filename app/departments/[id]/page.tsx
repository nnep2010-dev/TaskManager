import Link from "next/link";
import { notFound } from "next/navigation";
import { DateBar, StatusPill } from "@/components/DateBar";
import { TaskRow } from "@/components/TaskRow";
import { setDepartmentActive } from "@/app/departments/actions";
import { canSeeDepartment, requireUser } from "@/lib/auth";
import { callsByHour, callsForDay, departmentDetail, serviceStats, type CallRow } from "@/lib/dashboard";
import { callLabel, formatDate, formatStamp, formatTime, isValidDate, today } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; saved?: string }>;
}) {
  const user = await requireUser();
  const id = Number((await params).id);
  const sp = await searchParams;
  const date = isValidDate(sp.date) ? sp.date : today();
  if (!Number.isInteger(id) || !canSeeDepartment(user, id)) notFound();

  const detail = await departmentDetail(id, date);
  if (!detail) notFound();
  const { dept, people } = detail;
  const isService = dept.name.toLowerCase() === "service";
  const [stats, calls, hours] = isService
    ? await Promise.all([serviceStats(id, date), callsForDay(id, date), callsByHour(id, date)])
    : [null, null, null];

  const tasks = people.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "done").length;
  const reported = people.filter((p) => p.submitted_at).length;

  return (
    <>
      {user.access === "proprietor" && <div className="breadcrumb"><Link href={`/?date=${date}`}>All departments</Link> /</div>}
      <div className="bar">
        <div>
          <h1>{dept.name}</h1>
          <p className="sub" style={{ margin: 0 }}>
            {reported} of {people.length} people reported · {done} of {tasks.length} tasks done
          </p>
        </div>
        <DateBar date={date} path={`/departments/${id}`} exportDept={id} />
      </div>

      {!dept.active && (
        <div className="notice">
          This department is paused: its staff get no WhatsApp prompts and it is hidden from the home page.
          {user.access === "proprietor" && (
            <form action={setDepartmentActive} style={{ display: "inline", marginLeft: 8 }}>
              <input type="hidden" name="department_id" value={id} />
              <input type="hidden" name="active" value="true" />
              <input type="hidden" name="back" value={`/departments/${id}`} />
              <button type="submit">Resume {dept.name}</button>
            </form>
          )}
        </div>
      )}

      {stats && (
        <div className="kpis">
          <div className="card kpi"><div className="num">{stats.received}</div><div className="label">New calls this day</div></div>
          <div className="card kpi"><div className="num">{stats.carried}</div><div className="label">Carried over from earlier days</div></div>
          <div className="card kpi"><div className="num">{stats.closed}</div><div className="label">Calls closed this day</div></div>
          <div className="card kpi"><div className="num">{stats.pending}</div><div className="label">{date === today() ? "Pending now" : "Pending at end of day"}</div></div>
        </div>
      )}

      <h2>Team</h2>
      <div className="grid">
        {people.map((p) => (
          <div key={p.id} className={`card person${p.is_head ? " head" : ""}`}>
            <div className="person-head">
              <div>
                <h3><Link href={`/people/${p.id}`}>{p.name}</Link></h3>
                <div className="role">{p.role}</div>
                {user.access === "proprietor" && <Link className="edit-link" href={`/people/${p.id}/edit?date=${date}`}>Edit tasks</Link>}
              </div>
              {p.submitted_at ? (
                <span className="pill ok" title="Time the day's tasks were sent">{formatTime(p.submitted_at)}</span>
              ) : (
                <span className="pill missing-pill">Not reported</span>
              )}
            </div>
            {p.tasks.length ? (
              <ul className="tasks">
                {p.tasks.map((t) => <TaskRow key={t.seq} task={t} date={date} />)}
              </ul>
            ) : (
              <p className="empty">No tasks</p>
            )}
          </div>
        ))}
      </div>

      {calls && hours && (
        <>
          <div className="bar calls-bar">
            <h2>Service calls received this day</h2>
            <a className="btn secondary" href={`/api/export?type=calls&date=${date}&department=${id}`}>Export calls CSV</a>
          </div>
          {sp.saved?.startsWith("call-") && <p style={{ color: "var(--good)" }}>Call (ref {sp.saved.slice(5)}) saved.</p>}
          {calls.received.length ? <CallTable calls={calls.received} date={date} /> : <p className="empty">No calls received this day.</p>}

          <h2>Carried over</h2>
          <p className="sub">Calls from earlier days that were still pending when this day began. They keep their own day and number.</p>
          {calls.carried.length ? <CallTable calls={calls.carried} date={date} /> : <p className="empty">Nothing carried over.</p>}

          <h2>Calls by hour</h2>
          <HourChart hours={hours} date={date} />
        </>
      )}

      {user.access === "proprietor" && dept.active && (
        <form action={setDepartmentActive} className="paused-list">
          <input type="hidden" name="department_id" value={id} />
          <input type="hidden" name="active" value="false" />
          <input type="hidden" name="back" value="/" />
          <button type="submit" className="secondary">Pause {dept.name}</button>{" "}
          <span className="sub">Stops WhatsApp prompts for this team and hides it from the home page. Nothing is deleted.</span>
        </form>
      )}
    </>
  );
}

function CallTable({ calls, date }: { calls: CallRow[]; date: string }) {
  return (
    <div className="table-wrap">
      <table className="list">
        <thead><tr><th>Call</th><th>Received</th><th>Customer</th><th>Complaint</th><th>Engineer</th><th>Status</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td className="call-no">
                <b>{callLabel(c.call_date, c.day_no, date)}</b>
                <div className="cell-sub" title="Permanent reference, used in WhatsApp: close …">Ref {c.id}</div>
              </td>
              <td className="nowrap">
                {formatStamp(c.opened_at, date)}
                {c.status === "closed" && c.closed_at && <div className="cell-sub">Closed {formatStamp(c.closed_at, date)}</div>}
              </td>
              <td>
                {c.customer}
                {c.caller_phone && !c.customer.includes(c.caller_phone) && <div className="cell-sub">+{c.caller_phone}</div>}
                {c.source === "phone" && <div className="cell-sub">📱 auto-logged{c.call_count > 1 ? ` · called ${c.call_count} times` : ""}</div>}
              </td>
              <td>{c.complaint}</td><td>{c.engineer}</td>
              <td><StatusPill status={c.status} /></td><td>{c.notes}</td>
              <td><Link className="edit-link" href={`/calls/${c.id}`}>Edit</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

/** Bars for the calls received in each hour over the last 30 days, with the chosen day's calls in the darker part. */
function HourChart({ hours, date }: { hours: { hour: number; calls: number; on_day: number }[]; date: string }) {
  const max = Math.max(1, ...hours.map((h) => h.calls));
  const total = hours.reduce((n, h) => n + h.calls, 0);
  if (!total) return <p className="empty">No calls in the last 30 days yet.</p>;
  const busiest = hours.reduce((a, b) => (b.calls > a.calls ? b : a));
  return (
    <div className="card">
      <p className="sub" style={{ marginBottom: 12 }}>
        {total} calls in the 30 days up to {formatDate(date)}. Busiest hour: <b>{hourLabel(busiest.hour)}–{hourLabel(busiest.hour + 1)}</b> ({busiest.calls} calls).
      </p>
      <div className="hour-chart" role="img" aria-label={`Calls by hour: ${hours.map((h) => `${hourLabel(h.hour)} ${h.calls}`).join(", ")}`}>
        {hours.map((h) => (
          <div key={h.hour} className="hour" title={`${hourLabel(h.hour)}–${hourLabel(h.hour + 1)}: ${h.calls} in 30 days, ${h.on_day} this day`}>
            <span className="count">{h.calls || ""}</span>
            <div className="track">
              <div className="bar30" style={{ height: `${(h.calls / max) * 100}%` }}>
                <div className="barday" style={{ height: h.calls ? `${(h.on_day / h.calls) * 100}%` : 0 }} />
              </div>
            </div>
            <span className="hlabel">{hourLabel(h.hour)}</span>
          </div>
        ))}
      </div>
      <p className="legend"><i className="sw30" /> Last 30 days <i className="swday" /> This day</p>
    </div>
  );
}
