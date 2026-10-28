import Link from "next/link";
import { redirect } from "next/navigation";
import { DateBar } from "@/components/DateBar";
import { requireUser } from "@/lib/auth";
import { departmentSummaries } from "@/lib/dashboard";
import { isValidDate, today } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const date = isValidDate(sp.date) ? sp.date : today();
  if (user.access === "staff") redirect(user.employee_id ? `/people/${user.employee_id}` : "/account");
  if (user.access === "head" && user.department_id) redirect(`/departments/${user.department_id}?date=${date}`);

  const depts = await departmentSummaries(date);
  const staff = depts.reduce((n, d) => n + d.staff, 0);
  const reported = depts.reduce((n, d) => n + d.reported, 0);
  const tasks = depts.reduce((n, d) => n + d.tasks, 0);
  const done = depts.reduce((n, d) => n + d.done, 0);

  return (
    <>
      <div className="bar">
        <div>
          <h1>All departments</h1>
          <p className="sub" style={{ margin: 0 }}>
            {reported} of {staff} people reported · {done} of {tasks} tasks done
          </p>
        </div>
        <DateBar date={date} path="/" />
      </div>
      <div className="grid">
        {depts.map((d) => (
          <Link key={d.id} href={`/departments/${d.id}?date=${date}`} className="card tile">
            <h3>{d.name}</h3>
            <div className="stat"><span>Reported</span><b>{d.reported} / {d.staff}</b></div>
            <div className="stat"><span>Tasks done</span><b>{d.done} / {d.tasks}</b></div>
            <div className="progress"><span style={{ width: `${d.tasks ? Math.round((d.done / d.tasks) * 100) : 0}%` }} /></div>
            {d.missing.length > 0 && <div className="missing">Not reported: {d.missing.join(", ")}</div>}
          </Link>
        ))}
      </div>
    </>
  );
}
