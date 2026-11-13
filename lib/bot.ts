import { one, pool, query } from "./db";
import { formatTime, shortDate, today } from "./time";
import { sendButtons, sendTemplate, sendText, windowOpen } from "./whatsapp";
import * as voice from "./voice";

export type Employee = {
  id: number;
  name: string;
  phone: string;
  role: string;
  department_id: number;
  department: string;
};

export type Task = {
  id: number;
  seq: number;
  description: string;
  status: TaskStatus;
  note: string | null;
  carried_from: number | null;
};

export type TaskStatus = "planned" | "in_progress" | "partial" | "done" | "not_done";

/** Statuses that need a reason note from the person. */
export const NEEDS_NOTE: TaskStatus[] = ["partial", "not_done"];

type Report = { id: number; submitted_at: Date | null };

const STATUS_LABEL: Record<TaskStatus, string> = {
  planned: "To do",
  in_progress: "In progress",
  partial: "Partially done",
  done: "Done",
  not_done: "Not done",
};

const STATUS_MARK: Record<TaskStatus, string> = {
  planned: "▫️",
  in_progress: "⏳",
  partial: "🌓",
  done: "✅",
  not_done: "❌",
};

const TEMPLATES = {
  morning: process.env.TEMPLATE_MORNING ?? "daily_tasks_morning",
  evening: process.env.TEMPLATE_EVENING ?? "daily_tasks_evening",
  nudge: process.env.TEMPLATE_NUDGE ?? "daily_tasks_reminder",
};

const HELP = [
  "Here's how to update your tasks:",
  "• Send your tasks for today, one per line",
  "• Or send a 🎤 voice message in Tamil or English",
  "• *add* Call ABC Ltd  – add a task",
  "• *2 done*  – mark task 2 done (also: *2 progress*, *2 partial*, *2 not done*)",
  "• *2 partial - waiting for material*  – add the reason in the same message",
  "• *note 2* your note  – add a note to task 2",
  "• *all done*  – mark every task done",
  "• *remove 2*  – delete task 2",
  "• *list*  – see today's tasks",
  "Service calls:",
  "• *new call* Customer name - complaint  – log a call",
  "• *close 12* notes  – close call 12",
  "• *call #12* Customer name - complaint  – fill in details of call 12",
  "• *calls*  – your pending calls",
].join("\n");

const firstName = (e: Employee) => e.name.split(" ")[0];

export async function employeeByPhone(phone: string) {
  return one<Employee>(
    `select e.id, e.name, e.phone, e.role, e.department_id, d.name as department
       from employees e join departments d on d.id = e.department_id
      where e.phone = $1 and e.active and d.active`,
    [phone],
  );
}

/**
 * Returns today's report for the employee, creating it if needed.
 * When created, unfinished tasks from their previous report are carried forward.
 */
export async function ensureReport(employeeId: number, date = today()): Promise<Report> {
  const existing = await one<Report>(
    "select id, submitted_at from daily_reports where employee_id = $1 and report_date = $2",
    [employeeId, date],
  );
  if (existing) return existing;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<Report>(
      `insert into daily_reports (employee_id, report_date) values ($1, $2)
       on conflict (employee_id, report_date) do nothing
       returning id, submitted_at`,
      [employeeId, date],
    );
    if (!ins.rows[0]) {
      // Another request created it at the same moment.
      await client.query("rollback");
      return (await one<Report>(
        "select id, submitted_at from daily_reports where employee_id = $1 and report_date = $2",
        [employeeId, date],
      ))!;
    }
    const report = ins.rows[0];
    await client.query(
      `insert into tasks (report_id, employee_id, report_date, seq, description, status, carried_from)
       select $1, t.employee_id, $3, row_number() over (order by t.seq), t.description,
              case when t.status in ('in_progress', 'partial') then 'in_progress' else 'planned' end, t.id
         from tasks t
        where t.employee_id = $2
          and t.report_date = (select max(report_date) from daily_reports where employee_id = $2 and report_date < $3)
          and t.status <> 'done'`,
      [report.id, employeeId, date],
    );
    await client.query("commit");
    return report;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function todaysTasks(employeeId: number, date = today()) {
  return query<Task>(
    "select id, seq, description, status, note, carried_from from tasks where employee_id = $1 and report_date = $2 order by seq",
    [employeeId, date],
  );
}

function formatList(tasks: Task[]) {
  return tasks
    .map(
      (t) =>
        `${STATUS_MARK[t.status]} ${t.seq}. ${t.description}${t.carried_from ? " _(carried over)_" : ""}` +
        (t.note ? `\n      📝 _${t.note}_` : ""),
    )
    .join("\n");
}

/** Splits a message into task lines, dropping list markers like "1.", "-", "•". */
export function parseTaskLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•–])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, 500));
}

