import { NextResponse } from "next/server";
import { logPhoneCall } from "@/lib/phonecalls";

// MacroDroid on the service phone calls this after every call:
//   POST /api/calls?key=<CALL_LOG_KEY>   body: number=...&name=...&type=incoming|missed
// The values can also be sent as JSON or in the query string.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const key = process.env.CALL_LOG_KEY;
  const given = url.searchParams.get("key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key || given !== key) return new Response("Unauthorized", { status: 401 });

  const fields: Record<string, string> = Object.fromEntries(url.searchParams);
  const raw = await req.text();
  if (raw.trim()) {
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === "object") for (const [k, v] of Object.entries(json)) fields[k] = String(v ?? "");
    } catch {
      for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;
    }
  }

  const result = await logPhoneCall({ number: fields.number ?? fields.phone ?? "", name: fields.name, type: fields.type });
  return NextResponse.json(result);
}

export const GET = POST;
