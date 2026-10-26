import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { handleIncoming, sendEveningPrompts, sendMorningPrompts, sendNudges } from "@/lib/bot";
import { currentUser, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatTime } from "@/lib/time";
import { dryRun, type Button } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

async function assertProprietor() {
  const user = await currentUser();
  if (user?.access !== "proprietor") throw new Error("Not allowed");
}

async function sendAs(formData: FormData) {
  "use server";
  await assertProprietor();
  const phone = String(formData.get("phone"));
  // A tapped button arrives as "id|title", like WhatsApp sends both.
  const [buttonId, buttonTitle] = formData.get("button") ? String(formData.get("button")).split("|") : [];
  const text = buttonTitle ?? (formData.get("text") ? String(formData.get("text")) : undefined);
  if (text?.trim() || buttonId) await handleIncoming({ phone, text, buttonId, waMessageId: `sim-${randomUUID()}` });
  redirect(`/simulator?phone=${phone}`);
}

async function runJob(formData: FormData) {
  "use server";
  await assertProprietor();
  const job = String(formData.get("job"));
  if (job === "morning") await sendMorningPrompts();
  if (job === "nudge") await sendNudges();
  if (job === "evening") await sendEveningPrompts();
  redirect(`/simulator?phone=${formData.get("phone")}`);
}

export default async function Simulator({ searchParams }: { searchParams: Promise<{ phone?: string }> }) {
  const user = await requireUser();
  if (user.access !== "proprietor") notFound();
  const staff = await query<{ name: string; role: string; phone: string; department: string }>(
    `select e.name, e.role, e.phone, d.name as department from employees e join departments d on d.id = e.department_id
      where e.active and e.phone is not null order by d.sort_order, e.is_head desc, e.name`,
  );
  const phone = (await searchParams).phone ?? staff[0]?.phone;
  const person = staff.find((s) => s.phone === phone);
  const log = await query<{ id: number; direction: "in" | "out"; body: string; kind: string; buttons: Button[] | null; created_at: Date; status: string | null }>(
    `select * from (select id, direction, body, kind, buttons, created_at, status from messages where phone = $1 order by id desc limit 60) m order by id`,
    [phone],
  );

  return (
    <>
      <h1>WhatsApp simulator</h1>
      <p className="sub">Send messages as any staff member to test the bot without WhatsApp.</p>
      {dryRun ? (
        <div className="notice">Test mode: WhatsApp isn&apos;t connected, so replies only appear here.</div>
      ) : (
        <div className="notice">WhatsApp is connected: bot replies here are also sent to the real phone number.</div>
      )}
      <div className="bar">
        <form className="inline" method="get">
          <select name="phone" defaultValue={phone}>
            {staff.map((s) => (
              <option key={s.phone} value={s.phone}>{s.name} · {s.role} · +{s.phone}</option>
            ))}
          </select>
          <button type="submit" className="secondary">Switch</button>
        </form>
        <form className="inline" action={runJob}>
          <input type="hidden" name="phone" value={phone} />
          <span className="sub" style={{ margin: 0 }}>Run for everyone now:</span>
          <button name="job" value="morning" className="secondary">Morning prompt</button>
          <button name="job" value="nudge" className="secondary">Reminder</button>
          <button name="job" value="evening" className="secondary">Evening check</button>
        </form>
      </div>
      {person && <h2 style={{ marginTop: 0 }}>{person.name} ({person.department})</h2>}
      <div className="chat">
        {log.length === 0 && <p className="empty">No messages yet. Try sending “hi”.</p>}
        {log.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            {m.body}
            {m.buttons && (
              <form action={sendAs} className="btns">
                <input type="hidden" name="phone" value={phone} />
                {m.buttons.map((b) => (
                  <button key={b.id} name="button" value={`${b.id}|${b.title}`}>{b.title}</button>
                ))}
              </form>
            )}
            <span className="meta">
              {formatTime(m.created_at)}
              {m.kind === "template" ? " · template" : ""}
              {m.status === "failed" ? " · failed to send" : ""}
            </span>
          </div>
        ))}
      </div>
      <form action={sendAs} style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input type="hidden" name="phone" value={phone} />
        <textarea name="text" rows={3} style={{ flex: 1 }} placeholder={"Type as this person, e.g.\nVisit ABC Industries\nSend quotation to XYZ"} />
        <button type="submit">Send</button>
      </form>
    </>
  );
}
