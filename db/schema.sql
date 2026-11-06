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
  notes text
);

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
