import { currentUser } from "@/lib/auth";
import { callExportRows, exportRows } from "@/lib/dashboard";
import { callLabel, formatStamp, isValidDate, today } from "@/lib/time";

const LABEL: Record<string, string> = { planned: "To do", in_progress: "In progress", partial: "Partially done", done: "Done", not_done: "Not done" };

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.access === "staff") return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const d = url.searchParams.get("date");
  const date = isValidDate(d) ? d : today();
  const requested = Number(url.searchParams.get("department")) || null;
  const dept = user.access === "head" ? user.department_id : requested;

  if (url.searchParams.get("type") === "calls") return callsCsv(date, dept);

  const rows = await exportRows(date, dept);
  const lines = [
    ["Date", "Department", "Name", "Role", "Reported", "Task #", "Task", "Status", "Note", "Carried over", "Added (IST)", "Completed (IST)"].join(","),
    ...rows.map((r) =>
      [date, r.department, r.name, r.role, r.reported ? "Yes" : "No", r.seq, r.description, r.status ? LABEL[r.status] : "", r.note, r.carried ? "Yes" : "", formatStamp(r.added_at, date), formatStamp(r.completed_at, date)]
        .map(csvCell)
        .join(","),
    ),
  ];
  return csv(lines, `tasks-${date}.csv`);
}

/** The day's service calls in order, then the ones carried over from earlier days. Times are IST. */
async function callsCsv(date: string, dept: number | null) {
  const rows = await callExportRows(dept, date);
  const lines = [
    ["Date", "Department", "Call", "Day #", "Received on", "Received (IST)", "Hour", "Carried over", "Ref", "Customer", "Phone", "Complaint", "Engineer", "Status", "Closed (IST)", "Times called", "Source", "Notes"].join(","),
    ...rows.map((r) => {
      const hour = Number(new Date(r.opened_at).toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: process.env.APP_TIME_ZONE ?? "Asia/Kolkata" })) % 24;
      return [date, r.department, callLabel(r.call_date, r.day_no), r.day_no, r.call_date, formatStamp(r.opened_at), `${String(hour).padStart(2, "0")}:00`,
        r.carried ? "Yes" : "", r.id, r.customer, r.caller_phone ? `+${r.caller_phone}` : "", r.complaint, r.engineer,
        r.status === "closed" ? "Closed" : "Pending", formatStamp(r.closed_at, date), r.call_count, r.source === "phone" ? "Service phone" : "WhatsApp", r.notes]
        .map(csvCell)
        .join(",");
    }),
  ];
  return csv(lines, `calls-${date}.csv`);
}

function csv(lines: string[], filename: string) {
  return new Response("﻿" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
