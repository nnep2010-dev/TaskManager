import { one, query } from "./db";

export type CallStatus = "pending" | "closed";

export type CallDetail = {
  id: number;
  customer: string;
  complaint: string | null;
  engineer_id: number | null;
  department_id: number | null;
  status: CallStatus;
  notes: string | null;
  caller_phone: string | null;
  source: "whatsapp" | "phone";
  call_count: number;
  opened_at: Date;
  closed_at: Date | null;
};

export async function callDetail(id: number) {
  return one<CallDetail>(
    `select c.id, c.customer, c.complaint, c.engineer_id, e.department_id, c.status, c.notes,
            c.caller_phone, c.source, c.call_count, c.opened_at, c.closed_at
       from service_calls c left join employees e on e.id = c.engineer_id
      where c.id = $1`,
    [id],
  );
}

export async function departmentStaff(departmentId: number) {
  return query<{ id: number; name: string; role: string }>(
    "select id, name, role from employees where department_id = $1 and active order by is_head desc, name",
    [departmentId],
  );
}

/**
 * Saves a call edited on the dashboard. Closing stamps closed_at (so it counts as "closed this day"),
 * reopening clears it. The engineer can only be moved to someone in the same department.
 */
export async function saveCall(
  id: number,
  departmentId: number,
  input: { customer: string; complaint: string | null; engineerId: number; status: CallStatus; notes: string | null },
) {
  return one<{ id: number }>(
    `update service_calls c
        set customer = $2, complaint = $3, notes = $5, status = $6,
            engineer_id = coalesce((select id from employees where id = $4 and department_id = $7), c.engineer_id),
            closed_at = case when $6 = 'closed' then coalesce(c.closed_at, now()) end
      where c.id = $1
      returning c.id`,
    [id, input.customer, input.complaint, input.engineerId, input.notes, input.status, departmentId],
  );
}
