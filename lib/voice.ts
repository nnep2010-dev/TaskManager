const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v23.0";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const MAX_BYTES = 10 * 1024 * 1024; // about 20 minutes of WhatsApp voice note

export const voiceEnabled = () => !!process.env.GEMINI_API_KEY;

export type VoiceResult = {
  /** What the person said, in the language they spoke. */
  heard: string;
  /** The same in English. */
  english: string;
  action: "tasks" | "command" | "unclear";
  tasks: string[];
  command: string;
};

/** Downloads a voice note from WhatsApp using its media id. */
export async function downloadMedia(mediaId: string) {
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`https://graph.facebook.com/${API_VERSION}/${mediaId}`, { headers: auth });
  const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number };
  if (!meta.ok || !info.url) throw new Error(`WhatsApp media lookup failed (${meta.status})`);
  if (info.file_size && info.file_size > MAX_BYTES) throw new Error("Voice message too long");
  const file = await fetch(info.url, { headers: auth });
  if (!file.ok) throw new Error(`WhatsApp media download failed (${file.status})`);
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error("Voice message too long");
  return { data, mimeType: info.mime_type ?? "audio/ogg" };
}

const COMMANDS = [
  "N done / N progress / N not done (several: 1, 3 done)",
  "all done",
  "remove N",
  "list",
  "none (no new tasks today)",
  "new call Customer - complaint",
  "close N notes",
  "calls",
  "help",
].join("\n");

function prompt(tasks: { seq: number; description: string; status: string }[]) {
  return `You read WhatsApp voice messages sent by staff of an engineering company in Tamil Nadu, India, to a daily task bot.
They may speak Tamil, English, or a mix of both.

Today's task list for this person:
${tasks.length ? tasks.map((t) => `${t.seq}. ${t.description} (${t.status})`).join("\n") : "(no tasks yet)"}

Decide what the message is:
- "tasks": they are telling you work they will do or are doing. Put each task in "tasks" as a short English line, like a person would type it (e.g. "Visit ABC Industries for demo"). Keep customer, company, place and product names exactly as spoken. Do not add tasks they did not say.
- "command": they are updating their list. Put the one matching command in "command", using a task number from the list above, e.g. "2 done" if they say they finished the second task or a task that matches number 2. Commands:
${COMMANDS}
- "unclear": silence, noise, or anything else.

Always fill "heard" with what they said in the language they spoke, and "english" with an English translation. Use "" or [] for fields that do not apply.`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    heard: { type: "STRING" },
    english: { type: "STRING" },
    action: { type: "STRING", enum: ["tasks", "command", "unclear"] },
    tasks: { type: "ARRAY", items: { type: "STRING" } },
    command: { type: "STRING" },
  },
  required: ["heard", "english", "action", "tasks", "command"],
};

/** Sends the audio to Gemini, which transcribes, translates and works out what the person wants. */
export async function interpretVoice(
  audio: Buffer,
  mimeType: string,
  tasks: { seq: number; description: string; status: string }[],
): Promise<VoiceResult> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt(tasks) },
            { inline_data: { mime_type: mimeType.split(";")[0].trim(), data: audio.toString("base64") } },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    error?: { message: string };
  };
  if (!res.ok) throw new Error(`Gemini failed: ${data.error?.message ?? res.status}`);
  const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  const r = JSON.parse(text) as Partial<VoiceResult>;
  return {
    heard: r.heard?.trim() ?? "",
    english: r.english?.trim() ?? "",
    action: r.action === "tasks" || r.action === "command" ? r.action : "unclear",
    tasks: (r.tasks ?? []).map((t) => t.trim()).filter(Boolean),
    command: r.command?.trim() ?? "",
  };
}

/** Turns the result into the text the person would have typed, or null if nothing usable was said. */
export function voiceToText(r: VoiceResult): string | null {
  if (r.action === "tasks" && r.tasks.length) return `add\n${r.tasks.join("\n")}`;
  if (r.action === "command" && r.command) return r.command;
  return null;
}
