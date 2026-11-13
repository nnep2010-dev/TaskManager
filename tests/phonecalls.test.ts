import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { handleIncoming } from "../lib/bot";
import { one, pool, query } from "../lib/db";
import { logPhoneCall, normalizePhone } from "../lib/phonecalls";
import { POST } from "../app/api/calls/route";

const SERVICE_ENG = "919943991036";
let n = 0;
const send = (phone: string, text: string) => handleIncoming({ phone, text, waMessageId: `pc-${Date.now()}-${n++}` });
const lastReply = async (phone: string) =>
  (await one<{ body: string }>("select body from messages where phone = $1 and direction = 'out' order by id desc limit 1", [phone]))!.body;

before(async () => { await query("delete from service_calls"); await query("delete from messages"); });
after(async () => { await query("delete from service_calls"); await query("delete from messages"); await pool.end(); });

test("normalizes Indian numbers", () => {
  for (const raw of ["+91 98765 43210", "09876543210", "9876543210", "0091-98765-43210"]) assert.equal(normalizePhone(raw), "919876543210");
});

test("logs a customer call to the Service head, once while pending", async () => {
  const r = await logPhoneCall({ number: "+91 98765 43210", name: "ABC Ltd", type: "Incoming" });
  assert.equal(r.logged, true);
  const c = await one<{ customer: string; source: string; caller_phone: string; dept: string; is_head: boolean }>(
    `select c.customer, c.source, c.caller_phone, d.name as dept, e.is_head from service_calls c
       join employees e on e.id = c.engineer_id join departments d on d.id = e.department_id where c.id = $1`,
    [(r as { id: number }).id],
  );
  assert.equal(c!.customer, "ABC Ltd");
  assert.equal(c!.source, "phone");
  assert.equal(c!.caller_phone, "919876543210");
  assert.match(c!.dept, /service/i);
  assert.equal(c!.is_head, true); // the dummy seed has no "Service Manager" role, so it falls back to the head
  const id = (r as { id: number }).id;
  assert.deepEqual(await logPhoneCall({ number: "9876543210", name: "ABC Ltd" }), { logged: false, reason: "repeat", id, calls: 2 });
  assert.deepEqual(await logPhoneCall({ number: "09876543210" }), { logged: false, reason: "repeat", id, calls: 3 });
  assert.equal((await query("select 1 from service_calls where caller_phone = '919876543210'")).length, 1);
});

test("skips staff and fills unknown callers with the number", async () => {
  assert.deepEqual(await logPhoneCall({ number: SERVICE_ENG }), { logged: false, reason: "staff" });
  const r = await logPhoneCall({ number: "9123456780", name: "[call_name]", type: "missed" });
  const c = await one<{ customer: string; complaint: string }>("select customer, complaint from service_calls where id = $1", [(r as { id: number }).id]);
  assert.equal(c!.customer, "+919123456780");
  assert.match(c!.complaint, /missed/i);
});

test("engineer fills in details and closes an auto-logged call", async () => {
  const id = (await one<{ id: number }>("select id from service_calls where caller_phone = '919123456780'"))!.id;
  await send(SERVICE_ENG, `call #${id} XYZ Mills - pump leaking`);
  assert.match(await lastReply(SERVICE_ENG), /updated: XYZ Mills – pump leaking/);
  const c = await one<{ customer: string; complaint: string }>("select customer, complaint from service_calls where id = $1", [id]);
  assert.deepEqual(c, { customer: "XYZ Mills", complaint: "pump leaking" });
  await send(SERVICE_ENG, `close ${id} seal replaced`);
  assert.match(await lastReply(SERVICE_ENG), /closed/);
  assert.equal((await logPhoneCall({ number: "9123456780" })).logged, true); // a new call after closing is logged again
});

test("the link needs the key and accepts form or JSON bodies", async () => {
  process.env.CALL_LOG_KEY = "secret123";
  const bad = await POST(new Request("http://x/api/calls?key=wrong", { method: "POST", body: "number=9000000001" }));
  assert.equal(bad.status, 401);
  const form = await POST(new Request("http://x/api/calls?key=secret123", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "number=9000000001&name=Ravi&type=incoming",
  }));
  assert.equal((await form.json()).logged, true);
  const json = await POST(new Request("http://x/api/calls?key=secret123", { method: "POST", body: JSON.stringify({ number: "9000000002" }) }));
  assert.equal((await json.json()).logged, true);
});

