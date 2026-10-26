import { createHmac, timingSafeEqual } from "node:crypto";
import { one, query } from "./db";

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v23.0";
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG ?? "en";

/** Without a token the bot runs in dry-run mode: replies are only written to the messages table. */
export const dryRun = !TOKEN || !PHONE_NUMBER_ID;

export type Button = { id: string; title: string };

type Outgoing =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; buttons: Button[] }
  | { kind: "template"; name: string; params: string[]; preview: string };

async function send(phone: string, employeeId: number | null, msg: Outgoing) {
  let payload: Record<string, unknown>;
  if (msg.kind === "text") {
    payload = { type: "text", text: { body: msg.text, preview_url: false } };
  } else if (msg.kind === "buttons") {
    payload = {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: msg.text.slice(0, 1024) },
        action: {
          buttons: msg.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    };
  } else {
    payload = {
      type: "template",
      template: {
        name: msg.name,
        language: { code: TEMPLATE_LANG },
        components: msg.params.length
          ? [{ type: "body", parameters: msg.params.map((t) => ({ type: "text", text: t })) }]
          : [],
      },
    };
  }

  const logBody = msg.kind === "template" ? msg.preview : msg.text;

  let status = "dry_run";
  let waId: string | null = null;
  if (!dryRun) {
    const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, ...payload }),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } };
    if (res.ok) {
      status = "sent";
      waId = data.messages?.[0]?.id ?? null;
    } else {
      status = "failed";
      console.error("WhatsApp send failed", phone, data.error?.message ?? res.status);
    }
  }

  await query(
    `insert into messages (employee_id, phone, direction, kind, body, wa_message_id, status, buttons)
     values ($1, $2, 'out', $3, $4, $5, $6, $7)`,
    [employeeId, phone, msg.kind, logBody, waId, status, msg.kind === "buttons" ? JSON.stringify(msg.buttons) : null],
  );
}

export const sendText = (phone: string, employeeId: number | null, text: string) =>
  send(phone, employeeId, { kind: "text", text });

export const sendButtons = (phone: string, employeeId: number | null, text: string, buttons: Button[]) =>
  send(phone, employeeId, { kind: "buttons", text, buttons });

export const sendTemplate = (phone: string, employeeId: number | null, name: string, params: string[], preview: string) =>
  send(phone, employeeId, { kind: "template", name, params, preview });

/**
 * WhatsApp only allows free-form messages within 24 hours of the person's last message.
 * Outside that window the bot must use an approved template.
 */
export async function windowOpen(phone: string): Promise<boolean> {
  const row = await one<{ open: boolean }>(
    `select exists (
       select 1 from messages where phone = $1 and direction = 'in' and created_at > now() - interval '23 hours 50 minutes'
     ) as open`,
    [phone],
  );
  return !!row?.open;
}

/** Checks Meta's X-Hub-Signature-256 header against the raw request body. */
export function validSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // not configured (local testing)
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header.slice(7), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
