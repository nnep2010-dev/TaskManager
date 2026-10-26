/**
 * Creates the tables, loads the dummy organisation and creates dashboard logins.
 * Usage: npm run db:setup            (safe to run again; it skips what already exists)
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { pool } from "../lib/db";

const password = () => randomBytes(6).toString("base64url");

async function main() {
  await pool.query(readFileSync(join(__dirname, "../db/schema.sql"), "utf8"));
  if (!process.argv.includes("--no-seed")) await pool.query(readFileSync(join(__dirname, "../db/seed.sql"), "utf8"));

  const created: string[] = [];
  const addUser = async (email: string, name: string, access: "proprietor" | "head", employeeId: number | null, pw: string) => {
    const res = await pool.query(
      `insert into users (email, password_hash, display_name, access, employee_id) values ($1, $2, $3, $4, $5)
       on conflict (email) do nothing returning id`,
      [email.toLowerCase(), await bcrypt.hash(pw, 10), name, access, employeeId],
    );
    if (res.rowCount) created.push(`${access.padEnd(10)} ${email.padEnd(28)} ${pw}`);
  };

  await addUser(
    process.env.OWNER_EMAIL ?? "owner@example.com",
    process.env.OWNER_NAME ?? "Proprietor",
    "proprietor",
    null,
    process.env.OWNER_PASSWORD ?? password(),
  );

  const heads = await pool.query<{ id: number; name: string; department: string }>(
    `select e.id, e.name, d.name as department from employees e join departments d on d.id = e.department_id where e.is_head and e.active`,
  );
  for (const h of heads.rows) {
    await addUser(`${h.department.toLowerCase()}@example.com`, h.name, "head", h.id, password());
  }

  console.log("Database ready.");
  if (created.length) {
    console.log("\nNew dashboard logins (save these, passwords are not shown again):");
    console.log(created.join("\n"));
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
