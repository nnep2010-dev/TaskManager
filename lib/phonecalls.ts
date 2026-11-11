import { one } from "./db";

/** "+91 99439 91015", "09943991015" and "9943991015" all become "919943991015". */
export function normalizePhone(raw: string) {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d;
}

export type PhoneCallInput = { number: string; name?: string | null; type?: string | null };
export type PhoneCallResult =
  | { logged: true; id: number }
  | { logged: false; reason: "repeat"; id: number; calls: number }
  | { logged: false; reason: "no_number" | "staff" | "no_assignee" };

/** A contact name from the phone, unless the phone only knows the number. */
function cleanName(name: string | null | undefined, phone: string) {
  const n = (name ?? "").trim();
  if (!n || /^[\d\s+()-]*$/.test(n) || /^(unknown|private|null|undefined|\[.*\]|\{.*\})$/i.test(n)) return null;
  return n.slice(0, 200) || phone;
}

/**
 * Logs a call that rang the service phone (sent by MacroDroid on the phone after each call).
 * Staff numbers are skipped. A number that already has a pending call isn't logged again; its
 * call counter goes up instead. Once that call is closed, the next call from the number opens a new one.
 * New calls go to CALL_LOG_ASSIGN_TO (a staff WhatsApp number), else the Service Manager, else the Service head.
 */
export async function logPhoneCall(input: PhoneCallInput): Promise<PhoneCallResult> {
  const phone = normalizePhone(input.number);
  if (phone.length < 8) return { logged: false, reason: "no_number" };

  const staff = await one("select 1 from employees where phone = $1", [phone]);
  if (staff) return { logged: false, reason: "staff" };

  const repeat = await one<{ id: number; call_count: number }>(
    `update service_calls set call_count = call_count + 1, last_call_at = now()
      where id = (select id from service_calls where caller_phone = $1 and status = 'pending' order by id desc limit 1)
      returning id, call_count`,
    [phone],
  );
  if (repeat) return { logged: false, reason: "repeat", id: repeat.id, calls: repeat.call_count };

  const assignTo = process.env.CALL_LOG_ASSIGN_TO ? normalizePhone(process.env.CALL_LOG_ASSIGN_TO) : null;
  const engineer = assignTo
    ? await one<{ id: number }>("select id from employees where phone = $1 and active", [assignTo])
    : await one<{ id: number }>(
        `select e.id from employees e join departments d on d.id = e.department_id
          where d.name ilike 'service%' and e.active
          order by (e.role ilike '%service manager%') desc, e.is_head desc, e.id limit 1`,
      );
  if (!engineer) return { logged: false, reason: "no_assignee" };

  const type = /miss/i.test(input.type ?? "") ? "missed" : /out/i.test(input.type ?? "") ? "outgoing" : "incoming";
  const customer = cleanName(input.name, phone) ?? `+${phone}`;
  const row = await one<{ id: number }>(
    `insert into service_calls (customer, complaint, engineer_id, caller_phone, source, last_call_at)
     values ($1, $2, $3, $4, 'phone', now()) returning id`,
    [customer, type === "missed" ? "Missed call – call back" : null, engineer.id, phone],
  );
  return { logged: true, id: row!.id };
}
