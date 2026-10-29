import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ensureReport, todaysTasks, type TaskStatus } from "@/lib/bot";
import { currentUser, requireUser } from "@/lib/auth";
import { one, query } from "@/lib/db";
import { hasChanges, notifyTaskChanges, type TaskChanges } from "@/lib/notify";
import { formatDate, isValidDate, today } from "@/lib/time";

export const dynamic = "force-dynamic";

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: "planned", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "not_done", label: "Not done" },
];

async function saveTasks(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user || user.access !== "proprietor") redirect("/");
  const employeeId = Number(formData.get("employee_id"));
  const date = String(formData.get("date") ?? "");
  if (!Number.isInteger(employeeId) || !isValidDate(date)) redirect("/");

  const before = new Map((await todaysTasks(employeeId, date)).map((t) => [t.id, t]));
  const changes: TaskChanges = { added: [], edited: [], removed: [] };

  for (const id of formData.getAll("task_id").map(Number)) {
    const old = before.get(id);
    if (formData.get(`delete_${id}`)) {
      await query("delete from tasks where id = $1 and employee_id = $2", [id, employeeId]);
      if (old) changes.removed.push(old.description);
      continue;
    }
    const description = String(formData.get(`description_${id}`) ?? "").trim();
    const status = String(formData.get(`status_${id}`) ?? "") as TaskStatus;
    if (!description || !STATUSES.some((s) => s.value === status)) continue;
    if (old && old.description !== description) changes.edited.push(`${old.seq}. ${description}`);
    else if (old && old.status !== status) {
      changes.edited.push(`${old.seq}. ${description} – now ${STATUSES.find((s) => s.value === status)!.label}`);
    }
    await query("update tasks set description = $3, status = $4 where id = $1 and employee_id = $2", [id, employeeId, description, status]);
  }

  const newLines = String(formData.get("new_tasks") ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (newLines.length) {
    const report = await ensureReport(employeeId, date);
    for (const description of newLines) {
      await query(
        `insert into tasks (report_id, employee_id, report_date, seq, description)
         values ($1, $2, $3, (select coalesce(max(seq), 0) + 1 from tasks where employee_id = $2 and report_date = $3), $4)`,
        [report.id, employeeId, date, description],
      );
      changes.added.push(description);
    }
  }

  let notified = false;
  if (formData.get("notify") && hasChanges(changes)) {
    try {
      await notifyTaskChanges(employeeId, date, user.display_name, changes);
      notified = true;
    } catch (err) {
      console.error("Task change notification failed", err);
    }
  }
  redirect(`/people/${employeeId}/edit?date=${date}&saved=${notified ? "notified" : "1"}`);
}

export default async function EditTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; saved?: string }>;
}) {
  const user = await requireUser();
  if (user.access !== "proprietor") notFound();
  const id = Number((await params).id);
  const sp = await searchParams;
  const date = isValidDate(sp.date) ? sp.date : today();
  if (!Number.isInteger(id)) notFound();
  const person = await one<{ id: number; name: string; phone: string | null; department_id: number; department: string }>(
    "select e.id, e.name, e.phone, e.department_id, d.name as department from employees e join departments d on d.id = e.department_id where e.id = $1",
    [id],
  );
  if (!person) notFound();
  const tasks = await todaysTasks(id, date);

  return (
    <>
      <div className="breadcrumb">
        <Link href={`/?date=${date}`}>All departments</Link> /{" "}
        <Link href={`/departments/${person.department_id}?date=${date}`}>{person.department}</Link> /{" "}
        <Link href={`/people/${id}`}>{person.name}</Link> /
      </div>
      <h1>Edit tasks · {person.name}</h1>
      <p className="sub">{formatDate(date)} · task numbers stay the same so staff can keep using them on WhatsApp</p>
      {sp.saved && (
        <p style={{ color: "var(--good)" }}>
          {sp.saved === "notified" ? `Changes saved and sent to ${person.name.split(" ")[0]} on WhatsApp.` : "Changes saved."}
        </p>
      )}

      <form action={saveTasks} className="card edit-tasks">
        <input type="hidden" name="employee_id" value={id} />
        <input type="hidden" name="date" value={date} />
        {tasks.length ? (
          <table className="list">
            <thead><tr><th>#</th><th>Task</th><th>Status</th><th>Delete</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.seq}<input type="hidden" name="task_id" value={t.id} /></td>
                  <td><input name={`description_${t.id}`} defaultValue={t.description} required aria-label={`Task ${t.seq}`} /></td>
                  <td>
                    <select name={`status_${t.id}`} defaultValue={t.status} aria-label={`Status of task ${t.seq}`}>
                      {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" name={`delete_${t.id}`} aria-label={`Delete task ${t.seq}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No tasks for this day yet.</p>
        )}
        <label htmlFor="new_tasks"><b>Add tasks</b> <span className="sub">(one per line)</span></label>
        <textarea id="new_tasks" name="new_tasks" rows={3} placeholder="Call ABC Ltd about the quotation" />
        {person.phone && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="notify" defaultChecked={date >= today()} />
            Send {person.name.split(" ")[0]} a WhatsApp message about these changes
          </label>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit">Save changes</button>
          <Link className="btn secondary" href={`/departments/${person.department_id}?date=${date}`}>Back</Link>
        </div>
      </form>
    </>
  );
}