test("new calls go to the Service Manager when there is one", async () => {
  const m = await one<{ id: number }>(
    `insert into employees (name, phone, department_id, role) values ('Test Manager', '910000009999',
      (select id from departments where name = 'Service'), 'Service Manager') returning id`,
  );
  try {
    const r = await logPhoneCall({ number: "9555500000" });
    const c = await one<{ engineer_id: number }>("select engineer_id from service_calls where id = $1", [(r as { id: number }).id]);
    assert.equal(c!.engineer_id, m!.id);
  } finally {
    await query("delete from service_calls where engineer_id = $1", [m!.id]);
    await query("delete from employees where id = $1", [m!.id]);
  }
});

test("dashboard edits: close stamps the time, reopen clears it, engineer stays in the department", async () => {
  const { saveCall, callDetail } = await import("../lib/calls");
  const r = await logPhoneCall({ number: "9444400000" });
  const id = (r as { id: number }).id;
  const call = (await callDetail(id))!;
  const sales = (await one<{ id: number }>("select id from employees where phone = '919943991034'"))!.id;
  await saveCall(id, call.department_id!, { customer: "Ravi Textiles", complaint: "Pump noise", engineerId: sales, status: "closed", notes: "Bearing changed" });
  let c = (await callDetail(id))!;
  assert.equal(c.customer, "Ravi Textiles");
  assert.equal(c.status, "closed");
  assert.ok(c.closed_at);
  assert.equal(c.engineer_id, call.engineer_id); // a Sales person can't be put on a Service call
  const eng = (await one<{ id: number }>("select id from employees where phone = $1", [SERVICE_ENG]))!.id;
  await saveCall(id, call.department_id!, { customer: "Ravi Textiles", complaint: null, engineerId: eng, status: "pending", notes: null });
  c = (await callDetail(id))!;
  assert.equal(c.status, "pending");
  assert.equal(c.closed_at, null);
  assert.equal(c.engineer_id, eng);
});

// ---- Daily call numbers (13 Nov 2026) ----

const addCall = async (customer: string, openedAt: string, closedAt: string | null = null) =>
  (await one<{ id: number; call_date: string; day_no: number }>(
    `insert into service_calls (customer, engineer_id, opened_at, status, closed_at)
     values ($1, (select id from employees where phone = $2), $3, $5, $4) returning id, call_date, day_no`,
    [customer, SERVICE_ENG, openedAt, closedAt, closedAt ? "closed" : "pending"],
  ))!;
const serviceDept = async () => (await one<{ id: number }>("select id from departments where name = 'Service'"))!.id;

test("calls are numbered from 1 each day by the IST date they came in", async () => {
  const a = await addCall("Day A first", "2025-01-10T09:15:00+05:30");
  const b = await addCall("Day A second", "2025-01-10T23:50:00+05:30");
  const c = await addCall("Day B first", "2025-01-11T00:10:00+05:30"); // 18:40 UTC on the 10th, but the 11th in India
  assert.deepEqual([a.call_date, a.day_no], ["2025-01-10", 1]);
  assert.deepEqual([b.call_date, b.day_no], ["2025-01-10", 2]);
  assert.deepEqual([c.call_date, c.day_no], ["2025-01-11", 1]);
  await query("delete from service_calls where call_date in ('2025-01-10', '2025-01-11')");
});

test("calls arriving at the same moment still get different numbers", async () => {
  await query("delete from service_calls where call_date = (now() at time zone 'Asia/Kolkata')::date");
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => logPhoneCall({ number: `977700000${i}` })));
  const ids = results.map((r) => (r as { id: number }).id);
  const rows = await query<{ day_no: number }>("select day_no from service_calls where id = any($1) order by day_no", [ids]);
  assert.deepEqual(rows.map((r) => r.day_no), [1, 2, 3, 4, 5, 6]);
});

