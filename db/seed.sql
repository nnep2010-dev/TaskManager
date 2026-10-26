-- Dummy organisation for testing. Replace with real staff before rollout.
-- The three real test numbers are Neha (Sales Manager), Arjun (Sales Executive 1) and Karthik (Service Engineer 1).

insert into departments (name, sort_order) values
  ('Admin', 1), ('Sales', 2), ('Production', 3), ('Service', 4), ('Development', 5)
on conflict (name) do nothing;

insert into employees (name, phone, department_id, role, is_head) values
  ('Lakshmi Iyer',   '910000000101', (select id from departments where name = 'Admin'),       'Admin Manager',        true),
  ('Neha Sharma',    '919943991030', (select id from departments where name = 'Sales'),       'Sales Manager',        true),
  ('Ravi Kumar',     '910000000301', (select id from departments where name = 'Production'),  'Production Manager',   true),
  ('Suresh Menon',   '910000000401', (select id from departments where name = 'Service'),     'Service Admin',        true),
  ('Anita Desai',    '910000000501', (select id from departments where name = 'Development'), 'Development Lead',     true)
on conflict (phone) do nothing;

insert into employees (name, phone, department_id, role, reports_to) values
  ('Priya Nair',     '910000000102', (select id from departments where name = 'Admin'),       'Accounts Executive', (select id from employees where phone = '910000000101')),
  ('Arjun Patel',    '919943991034', (select id from departments where name = 'Sales'),       'Sales Executive 1',  (select id from employees where phone = '919943991030')),
  ('Meera Pillai',   '910000000202', (select id from departments where name = 'Sales'),       'Sales Executive 2',  (select id from employees where phone = '919943991030')),
  ('Vikram Rao',     '910000000203', (select id from departments where name = 'Sales'),       'Sales Executive 3',  (select id from employees where phone = '919943991030')),
  ('Deepak Joshi',   '910000000302', (select id from departments where name = 'Production'),  'Production Supervisor', (select id from employees where phone = '910000000301')),
  ('Karthik Reddy',  '919943991036', (select id from departments where name = 'Service'),     'Service Engineer 1', (select id from employees where phone = '910000000401')),
  ('Sanjay Gupta',   '910000000402', (select id from departments where name = 'Service'),     'Service Engineer 2', (select id from employees where phone = '910000000401')),
  ('Farhan Ali',     '910000000403', (select id from departments where name = 'Service'),     'Service Engineer 3', (select id from employees where phone = '910000000401')),
  ('Kavya Krishnan', '910000000502', (select id from departments where name = 'Development'), 'Design Engineer',    (select id from employees where phone = '910000000501'))
on conflict (phone) do nothing;
