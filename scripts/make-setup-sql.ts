/**
 * Writes one SQL file (tables + dummy staff + dashboard logins) to paste into the Supabase SQL Editor,
 * for when you can't run `npm run db:setup` against the database directly.
 * Usage: npx tsx scripts/make-setup-sql.ts <output.sql>
 * The generated passwords are printed once; the file only holds their hashes.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";

const out = process.argv[2] ?? "supabase-setup.sql";
const departments = ["Admin", "Sales", "Production", "Service", "Development"];
const logins: { email: string; name: string; access: string; dept?: string; pw: string }[] = [
  { email: "owner@example.com", name: "Proprietor", access: "proprietor", pw: randomBytes(6).toString("base64url") },
  ...departments.map((d) => ({ email: `${d.toLowerCase()}@example.com`, name: `${d} head`, access: "head", dept: d, pw: randomBytes(6).toString("base64url") })),
];

const userSql = logins
  .map((l) => {
    const emp = l.dept
      ? `(select e.id from employees e join departments d on d.id = e.department_id where d.name = '${l.dept}' and e.is_head limit 1)`
      : "null";
    const name = l.dept
      ? `coalesce((select e.name from employees e join departments d on d.id = e.department_id where d.name = '${l.dept}' and e.is_head limit 1), '${l.name}')`
      : `'${l.name}'`;
    return `insert into users (email, password_hash, display_name, access, employee_id)
select '${l.email}', '${bcrypt.hashSync(l.pw, 10)}', ${name}, '${l.access}', ${emp}
on conflict (email) do nothing;`;
  })
  .join("\n");

writeFileSync(
  out,
  [
    "-- Task Manager: full setup. Paste into Supabase > SQL Editor and run once.",
    readFileSync(join(__dirname, "../db/schema.sql"), "utf8"),
    readFileSync(join(__dirname, "../db/seed.sql"), "utf8"),
    "-- Dashboard logins",
    userSql,
    "",
  ].join("\n\n"),
);
console.log(`Wrote ${out}\n`);
for (const l of logins) console.log(`${l.access.padEnd(10)} ${l.email.padEnd(26)} ${l.pw}`);
