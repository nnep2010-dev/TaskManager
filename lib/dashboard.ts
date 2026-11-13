import { query, one } from "./db";
import type { TaskStatus } from "./bot";

export type DeptSummary = {
  id: number;
  name: string;
  staff: number;
  reported: number;
  tasks: number;
  done: number;
  missing: string[];
};

export async function departmentSummaries(date: string, onlyDepartmentId?: number | null) {
  return query<DeptSummary>(
    `select d.id, d.name,
            count(distinct e.id)::int as staff,
            count(distinct e.id) filter (where r.submitted_at is not null)::int as reported,
            count(t.id)::int as tasks,
            count(t.id) filter (where t.status = 'done')::int as done,
            coalesce(array_agg(distinct e.name) filter (where r.submitted_at is null and e.id is not null), '{}') as missing
       from departments d
       left join employees e on e.department_id = d.id and e.active
       left join daily_reports r on r.employee_id = e.id and r.report_date = $1
       left join tasks t on t.employee_id = e.id and t.report_date = $1
      where (d.id = $2 or ($2::int is null and d.active))
      group by d.id
      order by d.sort_order`,
    [date, onlyDepartmentId ?? null],
  );
}

/** Departments that are paused: no WhatsApp prompts and hidden from the home page. */
export async function pausedDepartments() {
  return query<{ id: number; name: string; staff: number }>(
    `select d.id, d.name, count(e.id)::int as staff
       from departments d left join employees e on e.department_id = d.id and e.active
      where not d.active
      group by d.id
      order by d.sort_order`,
  );
}

export type PersonDay = {
  id: number;
  name: string;
  role: string;
  is_head: boolean;
  phone: string | null;
  submitted_at: Date | null;
  tasks: { seq: number; description: string; status: TaskStatus; note: string | null; carried: boolean; added_at: string; completed_at: string | null }[];
};

export async function departmentDetail(departmentId: number, date: string) {
  const dept = await one<{ id: number; name: string; active: boolean }>("select id, name, active from departments where id = $1", [departmentId]);
  if (!dept) return null;
  const people = await query<PersonDay>(
    `select e.id, e.name, e.role, e.is_head, e.phone, r.submitted_at,
            coalesce(json_agg(json_build_object('seq', t.seq, 'description', t.description, 'status', t.status, 'note', t.note,
                     'carried', t.carried_from is not null, 'added_at', t.created_at, 'completed_at', t.completed_at) order by t.seq) filter (where t.id is not null), '[]') as tasks
       from employees e
       left join daily_reports r on r.employee_id = e.id and r.report_date = $2
       left join tasks t on t.employee_id = e.id and t.report_date = $2
      where e.department_id = $1 and e.active
      group by e.id, r.submitted_at
      order by e.is_head desc, e.role, e.name`,
    [departmentId, date],
  );
  return { dept, people };
}

const TZ = () => process.env.APP_TIME_ZONE ?? "Asia/Kolkata";

/**
 * The Service numbers for one day: calls received that day (numbered from 1), calls carried over
 * from earlier days (still pending when the day began), calls closed that day, and calls still
 * pending at the end of the day (now, for today).
 */
export async function serviceStats(departmentId: number, date: string) {
  return one<{ received: number; carried: number; closed: number; pending: number }>(
    `select count(*) filter (where c.call_date = $3::date)::int as received,
            count(*) filter (where c.call_date < $3::date and (c.closed_at is null or (c.closed_at at time zone $2)::date >= $3::date))::int as carried,
            count(*) filter (where (c.closed_at at time zone $2)::date = $3::date)::int as closed,
            count(*) filter (where c.call_date <= $3::date and (c.closed_at is null or (c.closed_at at time zone $2)::date > $3::date))::int as pending
       from service_calls c join employees e on e.id = c.engineer_id
      where e.department_id = $1 and c.status in ('pending', 'closed')`,
    [departmentId, TZ(), date],
  );
}

export type CallRow = {
  id: number;
  call_date: string;
  day_no: number;
  customer: string;
  complaint: string | null;
  engineer: string;
  status: "pending" | "closed";
  opened_at: Date;
  closed_at: Date | null;
  notes: string | null;
  caller_phone: string | null;
  source: "whatsapp" | "phone";
  call_count: number;
};

const CALL_COLUMNS = `c.id, c.call_date, c.day_no, c.customer, c.complaint, e.name as engineer, c.status, c.opened_at, c.closed_at,
            c.notes, c.caller_phone, c.source, c.call_count`;

/**
 * The calls for one day: those received that day in order (#1, #2, …), and those carried over from
 * earlier days: still pending, or pending when the day began and closed during it.
 */
