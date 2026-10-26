import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { currentUser, requireUser } from "@/lib/auth";
import { one, query } from "@/lib/db";

async function changePassword(formData: FormData) {
  "use server";
  const user = await currentUser();
  if (!user) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const row = await one<{ password_hash: string }>("select password_hash from users where id = $1", [user.id]);
  if (!row || !(await bcrypt.compare(current, row.password_hash))) redirect("/account?error=wrong");
  if (next.length < 8 || next !== String(formData.get("confirm") ?? "")) redirect("/account?error=invalid");
  await query("update users set password_hash = $2 where id = $1", [user.id, await bcrypt.hash(next, 10)]);
  redirect("/account?saved=1");
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const user = await requireUser();
  const { error, saved } = await searchParams;
  return (
    <div className="login card" style={{ margin: "4vh auto" }}>
      <h1>Change password</h1>
      <p className="sub">{user.display_name}</p>
      <form action={changePassword}>
        <input name="current" type="password" placeholder="Current password" required autoComplete="current-password" />
        <input name="next" type="password" placeholder="New password (8+ characters)" required minLength={8} autoComplete="new-password" />
        <input name="confirm" type="password" placeholder="Repeat new password" required autoComplete="new-password" />
        {error === "wrong" && <p className="error">Current password is wrong.</p>}
        {error === "invalid" && <p className="error">New passwords must match and be at least 8 characters.</p>}
        {saved && <p style={{ color: "var(--good)" }}>Password changed.</p>}
        <button type="submit">Save</button>
      </form>
    </div>
  );
}
