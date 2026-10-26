import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { createSession, currentUser } from "@/lib/auth";
import { one } from "@/lib/db";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const user = await one<{ id: number; password_hash: string }>("select id, password_hash from users where email = $1", [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) redirect("/login?error=1");
  await createSession(user.id);
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/");
  const { error } = await searchParams;
  return (
    <div className="login card">
      <h1>Task Manager</h1>
      <p className="sub">Sign in to see today&apos;s updates.</p>
      <form action={login}>
        <input name="email" type="email" placeholder="Email" required autoComplete="username" />
        <input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
        {error && <p className="error">Wrong email or password.</p>}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