async function addTasks(employeeId: number, reportId: number, lines: string[], date = today()) {
  for (const description of lines) {
    await query(
      `insert into tasks (report_id, employee_id, report_date, seq, description)
       values ($1, $2, $3, (select coalesce(max(seq), 0) + 1 from tasks where employee_id = $2 and report_date = $3), $4)`,
      [reportId, employeeId, date, description],
    );
  }
}

async function markSubmitted(reportId: number) {
  await query("update daily_reports set submitted_at = coalesce(submitted_at, now()) where id = $1", [reportId]);
}

// Longest phrases first, so "partially done" wins over "partially". Phrases marked exact
// only count when nothing follows them, so "2 over budget" isn't read as "2 done".
const STATUS_PHRASES: [string, TaskStatus, "exact"?][] = [
  ["partially completed", "partial"],
  ["partially complete", "partial"],
  ["partially done", "partial"],
  ["partly done", "partial"],
  ["half done", "partial"],
  ["part done", "partial"],
  ["partially", "partial"],
  ["partial", "partial"],
  ["not completed", "not_done"],
  ["not complete", "not_done"],
  ["not done", "not_done"],
  ["notdone", "not_done"],
  ["pending", "not_done"],
  ["cancelled", "not_done"],
  ["canceled", "not_done"],
  ["skipped", "not_done"],
  ["in progress", "in_progress"],
  ["inprogress", "in_progress"],
  ["progress", "in_progress"],
  ["ongoing", "in_progress"],
  ["started", "in_progress"],
  ["wip", "in_progress"],
  ["completed", "done"],
  ["complete", "done"],
  ["finished", "done"],
  ["done", "done"],
  ["over", "done", "exact"],
  ["closed", "done", "exact"],
  ["to do", "planned", "exact"],
  ["todo", "planned", "exact"],
  ["planned", "planned", "exact"],
  ["reopen", "planned", "exact"],
];

