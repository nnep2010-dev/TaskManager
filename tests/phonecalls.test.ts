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
