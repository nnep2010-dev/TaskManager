import { NextResponse, after } from "next/server";
import { handleIncoming } from "@/lib/bot";
import { validSignature } from "@/lib/whatsapp";

// Meta calls this once when you register the webhook URL.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

type WaMessage = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload: string; text: string };
};

export async function POST(req: Request) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const messages = (body.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);

  // Reply to Meta straight away; process after the response so WhatsApp doesn't retry.
  after(async () => {
    for (const m of messages) {
      try {
        await handleIncoming({
          phone: m.from,
          waMessageId: m.id,
          text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title,
          buttonId: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id,
        });
      } catch (err) {
        console.error("Failed to handle WhatsApp message", m.id, err);
      }
    }
  });

  return NextResponse.json({ ok: true });
}