/** Reads a status phrase at the start of `lower`, returning the status and where the rest begins. */
function statusAtStart(lower: string): { status: TaskStatus; end: number } | null {
  for (const [phrase, status, exact] of STATUS_PHRASES) {
    if (lower === phrase) return { status, end: phrase.length };
    if (!exact && lower.startsWith(phrase) && /^[\s\-–:,.(]/.test(lower.slice(phrase.length))) {
      return { status, end: phrase.length };
    }
  }
  return null;
}

/**
 * Matches "2 done", "2,3 done", "done 2 3", "2 in progress", and a reason after the status:
 * "2 not done - customer not available", "3 partial because material is late".
 */
export function parseStatusCommand(text: string): { seqs: number[]; status: TaskStatus; note?: string } | null {
  if (/\n/.test(text.trim())) return null; // a multi-line message is a task list
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  let m = lower.match(/^((?:\d+[ ,]*(?:and )?)+)(?:is |are )?/);
  if (m && m[0].length < lower.length) {
    const found = statusAtStart(lower.slice(m[0].length));
    if (found) {
      const note = t
        .slice(m[0].length + found.end)
        .replace(/^[\s\-–:,.(]+/, "")
        .replace(/^(because|reason)\b[\s:-]*/i, "")
        .trim();
      return { seqs: (m[1].match(/\d+/g) ?? []).map(Number), status: found.status, ...(note ? { note: note.slice(0, 1000) } : {}) };
    }
  }
  m = lower.match(/^([a-z ]+?) ((?:\d+[ ,]*(?:and )?)+)$/);
  if (m) {
    const found = statusAtStart(m[1].trim());
    if (found && found.end === m[1].trim().length) return { seqs: (m[2].match(/\d+/g) ?? []).map(Number), status: found.status };
  }
  return null;
}

async function setStatus(employee: Employee, seqs: number[], status: TaskStatus, note?: string) {
  const updated = await query<Task>(
    `update tasks set status = $3, note = coalesce($5, note), note_requested_at = null, updated_at = now()
      where employee_id = $1 and report_date = $2 and seq = any($4::int[])
      returning id, seq, description, status, note, carried_from`,
    [employee.id, today(), status, seqs, note ?? null],
  );
  return updated;
}

/** Today's partly done / not done tasks that still have no reason note, in task order. */
async function tasksMissingNote(employeeId: number) {
  return query<Task>(
    `select id, seq, description, status, note, carried_from from tasks
      where employee_id = $1 and report_date = $2 and status = any($3::text[]) and coalesce(note, '') = ''
      order by seq`,
    [employeeId, today(), NEEDS_NOTE],
  );
}

/** The task whose reason the bot asked for and is still waiting on, if any. */
export async function taskAwaitingNote(employeeId: number) {
  return one<Task>(
    `select id, seq, description, status, note, carried_from from tasks
      where employee_id = $1 and report_date = $2 and note_requested_at is not null
        and status = any($3::text[]) and coalesce(note, '') = ''
      order by seq limit 1`,
    [employeeId, today(), NEEDS_NOTE],
  );
}

function noteQuestion(t: Task) {
  const why = t.status === "partial" ? "is only partly done" : "wasn't done";
  return `📝 Task ${t.seq} (${t.description}) ${why}. What's the reason? Please reply with a short note.`;
}

/**
 * If any of today's partly done / not done tasks has no reason yet, asks for the first one
 * and remembers that the next reply is that note. Returns the question, or "" if none is needed.
 */
async function askForNextNote(employeeId: number): Promise<string> {
  const [next] = await tasksMissingNote(employeeId);
  if (!next) return "";
  await query("update tasks set note_requested_at = now() where id = $1", [next.id]);
  return noteQuestion(next);
}

async function saveNote(employeeId: number, taskId: number, note: string) {
  return one<Task>(
    `update tasks set note = $3, note_requested_at = null, updated_at = now() where id = $1 and employee_id = $2
     returning id, seq, description, status, note, carried_from`,
    [taskId, employeeId, note.trim().slice(0, 1000)],
  );
}

async function replyWithList(employee: Employee, intro?: string, outro?: string) {
  const tasks = await todaysTasks(employee.id);
  if (!tasks.length) {
    await sendText(employee.phone, employee.id, `${intro ? intro + "\n\n" : ""}You have no tasks for today yet. Send them one per line.`);
    return;
  }
  const done = tasks.filter((t) => t.status === "done").length;
  const example = (tasks.find((t) => t.status !== "done") ?? tasks[0]).seq;
  await sendText(
    employee.phone,
    employee.id,
    `${intro ? intro + "\n\n" : ""}*Today's tasks* (${done}/${tasks.length} done)\n${formatList(tasks)}\n\n` +
      (outro || `Reply e.g. *${example} done* to update, or *add* a new task.`),
  );
}

export type Incoming = {
  phone: string;
  text?: string;
  buttonId?: string;
  waMessageId?: string;
  audio?: { mediaId: string; mimeType?: string };
};

/** Handles one message from WhatsApp (or the simulator). Voice can be swapped out in tests. */
export async function handleIncoming(msg: Incoming, voiceApi: Pick<typeof voice, "downloadMedia" | "interpretVoice"> = voice) {
  const logged = await query<{ id: number }>(
    `insert into messages (phone, direction, kind, body, wa_message_id, employee_id)
     values ($1, 'in', $2, $3, $4, (select id from employees where phone = $1))
     on conflict (wa_message_id) do nothing returning id`,
    [msg.phone, msg.buttonId ? "button" : msg.audio ? "voice" : "text", msg.text ?? msg.buttonId ?? (msg.audio ? "🎤 Voice message" : ""), msg.waMessageId ?? null],
  );
  if (!logged.length) return; // WhatsApp retried a message we already handled

  const employee = await employeeByPhone(msg.phone);
  if (!employee) {
    const paused = await one<{ id: number }>(
      `select e.id from employees e join departments d on d.id = e.department_id
        where e.phone = $1 and e.active and not d.active`,
      [msg.phone],
    );
    if (paused) {
      await sendText(msg.phone, paused.id, "Task updates are paused for your team for now. We'll let you know when they start again.");
      return;
    }
    await sendText(msg.phone, null, "Sorry, this number isn't registered for task updates. Please contact the admin.");
    return;
  }

  const report = await ensureReport(employee.id);

  if (msg.buttonId) return handleButton(employee, report, msg.buttonId);

  if (msg.audio) {
    const heard = await listen(employee, msg.audio, logged[0].id, voiceApi);
    if (!heard) return;
    msg = { ...msg, text: heard };
  }

  const text = (msg.text ?? "").trim();
  if (!text) {
    await sendText(employee.phone, employee.id, "I can only read text and voice messages. Please type your tasks or send a voice message.");
    return;
  }
  const lower = text.toLowerCase();

  if (/^(help|menu|\?|commands)$/.test(lower)) {
    await sendText(employee.phone, employee.id, HELP);
    return;
  }

  if (/^(hi|hello|hey|good morning|gm)\b/.test(lower) && text.split(/\n/).length === 1) {
    if (!report.submitted_at) {
      const tasks = await todaysTasks(employee.id);
      await sendText(
        employee.phone,
        employee.id,
        `Hi ${firstName(employee)}! What are your tasks for today? Send them one per line.` +
          (tasks.length ? `\n\nAlready on your list from before:\n${formatList(tasks)}` : ""),
      );
    } else {
      await replyWithList(employee, `Hi ${firstName(employee)}!`);
    }
    return;
  }

  if (/^(list|tasks|status|today|my tasks)$/.test(lower)) {
    const waiting = await taskAwaitingNote(employee.id);
    await replyWithList(employee, undefined, waiting ? noteQuestion(waiting) : undefined);
    return;
  }

  const noteMatch = text.match(/^(?:note|reason|remark)s?\s*(?:for\s*)?(?:task\s*)?#?(\d+)\b[\s:\-–]*([\s\S]*)$/i);
  if (noteMatch) {
    const seq = Number(noteMatch[1]);
    const body = noteMatch[2].trim();
    const task = (await todaysTasks(employee.id)).find((t) => t.seq === seq);
    if (!task) {
      await replyWithList(employee, `There's no task ${seq} today.`);
    } else if (!body) {
      await query("update tasks set note_requested_at = now() where id = $1", [task.id]);
      await sendText(employee.phone, employee.id, `📝 What's the note for task ${seq} (${task.description})?`);
    } else {
      await saveNote(employee.id, task.id, body);
      await markSubmitted(report.id);
      await replyWithList(employee, `📝 Note saved for task ${seq}.`, await askForNextNote(employee.id));
    }
    return;
  }

  if (/^(none|no new tasks|same|same as yesterday|nothing new)$/.test(lower)) {
    await markSubmitted(report.id);
    await replyWithList(employee, "Got it, no new tasks.");
    return;
  }

  const addMatch = text.match(/^add\b[:\s]*([\s\S]+)$/i);
  if (addMatch) {
    const lines = parseTaskLines(addMatch[1]);
    await addTasks(employee.id, report.id, lines);
    await markSubmitted(report.id);
    await replyWithList(employee, `Added ${lines.length} task${lines.length > 1 ? "s" : ""}.`);
    return;
  }

  if (/^(all done|everything done|all completed)$/.test(lower)) {
    await query(
      "update tasks set status = 'done', updated_at = now() where employee_id = $1 and report_date = $2 and status <> 'done'",
      [employee.id, today()],
    );
    await markSubmitted(report.id);
    await replyWithList(employee, "Great work! All tasks marked done.");
    return;
  }

  const removeMatch = lower.match(/^(?:remove|delete)\s+(\d+)$/);
  if (removeMatch) {
    const removed = await query(
      "delete from tasks where employee_id = $1 and report_date = $2 and seq = $3 returning id",
      [employee.id, today(), Number(removeMatch[1])],
    );
    await replyWithList(employee, removed.length ? `Removed task ${removeMatch[1]}.` : `There's no task ${removeMatch[1]} today.`);
    return;
  }

  const statusCmd = parseStatusCommand(text);
  if (statusCmd) {
    const updated = await setStatus(employee, statusCmd.seqs, statusCmd.status, statusCmd.note);
    if (updated.length) await markSubmitted(report.id);
    const missing = statusCmd.seqs.filter((s) => !updated.some((u) => u.seq === s));
    const intro = updated.length
      ? `Updated: ${updated.map((u) => u.seq).join(", ")} → ${STATUS_LABEL[statusCmd.status]}.` +
        (missing.length ? ` No task ${missing.join(", ")} today.` : "")
      : `There's no task ${missing.join(", ")} today.`;
    await replyWithList(employee, intro, await askForNextNote(employee.id));
    return;
  }

  if (await handleServiceCommand(employee, text)) return;

  // The bot asked why a task was partly done or not done: this message is the reason.
  const waiting = await taskAwaitingNote(employee.id);
  if (waiting) {
    await saveNote(employee.id, waiting.id, text);
    const next = await askForNextNote(employee.id);
    await sendText(employee.phone, employee.id, `📝 Thanks, noted for task ${waiting.seq}.${next ? `\n\n${next}` : ""}`);
    return;
  }

  // Anything else: if they haven't sent today's plan yet, treat it as their task list.
  if (!report.submitted_at) {
    const lines = parseTaskLines(text);
    await addTasks(employee.id, report.id, lines);
    await markSubmitted(report.id);
    await replyWithList(employee, `Thanks ${firstName(employee)}! Saved ${lines.length} task${lines.length > 1 ? "s" : ""}.`);
    return;
  }

  await sendText(
    employee.phone,
    employee.id,
    "Sorry, I didn't understand that. To add more tasks, start with *add*, e.g. _add Visit XYZ Ltd_. Send *help* to see all commands.",
  );
}

/**
 * Transcribes a voice message and returns it as the text the person would have typed,
 * or null after telling them it couldn't be used.
 */
async function listen(
  employee: Employee,
  audio: NonNullable<Incoming["audio"]>,
  messageId: number,
  voiceApi: Pick<typeof voice, "downloadMedia" | "interpretVoice">,
): Promise<string | null> {
  if (voiceApi === voice && !voice.voiceEnabled()) {
    await sendText(employee.phone, employee.id, "Voice messages aren't switched on yet. Please type your tasks, one per line.");
    return null;
  }
  let result: voice.VoiceResult;
  try {
    const file = await voiceApi.downloadMedia(audio.mediaId);
    const waiting = await taskAwaitingNote(employee.id);
    result = await voiceApi.interpretVoice(file.data, audio.mimeType ?? file.mimeType, await todaysTasks(employee.id), waiting);
  } catch (err) {
    console.error("Voice message failed", audio.mediaId, err);
    await sendText(employee.phone, employee.id, "Sorry, I couldn't listen to that voice message. Please send it again, or type your tasks.");
    return null;
  }
  const heard = result.heard && result.heard !== result.english ? `${result.heard}\n→ ${result.english}` : result.english || result.heard;
  await query("update messages set body = $2 where id = $1", [messageId, `🎤 ${heard || "(nothing heard)"}`]);

  const text = voice.voiceToText(result);
  if (!text) {
    await sendText(
      employee.phone,
      employee.id,
      `🎤 Sorry, I couldn't find any tasks in that voice message.${result.english ? `\nI heard: _${result.english}_` : ""}\n\nPlease try again, or type your tasks.`,
    );
  }
  return text;
}

async function handleButton(employee: Employee, report: Report, buttonId: string) {
  if (buttonId === "eve:alldone") {
    await query(
      "update tasks set status = 'done', updated_at = now() where employee_id = $1 and report_date = $2 and status <> 'done'",
      [employee.id, today()],
    );
    await markSubmitted(report.id);
    await replyWithList(employee, "Great work! All tasks marked done.");
    return;
  }

  if (buttonId === "eve:each") {
    const open = (await todaysTasks(employee.id)).filter((t) => t.status !== "done");
    if (!open.length) {
      await replyWithList(employee, "Everything is already done.");
      return;
    }
    for (const t of open) {
      await sendButtons(employee.phone, employee.id, `${t.seq}. ${t.description}`, [
        { id: `task:${t.id}:done`, title: "Done" },
        { id: `task:${t.id}:partial`, title: "Partially done" },
        { id: `task:${t.id}:not_done`, title: "Not done" },
      ]);
    }
    return;
  }

  const m = buttonId.match(/^task:(\d+):(done|in_progress|partial|not_done)$/);
  if (m) {
    const t = await one<Task>(
      `update tasks set status = $3, note_requested_at = null, updated_at = now() where id = $1 and employee_id = $2
       returning id, seq, description, status, note, carried_from`,
      [Number(m[1]), employee.id, m[2]],
    );
    if (t) await markSubmitted(report.id);
    const ask = t ? await askForNextNote(employee.id) : "";
    await sendText(
      employee.phone,
      employee.id,
      t ? `${STATUS_MARK[t.status]} Task ${t.seq} marked *${STATUS_LABEL[t.status]}*.${ask ? `\n\n${ask}` : ""}` : "That task no longer exists.",
    );
    return;
  }

  await sendText(employee.phone, employee.id, "Sorry, that button has expired. Send *list* to see your tasks.");
}

async function handleServiceCommand(employee: Employee, text: string): Promise<boolean> {
  const open = text.match(/^new call[:\s]+(.+?)(?:\s+[-–:]\s+([\s\S]+))?$/i);
  if (open) {
    const row = await one<{ id: number; day_no: number }>(
      "insert into service_calls (customer, complaint, engineer_id) values ($1, $2, $3) returning id, day_no",
      [open[1].trim().slice(0, 200), open[2]?.trim().slice(0, 1000) ?? null, employee.id],
    );
    await sendText(
      employee.phone,
      employee.id,
      `📞 Call *#${row!.id}* logged for ${open[1].trim()} (today's call no. ${row!.day_no}). Send *close ${row!.id}* with any notes when it's fixed.`,
    );
    return true;
  }

  const close = text.match(/^close\s+(?:call\s+)?#?(\d+)\b[\s:-]*([\s\S]*)$/i);
  if (close) {
    const row = await one<{ id: number; customer: string }>(
      `update service_calls set status = 'closed', closed_at = now(), notes = nullif($2, '')
        where id = $1 and status = 'pending' returning id, customer`,
      [Number(close[1]), close[2]?.trim() ?? ""],
    );
    await sendText(
      employee.phone,
      employee.id,
      row ? `✅ Call #${row.id} (${row.customer}) closed.` : `Call #${close[1]} isn't open.`,
    );
    return true;
  }

  // Fill in the customer and complaint of a call, e.g. one auto-logged from the service phone.
  const details = text.match(/^call\s+#(\d+)[\s:-]+(.+?)(?:\s+[-–:]\s+([\s\S]+))?$/i);
  if (details) {
    const row = await one<{ id: number; customer: string }>(
      `update service_calls set customer = $2, complaint = coalesce($3, complaint)
        where id = $1 and status = 'pending' returning id, customer`,
      [Number(details[1]), details[2].trim().slice(0, 200), details[3]?.trim().slice(0, 1000) ?? null],
    );
    await sendText(
      employee.phone,
      employee.id,
      row ? `📝 Call #${row.id} updated: ${row.customer}${details[3] ? ` – ${details[3].trim()}` : ""}.` : `Call #${details[1]} isn't open.`,
    );
    return true;
  }

  if (/^(calls|my calls|pending calls)$/i.test(text.trim())) {
    const calls = await query<{ id: number; customer: string; complaint: string | null; caller_phone: string | null; call_count: number; call_date: string; day_no: number; opened_at: Date }>(
      `select id, customer, complaint, caller_phone, call_count, call_date, day_no, opened_at
         from service_calls where engineer_id = $1 and status = 'pending' order by call_date, day_no`,
      [employee.id],
    );
    const day = today();
    await sendText(
      employee.phone,
      employee.id,
      calls.length
        ? `*Your pending calls*\n${calls.map((c) => `#${c.id} ${c.customer}${c.caller_phone && !c.customer.includes(c.caller_phone) ? ` (+${c.caller_phone})` : ""}${c.complaint ? ` – ${c.complaint}` : ""}${c.call_count > 1 ? ` (called ${c.call_count}×)` : ""}\n   _${c.call_date === day ? "Today" : shortDate(c.call_date)} call ${c.day_no}, ${formatTime(c.opened_at)}_`).join("\n")}\n\nSend *close* and the # number when a call is done.`
        : "You have no pending calls.",
    );
    return true;
  }
  return false;
}

async function activeStaff() {
  return query<Employee>(
    `select e.id, e.name, e.phone, e.role, e.department_id, d.name as department
       from employees e join departments d on d.id = e.department_id
      where e.active and d.active and e.phone is not null
      order by d.sort_order, e.id`,
  );
}

/** Morning: ask everyone for today's tasks. */
export async function sendMorningPrompts() {
  let sent = 0;
  for (const e of await activeStaff()) {
    const report = await ensureReport(e.id);
    if (report.submitted_at) continue;
    const carried = await todaysTasks(e.id);
    if (await windowOpen(e.phone)) {
      await sendText(
        e.phone,
        e.id,
        `Good morning ${firstName(e)}! ☀️ What are your tasks for today? Send them one per line.` +
          (carried.length
            ? `\n\nCarried over from your last report:\n${formatList(carried)}\n\nReply *none* if these are all for today.`
            : ""),
      );
    } else {
      await sendTemplate(e.phone, e.id, TEMPLATES.morning, [firstName(e)],
        `Good morning ${firstName(e)}. What are your tasks for today? Reply with one task per line.`);
    }
    await query("update daily_reports set prompted_at = now() where id = $1", [report.id]);
    sent++;
  }
  return sent;
}

/** Late morning: one reminder to anyone who hasn't sent today's tasks. */
export async function sendNudges() {
  let sent = 0;
  for (const e of await activeStaff()) {
    const report = await one<{ id: number; submitted_at: Date | null; nudged_at: Date | null }>(
      "select id, submitted_at, nudged_at from daily_reports where employee_id = $1 and report_date = $2",
      [e.id, today()],
    );
    if (report?.submitted_at || report?.nudged_at) continue;
    const r = report ?? (await ensureReport(e.id));
    if (await windowOpen(e.phone)) {
      await sendText(e.phone, e.id, `Hi ${firstName(e)}, just a reminder to send today's tasks, one per line. 🙏`);
    } else {
      await sendTemplate(e.phone, e.id, TEMPLATES.nudge, [firstName(e)],
        `Hi ${firstName(e)}, a reminder to send today's tasks. Reply with one task per line.`);
    }
    await query("update daily_reports set nudged_at = now() where id = $1", [r.id]);
    sent++;
  }
  return sent;
}

/** Evening: ask everyone with open tasks how the day went. */
export async function sendEveningPrompts() {
  let sent = 0;
  for (const e of await activeStaff()) {
    const tasks = await todaysTasks(e.id);
    const open = tasks.filter((t) => t.status !== "done");
    if (!open.length) continue;
    if (await windowOpen(e.phone)) {
      await sendButtons(
        e.phone,
        e.id,
        `Good evening ${firstName(e)}! How did today go?\n\n${formatList(tasks)}\n\nTap a button, or reply e.g. *1 done*, *2 partial - reason*, *3 not done - reason*.`,
        [
          { id: "eve:alldone", title: "All done" },
          { id: "eve:each", title: "Update each task" },
        ],
      );
    } else {
      await sendTemplate(e.phone, e.id, TEMPLATES.evening, [firstName(e)],
        `Hi ${firstName(e)}, time to update today's tasks. Reply to see your list.`);
    }
    sent++;
  }
  return sent;
}
