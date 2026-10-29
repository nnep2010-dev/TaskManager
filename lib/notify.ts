import { todaysTasks, type TaskStatus } from "./bot";
import { one } from "./db";
import { formatDate, today } from "./time";
import { sendTemplate, sendText, windowOpen } from "./whatsapp";

const TEMPLATE_UPDATED = process.env.TEMPLATE_TASKS_UPDATED ?? "tasks_updated";

const STATUS_MARK: Record<TaskStatus, string> = {
  planned: "▫️",
  in_progress: "⏳",
  done: "✅",
  not_done: "❌",
};

export type TaskChanges = { added: string[]; edited: string[]; removed: string[] };

export const hasChanges = (c: TaskChanges) => c.added.length + c.edited.length + c.removed.length > 0;

/**
 * Tells a staff member on WhatsApp that a manager changed their task list.
 * Inside the 24-hour window they get the changes and the full list; outside it,
 * an approved template asking them to reply *list*.
 */
export async function notifyTaskChanges(employeeId: number, date: string, managerName: string, changes: TaskChanges) {
  const e = await one<{ id: number; name: string; phone: string | null }>(
    "select id, name, phone from employees where id = $1 and active",
    [employeeId],
  );
  if (!e?.phone) return;
  const first = e.name.split(" ")[0];
  const manager = managerName.split(" ")[0];
  const day = date === today() ? "today" : formatDate(date);

  if (await windowOpen(e.phone)) {
    const lines = [`Hi ${first}, ${manager} has updated your tasks for ${day}.`];
    if (changes.added.length) lines.push("", "*Added:*", ...changes.added.map((d) => `• ${d}`));
    if (changes.edited.length) lines.push("", "*Changed:*", ...changes.edited.map((d) => `• ${d}`));
    if (changes.removed.length) lines.push("", "*Removed:*", ...changes.removed.map((d) => `• ${d}`));
    const tasks = await todaysTasks(e.id, date);
    if (tasks.length) {
      lines.push("", "Your list now:", ...tasks.map((t) => `${STATUS_MARK[t.status]} ${t.seq}. ${t.description}`));
    }
    if (date === today()) lines.push("", "Reply e.g. *1 done* when you finish a task.");
    await sendText(e.phone, e.id, lines.join("\n"));
  } else {
    await sendTemplate(e.phone, e.id, TEMPLATE_UPDATED, [first, manager, day],
      `Hi ${first}, ${manager} has updated your task list for ${day}. Reply list to see your tasks.`);
  }
}
