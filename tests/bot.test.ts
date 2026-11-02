import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensureReport, handleIncoming, parseStatusCommand, parseTaskLines, sendMorningPrompts, todaysTasks } from "../lib/bot";
import { one, pool, query } from "../lib/db";
import type { VoiceResult } from "../lib/voice";
import { addDays, today } from "../lib/time";

const SALES_EXEC = "919943991034"; // Arjun, Sales Executive 1
const SERVICE_ENG = "919943991036"; // Karthik, Service Engineer 1
let n = 0;
const send = (phone: string, text?: string, buttonId?: string) =>
  handleIncoming({ phone, text, buttonId, waMessageId: `test-${Date.now()}-${n++}` });
const empId = async (phone: string) => (await one<{ id: number }>("select id from employees where phone = $1", [phone]))!.id;
const lastReply = async (phone: string) =>
  (await one<{ body: string }>("select body from messages where phone = $1 and direction = 'out' order by id desc limit 1", [phone]))!.body;

async function reset() {
  await query("delete from tasks");
  await query("delete from daily_reports");
  await query("delete from service_calls");
  await query("delete from messages");
}

before(reset);
after(async () => {
  await reset();
  await pool.end();
});

test("parses status commands", () => {
  assert.deepEqual(parseStatusCommand("2 done"), { seqs: [2], status: "done" });
  assert.deepEqual(parseStatusCommand("Done 1, 3"), { seqs: [1, 3], status: "done" });
  assert.deepEqual(parseStatusCommand("1 and 2 in progress"), { seqs: [1, 2], status: "in_progress" });
  assert.deepEqual(parseStatusCommand("3 not done"), { seqs: [3], status: "not_done" });
  assert.equal(parseStatusCommand("Visit ABC 2 times"), null);
  assert.equal(parseStatusCommand("close 12"), null);
  assert.deepEqual(parseStatusCommand("2 partial"), { seqs: [2], status: "partial" });
  assert.deepEqual(parseStatusCommand("2 partially done"), { seqs: [2], status: "partial" });
  assert.deepEqual(parseStatusCommand("3 not done - Customer not available"), { seqs: [3], status: "not_done", note: "Customer not available" });
  assert.deepEqual(parseStatusCommand("1 partially done because material came late"), { seqs: [1], status: "partial", note: "material came late" });
  assert.deepEqual(parseStatusCommand("4 done, sent by courier"), { seqs: [4], status: "done", note: "sent by courier" });
  assert.equal(parseStatusCommand("2 over budget"), null);
  assert.equal(parseStatusCommand("2 days delay in material"), null);
  assert.equal(parseStatusCommand("1 done\n2 Visit ABC"), null);
});

test("splits task lines and strips list markers", () => {
  assert.deepEqual(parseTaskLines("1. Visit ABC\n- Send quote\n\n• Follow up KLM  "), ["Visit ABC", "Send quote", "Follow up KLM"]);
});