test("day counts, carried over calls and calls by hour", async () => {
  const { serviceStats, callsForDay, callsByHour, callExportRows } = await import("../lib/dashboard");
  const dept = await serviceDept();
  // 10 Jan: A closed next day, B still pending, C closed the same day. 11 Jan: D and E (E closed).
  await addCall("A", "2025-01-10T10:05:00+05:30", "2025-01-11T12:00:00+05:30");
  const B = await addCall("B", "2025-01-10T10:40:00+05:30");
  await addCall("C", "2025-01-10T15:20:00+05:30", "2025-01-10T17:00:00+05:30");
  await addCall("D", "2025-01-11T10:30:00+05:30");
  await addCall("E", "2025-01-11T16:45:00+05:30", "2025-01-11T18:00:00+05:30");
  try {
    assert.deepEqual(await serviceStats(dept, "2025-01-10"), { received: 3, carried: 0, closed: 1, pending: 2 });
    assert.deepEqual(await serviceStats(dept, "2025-01-11"), { received: 2, carried: 2, closed: 2, pending: 2 });
    assert.deepEqual(await serviceStats(dept, "2025-01-12"), { received: 0, carried: 2, closed: 0, pending: 2 });

    const day2 = await callsForDay(dept, "2025-01-11");
    assert.deepEqual(day2.received.map((c) => [c.customer, c.day_no]), [["D", 1], ["E", 2]]);
    assert.deepEqual(day2.carried.map((c) => [c.customer, c.call_date, c.day_no]), [["A", "2025-01-10", 1], ["B", "2025-01-10", 2]]);
    const day3 = await callsForDay(dept, "2025-01-12");
    assert.deepEqual(day3.carried.map((c) => c.id).sort((x, y) => x - y), [B.id, (await one<{ id: number }>("select id from service_calls where customer = 'D' and call_date = '2025-01-11'"))!.id].sort((x, y) => x - y)); // A and E were closed on the 11th

    const hours = await callsByHour(dept, "2025-01-11", 2);
    const at = (h: number) => hours.find((x) => x.hour === h)!;
    assert.equal(hours[0].hour, 9); // from 9 am to 6 pm at least
    assert.equal(hours.at(-1)!.hour, 18);
    assert.deepEqual(at(10), { hour: 10, calls: 3, on_day: 1 });
    assert.deepEqual(at(15), { hour: 15, calls: 1, on_day: 0 });
    assert.deepEqual(at(16), { hour: 16, calls: 1, on_day: 1 });
    assert.deepEqual(at(12), { hour: 12, calls: 0, on_day: 0 });

    const csv = await callExportRows(dept, "2025-01-11");
    assert.deepEqual(csv.map((r) => [r.customer, r.carried]), [["A", true], ["B", true], ["D", false], ["E", false]]);
  } finally {
    await query("delete from service_calls where call_date between '2025-01-10' and '2025-01-12'");
  }
});

test("hour chart widens for early and late calls", async () => {
  const { hourBuckets } = await import("../lib/dashboard");
  const b = hourBuckets([{ hour: 7, calls: 2, on_day: 1 }, { hour: 20, calls: 1, on_day: 0 }]);
  assert.equal(b[0].hour, 7);
  assert.equal(b.at(-1)!.hour, 20);
  assert.equal(b.length, 14);
  assert.equal(hourBuckets([]).length, 10);
});

test("labels: today's calls show #N, older ones show their date", async () => {
  const { callLabel } = await import("../lib/time");
  assert.equal(callLabel("2026-11-13", 3, "2026-11-13"), "#3");
  assert.equal(callLabel("2026-11-12", 7, "2026-11-13"), "12 Nov #7");
});

test("WhatsApp shows the day's call number and keeps close working by the call #", async () => {
  await query("delete from service_calls where engineer_id = (select id from employees where phone = $1)", [SERVICE_ENG]);
  const old = await addCall("Old Mills", "2025-01-10T11:00:00+05:30");
  await send(SERVICE_ENG, "new call Sri Ram Traders - motor noise");
  const reply = await lastReply(SERVICE_ENG);
  const m = reply.match(/Call \*#(\d+)\* logged for Sri Ram Traders \(today's call no\. (\d+)\)/);
  assert.ok(m, reply);
  const id = Number(m![1]);
  const row = await one<{ day_no: number }>("select day_no from service_calls where id = $1", [id]);
  assert.equal(Number(m![2]), row!.day_no);

  await send(SERVICE_ENG, "calls");
  const list = await lastReply(SERVICE_ENG);
  assert.match(list, new RegExp(`#${old.id} Old Mills\\n   _10 Jan call 1, 11:00 am_`));
  assert.match(list, new RegExp(`#${id} Sri Ram Traders – motor noise\\n   _Today call ${row!.day_no}, `));
  assert.ok(list.indexOf("Old Mills") < list.indexOf("Sri Ram"), "carried over calls come first");

  await send(SERVICE_ENG, `close ${id} fixed`);
  assert.match(await lastReply(SERVICE_ENG), /Call #\d+ \(Sri Ram Traders\) closed/);
  await query("delete from service_calls where id = $1", [old.id]);
});
