import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusPill } from "@/components/DateBar";
import { canSeeDepartment, requireUser } from "@/lib/auth";
import { personHistory } from "@/lib/dashboard";
import { formatDate, formatTime } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const data = await personHistory(id, 30);
  if (!data || !canSeeDepartment(user, data.person.department_id)) notFound();
  const { person, days } = data;

  return (
    <>
      <div className="breadcrumb">
        {user.access === "proprietor" && <><Link href="/">All departments</Link> / </>}
        <Link href={`/departments/${person.department_id}`}>{person.department}</Link> /
      </div>
      <h1>{person.name}</h1>
      <p className="sub">{person.role}{person.manager ? ` · reports to ${person.manager}` : ""} · last 30 reports</p>
      {days.length === 0 && <p className="empty">No reports yet.</p>}
      {days.map((d) => (
        <div key={d.report_date} className="card" style={{ marginBottom: 12 }}>
          <div className="person-head" style={{ marginBottom: 8 }}>
            <b>
              {formatDate(d.report_date)}
              {user.access === "proprietor" && <> · <Link className="edit-link" href={`/people/${person.id}/edit?date=${d.report_date}`}>Edit</Link></>}
            </b>
            {d.submitted_at ? <span className="pill ok">Sent {formatTime(d.submitted_at)}</span> : <span className="pill missing-pill">Not reported</span>}
          </div>
          {d.tasks.length ? (
            <ul className="tasks">
              {d.tasks.map((t) => (
                <li key={t.seq}>
                  <span>{t.seq}. {t.description}{t.carried && <span className="carried"> · carried over</span>}</span>
                  <StatusPill status={t.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No tasks</p>
          )}
        </div>
      ))}
    </>
  );
}