test("first message of the day becomes the task list, then commands update it", async () => {
  await send(SALES_EXEC, "Visit ABC Industries for demo\nSend quotation to XYZ Ltd\nFollow up payment with KLM");
  const id = await empId(SALES_EXEC);
  let tasks = await todaysTasks(id);
  assert.equal(tasks.length, 3);
  assert.match(await lastReply(SALES_EXEC), /Saved 3 tasks/);

  await send(SALES_EXEC, "2 done");
  await send(SALES_EXEC, "add Call DEF Ltd");
  await send(SALES_EXEC, "1 in progress");
  tasks = await todaysTasks(id);
  assert.deepEqual(tasks.map((t) => [t.seq, t.status]), [[1, "in_progress"], [2, "done"], [3, "planned"], [4, "planned"]]);

  // Once the plan is in, unrecognised text is not silently added as tasks.
  await send(SALES_EXEC, "random words here");
  assert.match(await lastReply(SALES_EXEC), /didn't understand/);
  assert.equal((await todaysTasks(id)).length, 4);
});

test("evening buttons update tasks", async () => {
  const emp = { id: await empId(SALES_EXEC) };
  await send(SALES_EXEC, undefined, "eve:each");
  const buttons = await query<{ buttons: { id: string }[] }>(
    "select buttons from messages where phone = $1 and buttons is not null order by id", [SALES_EXEC]);
  assert.equal(buttons.length, 3); // tasks 1, 3, 4 are open
  await send(SALES_EXEC, undefined, buttons[0].buttons[0].id); // task 1 -> done
  const t1 = (await todaysTasks(emp.id)).find((t) => t.seq === 1)!;
  assert.equal(t1.status, "done");
  await send(SALES_EXEC, undefined, "eve:alldone");
  assert.ok((await todaysTasks(emp.id)).every((t) => t.status === "done"));
});

test("duplicate WhatsApp deliveries are handled once", async () => {
  await handleIncoming({ phone: SERVICE_ENG, text: "Check pump at Site A", waMessageId: "dup-1" });
  await handleIncoming({ phone: SERVICE_ENG, text: "Check pump at Site A", waMessageId: "dup-1" });
  const emp = { id: await empId(SERVICE_ENG) };
  assert.equal((await todaysTasks(emp.id)).length, 1);
});

test("service calls open and close", async () => {
  await send(SERVICE_ENG, "new call Sri Lakshmi Mills - compressor not starting");
  const call = (await one<{ id: number; status: string; complaint: string }>("select id, status, complaint from service_calls order by id desc limit 1"))!;
  assert.equal(call.status, "pending");
  assert.equal(call.complaint, "compressor not starting");
  await send(SERVICE_ENG, `close ${call.id} replaced valve`);
  const closed = (await one<{ status: string; notes: string }>("select status, notes from service_calls where id = $1", [call.id]))!;
  assert.deepEqual([closed.status, closed.notes], ["closed", "replaced valve"]);
});

test("unfinished tasks carry forward to the next report", async () => {
  const emp = { id: await empId(SERVICE_ENG) };
  const tomorrow = addDays(today(), 1);
  await ensureReport(emp.id, tomorrow);
  const carried = await query<{ description: string; carried_from: number | null }>(
    "select description, carried_from from tasks where employee_id = $1 and report_date = $2", [emp.id, tomorrow]);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].description, "Check pump at Site A");
  assert.ok(carried[0].carried_from);
  await query("delete from daily_reports where report_date = $1", [tomorrow]);
});

