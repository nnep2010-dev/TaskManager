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
      where ($2::int is null or d.id = $2)
      group by d.id
      order by d.sort_order`,
    [date, onlyDepartmentId ?? null],
  );
}

export type PersonDay = {
  id: number;
  name: string;
  role: string;
  is_head: boolean;
  phone: string | null;
  submitted_at: Date | null;
  tasks: { seq: number; description: string; status: TaskStatus; carried: boolean }[];
};

export async function departmentDetail(departmentId: number, date: string) {
  const dept = await one<{ id: number; name: string }>("select id, name from departments where id = $1", [departmentId]);
  if (!dept) return null;
  const people = await query<PersonDay>(
    `select e.id, e.name, e.role, e.is_head, e.phone, r.submitted_at,
            coalesce(json_agg(json_build_object('seq', t.seq, 'description', t.description, 'status', t.status,
                     'carried', t.carried_from is not null) order by t.seq) filter (where t.id is not null), '[]') as tasks
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

export async function serviceStats(departmentId: number, date: string) {
  return one<{ total: number; pending: number; today: number; closed_today: number }>(
    `select count(*)::int as total,
            count(*) filter (where c.status = 'pending')::int as pending,
            count(*) filter (where (c.opened_at at time zone $2)::date = $3::date)::int as today,
            count(*) filter (where (c.closed_at at time zone $2)::date = $3::date)::int as closed_today
       from service_calls c join employees e on e.id = c.engineer_id
      where e.department_id = $1`,
    [departmentId, process.env.APP_TIME_ZONE ?? "Asia/Kolkata", date],
  );
}

export type CallRow = {
  id: number;
  customer: string;
  complaint: string | null;
  engineer: string;
  status: "pending" | "closed";
  opened_at: Date;
  closed_at: Date | null;
  notes: string | null;
};

export async function recentCalls(departmentId: number) {
  return query<CallRow>(
    `select c.id, c.customer, c.complaint, e.name as engineer, c.status, c.opened_at, c.closed_at, c.notes
       from service_calls c join employees e on e.id = c.engineer_id
      where e.department_id = $1 and (c.status = 'pending' or c.closed_at > now() - interval '7 days')
      order by c.status desc, c.opened_at desc
      limit 50`,
    [departmentId],
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
            coalesce(json_agg(json_build_object('seq', t.seq, 'description', t.description, 'status', t.status,
                     'carried', t.carried_from is not null) order by t.seq) filter (where t.id is not null), '[]') as tasks
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
  return query<{ department: string; name: string; role: string; seq: number | null; description: string | null; status: string | null; carried: boolean | null; reported: boolean }>(
    `select d.name as department, e.name, e.role, t.seq, t.description, t.status,
            t.carried_from is not null as carried, r.submitted_at is not null as reported
       from employees e
       join departments d on d.id = e.department_id
       left join daily_reports r on r.employee_id = e.id and r.report_date = $1
       left join tasks t on t.employee_id = e.id and t.report_date = $1
      where e.active and ($2::int is null or d.id = $2)
      order by d.sort_order, e.is_head desc, e.name, t.seq`,
    [date, onlyDepartmentId ?? null],
  );
}
