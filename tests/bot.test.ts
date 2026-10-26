import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensureReport, handleIncoming, parseStatusCommand, parseTaskLines, todaysTasks } from "../lib/bot";
import { one, pool, query } from "../lib/db";
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

test("unknown numbers are told they are not registered", async () => {
  await send("919999999999", "hello");
  assert.match(await lastReply("919999999999"), /isn't registered/);
});
