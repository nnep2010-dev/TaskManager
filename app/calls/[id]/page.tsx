import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canSeeDepartment, currentUser, requireUser } from "@/lib/auth";
import { callDetail, departmentStaff, saveCall, type CallStatus } from "@/lib/calls";
import { formatStamp, today } from "@/lib/time";

export const dynamic = "force-dynamic";

const STATUSES: { value: CallStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "closed", label: "Closed" },
];

async function save(formData: FormData) {
  "use server";
  const user = await currentUser();
  const id = Number(formData.get("id"));
  const call = Number.isInteger(id) ? await callDetail(id) : null;
  // Management and the head of the call's department (the Service Manager) can edit.
  if (!user || !call?.department_id || !canSeeDepartment(user, call.department_id)) redirect("/");

  const customer = String(formData.get("customer") ?? "").trim().slice(0, 200);
  const status = String(formData.get("status") ?? "") as CallStatus;
  if (!customer || !STATUSES.some((s) => s.value === status)) redirect(`/calls/${id}?error=1`);
  await saveCall(id, call.department_id, {
    customer,
    complaint: String(formData.get("complaint") ?? "").trim().slice(0, 1000) || null,
    engineerId: Number(formData.get("engineer_id")),
    status,
    notes: String(formData.get("notes") ?? "").trim().slice(0, 2000) || null,
  });
  redirect(`/departments/${call.department_id}?saved=call-${id}`);
}

export default async function EditCallPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const call = await callDetail(id);
  if (!call?.department_id || !canSeeDepartment(user, call.department_id)) notFound();
  const staff = await departmentStaff(call.department_id);
  const sp = await searchParams;
  const back = `/departments/${call.department_id}`;

  return (
    <>
      <div className="breadcrumb">
        {user.access === "proprietor" && <><Link href="/">All departments</Link> / </>}
        <Link href={back}>Service</Link> /
      </div>
      <h1>Call #{call.id}</h1>
      <p className="sub">
        Logged {formatStamp(call.opened_at, today())}
        {call.source === "phone" && ` · 📱 auto-logged from the service phone${call.call_count > 1 ? `, called ${call.call_count} times` : ""}`}
        {call.caller_phone && ` · +${call.caller_phone}`}
        {call.closed_at && ` · closed ${formatStamp(call.closed_at, today())}`}
      </p>
      {sp.error && <p className="notice">Please fill in the customer name.</p>}

      <form action={save} className="card edit-tasks edit-call">
        <input type="hidden" name="id" value={call.id} />
        <label>
          <b>Customer</b>
          <input name="customer" defaultValue={call.customer} required maxLength={200} />
        </label>
        <label>
          <b>Complaint</b>
          <textarea name="complaint" defaultValue={call.complaint ?? ""} rows={2} placeholder="What is the problem?" />
        </label>
        <label>
          <b>Engineer</b>
          <select name="engineer_id" defaultValue={call.engineer_id ?? undefined}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
          </select>
        </label>
        <label>
          <b>Status</b>
          <select name="status" defaultValue={call.status}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label>
          <b>Notes</b>
          <textarea name="notes" defaultValue={call.notes ?? ""} rows={3} placeholder="What was done, parts used, next visit…" />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit">Save call</button>
          <Link className="btn secondary" href={back}>Back</Link>
        </div>
      </form>
    </>
  );
}
