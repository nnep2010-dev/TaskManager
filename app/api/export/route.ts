import { currentUser } from "@/lib/auth";
import { exportRows } from "@/lib/dashboard";
import { isValidDate, today } from "@/lib/time";

const LABEL: Record<string, string> = { planned: "To do", in_progress: "In progress", done: "Done", not_done: "Not done" };

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const d = url.searchParams.get("date");
  const date = isValidDate(d) ? d : today();
  const requested = Number(url.searchParams.get("department")) || null;
  const dept = user.access === "head" ? user.department_id : requested;

  const rows = await exportRows(date, dept);
  const lines = [
    ["Date", "Department", "Name", "Role", "Reported", "Task #", "Task", "Status", "Carried over"].join(","),
    ...rows.map((r) =>
      [date, r.department, r.name, r.role, r.reported ? "Yes" : "No", r.seq, r.description, r.status ? LABEL[r.status] : "", r.carried ? "Yes" : ""]
        .map(csvCell)
        .join(","),
    ),
  ];
  return new Response("﻿" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tasks-${date}.csv"`,
    },
  });
}
