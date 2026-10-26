import { NextResponse } from "next/server";
import { sendEveningPrompts, sendMorningPrompts, sendNudges } from "@/lib/bot";

const JOBS = { morning: sendMorningPrompts, nudge: sendNudges, evening: sendEveningPrompts } as const;

// Vercel Cron calls these with "Authorization: Bearer <CRON_SECRET>".
export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { job } = await ctx.params;
  const run = JOBS[job as keyof typeof JOBS];
  if (!run) return new Response("Unknown job", { status: 404 });
  const sent = await run();
  return NextResponse.json({ job, sent });
}
