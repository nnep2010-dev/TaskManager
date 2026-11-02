"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { query } from "@/lib/db";

/** Pauses or resumes a department. Paused departments get no WhatsApp prompts and are hidden from the home page. */
export async function setDepartmentActive(formData: FormData) {
  const user = await currentUser();
  if (user?.access !== "proprietor") redirect("/");
  const id = Number(formData.get("department_id"));
  const active = formData.get("active") === "true";
  if (!Number.isInteger(id)) redirect("/");
  await query("update departments set active = $2 where id = $1", [id, active]);
  revalidatePath("/");
  redirect(String(formData.get("back") ?? "/").startsWith("/") ? String(formData.get("back") ?? "/") : "/");
}
