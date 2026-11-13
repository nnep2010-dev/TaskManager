-- Task Manager schema (PostgreSQL / Supabase)

create table if not exists departments (
  id serial primary key,
  name text not null unique,
  sort_order int not null default 0,
  active boolean not null default true  -- paused departments get no WhatsApp prompts and are hidden from the dashboard
);

create table if not exists employees (
  id serial primary key,
  name text not null,
  phone text unique,                 -- WhatsApp number in E.164 without '+', e.g. 919943991030
  department_id int references departments(id),
  role text not null,
  reports_to int references employees(id),
  is_head boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Dashboard logins. The proprietor sees everything, a head only their own department, staff only their own tasks.
create table if not exists users (
  id serial primary key,
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  access text not null check (access in ('proprietor', 'head', 'staff')),
  employee_id int references employees(id),
  created_at timestamptz not null default now()
);

create table if not exists daily_reports (
  id serial primary key,
  employee_id int not null references employees(id),
  report_date date not null,
  submitted_at timestamptz,
  prompted_at timestamptz,
  nudged_at timestamptz,
  unique (employee_id, report_date)
);

create table if not exists tasks (
  id serial primary key,
  report_id int not null references daily_reports(id) on delete cascade,
  employee_id int not null references employees(id),
  report_date date not null,
  seq int not null,                  -- the number staff use in "3 done"
  description text not null,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'partial', 'done', 'not_done')),
  note text,                         -- reason or remark; asked for when a task is partly done or not done
  note_requested_at timestamptz,     -- when the bot asked for the note, so the next reply is saved as it
  carried_from int references tasks(id),
  created_at timestamptz not null default now(),   -- when the task was added
  completed_at timestamptz,          -- when it was marked done or partly done (set by the trigger below)
  updated_at timestamptz not null default now(),
  unique (employee_id, report_date, seq)
);
create index if not exists tasks_date_idx on tasks (report_date);

create table if not exists service_calls (
  id serial primary key,
  customer text not null,
  complaint text,
  engineer_id int references employees(id),
  status text not null default 'pending' check (status in ('pending', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  notes text,
  caller_phone text,                 -- customer's number when the call came from the service phone
  source text not null default 'whatsapp' check (source in ('whatsapp', 'phone')),
  call_count int not null default 1, -- how many times this number rang while the call was pending
  last_call_at timestamptz,
  call_date date,                    -- IST date the call was received (set by the trigger below)
  day_no int                         -- its number on that day: 1, 2, 3… starting again each day
);
alter table service_calls add column if not exists caller_phone text;
alter table service_calls add column if not exists source text not null default 'whatsapp';
alter table service_calls add column if not exists call_count int not null default 1;
alter table service_calls add column if not exists last_call_at timestamptz;
create index if not exists service_calls_caller_idx on service_calls (caller_phone) where status = 'pending';

-- Every WhatsApp message in and out, so nothing is lost if the bot misreads something.
create table if not exists messages (
  id bigserial primary key,
  employee_id int references employees(id),
  phone text not null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null default 'text',
  body text,
  wa_message_id text unique,
  status text,                       -- sent, dry_run, failed
  buttons jsonb,                     -- reply buttons offered with an outgoing message
  created_at timestamptz not null default now()
);
create index if not exists messages_phone_idx on messages (phone, created_at);

-- Upgrades for databases created before these columns existed.
alter table departments add column if not exists active boolean not null default true;
alter table tasks add column if not exists note text;
alter table tasks add column if not exists note_requested_at timestamptz;
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('planned', 'in_progress', 'partial', 'done', 'not_done'));
alter table tasks add column if not exists completed_at timestamptz;

-- Stamps completed_at whenever a task's status changes, from WhatsApp or the dashboard:
-- the time it became done or partly done, and empty again if it is set back to another status.
create or replace function tasks_stamp_completed() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.completed_at := case when new.status in ('done', 'partial') then now() end;
  end if;
  return new;
end $$;
drop trigger if exists tasks_stamp_completed on tasks;
create trigger tasks_stamp_completed before insert or update of status on tasks
  for each row execute function tasks_stamp_completed();

-- Daily call numbers: every service call gets the IST date it was received (call_date) and its number
-- on that day (day_no), starting again from 1 each day. The id stays as the permanent call reference.
alter table service_calls add column if not exists call_date date;
alter table service_calls add column if not exists day_no int;
update service_calls c set call_date = x.d, day_no = x.n
  from (select id, (opened_at at time zone 'Asia/Kolkata')::date as d,
               row_number() over (partition by (opened_at at time zone 'Asia/Kolkata')::date order by opened_at, id) as n
          from service_calls) x
 where x.id = c.id and c.day_no is null;
create or replace function service_calls_number() returns trigger language plpgsql as $$
begin
  new.call_date := (coalesce(new.opened_at, now()) at time zone 'Asia/Kolkata')::date;
  -- one numbering at a time per day, so two calls arriving together never get the same number
  perform pg_advisory_xact_lock(784512, new.call_date - date '2000-01-01');
  select coalesce(max(day_no), 0) + 1 into new.day_no from service_calls where call_date = new.call_date;
  return new;
end $$;
drop trigger if exists service_calls_number on service_calls;
create trigger service_calls_number before insert on service_calls
  for each row execute function service_calls_number();
create unique index if not exists service_calls_day_no_idx on service_calls (call_date, day_no);