export async function callsForDay(departmentId: number, date: string) {
  const rows = await query<CallRow & { carried: boolean }>(
    `select ${CALL_COLUMNS}, c.call_date < $2::date as carried
       from service_calls c join employees e on e.id = c.engineer_id
      where e.department_id = $1
        and (c.call_date = $2::date
             or (c.call_date < $2::date and (c.closed_at is null or (c.closed_at at time zone $3)::date >= $2::date)))
      order by c.call_date, c.day_no`,
    [departmentId, date, TZ()],
  );
  return { received: rows.filter((r) => !r.carried), carried: rows.filter((r) => r.carried) };
}

/** How many calls were received in each IST hour, over the `days` days up to and including `date`. */
export async function callsByHour(departmentId: number, date: string, days = 30) {
  const rows = await query<{ hour: number; calls: number; on_day: number }>(
    `select extract(hour from c.opened_at at time zone $3)::int as hour, count(*)::int as calls,
            count(*) filter (where c.call_date = $2::date)::int as on_day
       from service_calls c join employees e on e.id = c.engineer_id
      where e.department_id = $1 and c.call_date > $2::date - $4::int and c.call_date <= $2::date
      group by 1 order by 1`,
    [departmentId, date, TZ(), days],
  );
  return hourBuckets(rows);
}

/** Fills in the empty hours, from 9 am to 6 pm at least and wider if calls came in earlier or later. */
export function hourBuckets(rows: { hour: number; calls: number; on_day: number }[]) {
  const from = Math.min(9, ...rows.map((r) => r.hour));
  const to = Math.max(18, ...rows.map((r) => r.hour));
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  return Array.from({ length: to - from + 1 }, (_, i) => {
    const hour = from + i;
    return { hour, calls: byHour.get(hour)?.calls ?? 0, on_day: byHour.get(hour)?.on_day ?? 0 };
  });
}

/** Calls for the CSV: the day's calls and the ones carried over into it. */
export async function callExportRows(departmentId: number | null, date: string) {
  return query<CallRow & { carried: boolean; department: string }>(
    `select ${CALL_COLUMNS}, c.call_date < $2::date as carried, d.name as department
       from service_calls c join employees e on e.id = c.engineer_id join departments d on d.id = e.department_id
      where ($1::int is null or e.department_id = $1)
        and (c.call_date = $2::date
             or (c.call_date < $2::date and (c.closed_at is null or (c.closed_at at time zone $3)::date >= $2::date)))
      order by d.sort_order, c.call_date < $2::date desc, c.call_date, c.day_no`,
    [departmentId, date, TZ()],
  );
}

export async function personHistory(employeeId: number, days = 14) {
  const person = await one<{ id: number; name: string; role: string; department_id: number; department: string; manager: string | null }>(
    `select e.id, e.name, e.role, e.department_id, d.name as department, m.name as manager
       from employees e join departments d on d.id = e.department_id left join employees m on m.id = e.reports_to
      where e.id = $1`,
    [employeeId],
  );
  if (!person) return null;
  const daysRows = await query<{ report_date: string; submitted_at: Date | null; tasks: PersonDay["tasks"] }>(
    `select r.report_date, r.submitted_at,
            coalesce(json_agg(json_build_object('seq', t.seq, 'description', t.description, 'status', t.status, 'note', t.note,
                     'carried', t.carried_from is not null, 'added_at', t.created_at, 'completed_at', t.completed_at) order by t.seq) filter (where t.id is not null), '[]') as tasks
       from daily_reports r left join tasks t on t.report_id = r.id
      where r.employee_id = $1
      group by r.id
      order by r.report_date desc
      limit $2`,
    [employeeId, days],
  );
  return { person, days: daysRows };
}

export async function exportRows(date: string, onlyDepartmentId?: number | null) {
  return query<{ department: string; name: string; role: string; seq: number | null; description: string | null; status: string | null; note: string | null; carried: boolean | null; reported: boolean; added_at: Date | null; completed_at: Date | null }>(
    `select d.name as department, e.name, e.role, t.seq, t.description, t.status, t.note,
            t.carried_from is not null as carried, r.submitted_at is not null as reported,
            t.created_at as added_at, t.completed_at
       from employees e
       join departments d on d.id = e.department_id
       left join daily_reports r on r.employee_id = e.id and r.report_date = $1
       left join tasks t on t.employee_id = e.id and t.report_date = $1
      where e.active and (d.id = $2 or ($2::int is null and d.active))
      order by d.sort_order, e.is_head desc, e.name, t.seq`,
    [date, onlyDepartmentId ?? null],
  );
}