test("voice messages add tasks and run commands", async () => {
  const fake = (r: Partial<VoiceResult>) => ({
    downloadMedia: async () => ({ data: Buffer.from("ogg"), mimeType: "audio/ogg" }),
    interpretVoice: async (_a: Buffer, _m: string, tasks: { seq: number }[]) => {
      seen = tasks.length;
      return { heard: "", english: "", action: "unclear", tasks: [], command: "", ...r } as VoiceResult;
    },
  });
  let seen = -1;
  const say = (r: Partial<VoiceResult>) =>
    handleIncoming({ phone: SALES_EXEC, audio: { mediaId: "m" }, waMessageId: `voice-${n++}` }, fake(r));
  const id = await empId(SALES_EXEC);
  const before = (await todaysTasks(id)).length;

  await say({ heard: "ABC கம்பெனிக்கு போகணும், XYZ க்கு quotation அனுப்பணும்", english: "Go to ABC company, send quotation to XYZ", action: "tasks", tasks: ["Visit ABC company", "Send quotation to XYZ"] });
  assert.equal(seen, before); // the model is shown the current list
  const tasks = await todaysTasks(id);
  assert.deepEqual(tasks.slice(-2).map((t) => t.description), ["Visit ABC company", "Send quotation to XYZ"]);
  assert.match(await lastReply(SALES_EXEC), /Added 2 tasks/);
  const logged = (await one<{ kind: string; body: string }>("select kind, body from messages where phone = $1 and direction = 'in' order by id desc limit 1", [SALES_EXEC]))!;
  assert.equal(logged.kind, "voice");
  assert.match(logged.body, /கம்பெனி[\s\S]*→ Go to ABC/);

  const last = tasks.at(-1)!.seq;
  await say({ english: "finished the XYZ quotation", action: "command", command: `${last} done` });
  assert.equal((await todaysTasks(id)).at(-1)!.status, "done");

  await say({ english: "hello?", action: "unclear" });
  assert.match(await lastReply(SALES_EXEC), /couldn't find any tasks[\s\S]*hello\?/);

  await handleIncoming({ phone: SALES_EXEC, audio: { mediaId: "m" }, waMessageId: `voice-${n++}` }, {
    downloadMedia: async () => { throw new Error("network"); },
    interpretVoice: async () => { throw new Error("unreachable"); },
  });
  assert.match(await lastReply(SALES_EXEC), /couldn't listen/);

  // Without GEMINI_API_KEY the real service is off.
  await handleIncoming({ phone: SALES_EXEC, audio: { mediaId: "m" }, waMessageId: `voice-${n++}` });
  assert.match(await lastReply(SALES_EXEC), /aren't switched on/);
});

test("partly done and not done tasks ask for a reason note", async () => {
  await query("delete from tasks"); await query("delete from daily_reports");
  const id = await empId(SALES_EXEC);
  await send(SALES_EXEC, "Visit ABC\nSend quote to XYZ\nCall KLM");

  await send(SALES_EXEC, "1 partial");
  assert.match(await lastReply(SALES_EXEC), /Task 1 \(Visit ABC\) is only partly done\. What's the reason/);
  await send(SALES_EXEC, "Customer asked to come tomorrow");
  let tasks = await todaysTasks(id);
  assert.deepEqual([tasks[0].status, tasks[0].note], ["partial", "Customer asked to come tomorrow"]);
  assert.match(await lastReply(SALES_EXEC), /noted for task 1/);

  // A reason in the same message is saved straight away, with no question.
  await send(SALES_EXEC, "2 not done - price not approved");
  tasks = await todaysTasks(id);
  assert.deepEqual([tasks[1].status, tasks[1].note], ["not_done", "price not approved"]);
  assert.doesNotMatch(await lastReply(SALES_EXEC), /What's the reason/);
  assert.match(await lastReply(SALES_EXEC), /📝 _price not approved_/);

  // Evening buttons: "Partially done" then the reason.
  await send(SALES_EXEC, undefined, "eve:each");
  const btns = (await one<{ buttons: { id: string; title: string }[] }>(
    "select buttons from messages where phone = $1 and buttons is not null order by id desc limit 1", [SALES_EXEC]))!.buttons;
  assert.deepEqual(btns.map((b) => b.title), ["Done", "Partially done", "Not done"]);
  await send(SALES_EXEC, undefined, `task:${tasks[2].id}:not_done`);
  assert.match(await lastReply(SALES_EXEC), /Task 3 \(Call KLM\) wasn't done\. What's the reason/);
  await send(SALES_EXEC, "list");
  assert.match(await lastReply(SALES_EXEC), /Task 3 \(Call KLM\) wasn't done/); // still waiting
  await send(SALES_EXEC, "Phone switched off");
  assert.equal((await todaysTasks(id))[2].note, "Phone switched off");

  // Notes on any task, any time.
  await send(SALES_EXEC, "note 1 meeting fixed for 11 am");
  assert.equal((await todaysTasks(id))[0].note, "meeting fixed for 11 am");

  // Once nothing is waiting, free text is not taken as a note.
  await send(SALES_EXEC, "random words here");
  assert.match(await lastReply(SALES_EXEC), /didn't understand/);

  // Partly done tasks carry over as in progress, without yesterday's note.
  const tomorrow = addDays(today(), 1);
  await ensureReport(id, tomorrow);
  const carried = await query<{ seq: number; status: string; note: string | null }>(
    "select seq, status, note from tasks where employee_id = $1 and report_date = $2 order by seq", [id, tomorrow]);
  assert.deepEqual(carried, [{ seq: 1, status: "in_progress", note: null }, { seq: 2, status: "planned", note: null }, { seq: 3, status: "planned", note: null }]);
  await query("delete from daily_reports where report_date = $1", [tomorrow]);
});

test("paused departments get no prompts and the bot tells their staff", async () => {
  await query("update departments set active = false where name = 'Service'");
  try {
    await send(SERVICE_ENG, "hi");
    assert.match(await lastReply(SERVICE_ENG), /paused for your team/);
    await query("delete from daily_reports where report_date = $1", [today()]);
    await sendMorningPrompts();
    const prompted = await query<{ dept: string }>(
      `select distinct d.name as dept from daily_reports r join employees e on e.id = r.employee_id
         join departments d on d.id = e.department_id where r.report_date = $1 and r.prompted_at is not null`, [today()]);
    assert.ok(prompted.length > 0);
    assert.ok(!prompted.some((p) => p.dept === "Service"));
  } finally {
    await query("update departments set active = true");
  }
});

test("unknown numbers are told they are not registered", async () => {
  await send("919999999999", "hello");
  assert.match(await lastReply("919999999999"), /isn't registered/);
});
