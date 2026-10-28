-- Task Manager schema (PostgreSQL / Supabase)

create table if not exists departments (
  id serial primary key,
  name text not null unique,
  sort_order int not null default 0
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
    check (status in ('planned', 'in_progress', 'done', 'not_done')),
  carried_from int references tasks(id),
  created_at timestamptz not null default now(),
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
