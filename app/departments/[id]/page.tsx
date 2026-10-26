import Link from "next/link";
import { notFound } from "next/navigation";
import { DateBar, StatusPill } from "@/components/DateBar";
import { canSeeDepartment, requireUser } from "@/lib/auth";
import { departmentDetail, recentCalls, serviceStats } from "@/lib/dashboard";
import { formatTime, isValidDate, today } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
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
  const [stats, calls] = isService ? await Promise.all([serviceStats(id, date), recentCalls(id)]) : [null, []];

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

      {stats && (
        <div className="kpis">
          <div className="card kpi"><div className="num">{stats.total}</div><div className="label">Total calls</div></div>
          <div className="card kpi"><div className="num">{stats.pending}</div><div className="label">Pending calls</div></div>
          <div className="card kpi"><div className="num">{stats.today}</div><div className="label">Calls logged this day</div></div>
          <div className="card kpi"><div className="num">{stats.closed_today}</div><div className="label">Calls closed this day</div></div>
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
              </div>
              {p.submitted_at ? (
                <span className="pill ok" title="Time the day's tasks were sent">{formatTime(p.submitted_at)}</span>
              ) : (
                <span className="pill missing-pill">Not reported</span>
              )}
            </div>
            {p.tasks.length ? (
              <ul className="tasks">
                {p.tasks.map((t) => (
                  <li key={t.seq}>
                    <span>
                      {t.seq}. {t.description}
                      {t.carried && <span className="carried"> · carried over</span>}
                    </span>
                    <StatusPill status={t.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No tasks</p>
            )}
          </div>
        ))}
      </div>

      {isService && (
        <>
          <h2>Service calls (pending and closed in the last 7 days)</h2>
          {calls.length ? (
            <div className="table-wrap">
              <table className="list">
                <thead><tr><th>#</th><th>Customer</th><th>Complaint</th><th>Engineer</th><th>Status</th><th>Notes</th></tr></thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id}>
                      <td>{c.id}</td><td>{c.customer}</td><td>{c.complaint}</td><td>{c.engineer}</td>
                      <td><StatusPill status={c.status} /></td><td>{c.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No service calls logged yet.</p>
          )}
        </>
      )}
    </>
  );
}
