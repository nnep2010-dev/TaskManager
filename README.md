# Task Manager

Staff send their daily tasks to a company WhatsApp number. A bot saves them to a database organised by department, and the proprietor and department heads see everything on a web dashboard.

## What it does

- **Morning (9:30 IST, Mon–Sat):** the bot asks everyone for today's tasks. People reply one task per line.
- **11:00 IST:** one reminder to anyone who hasn't replied.
- **Evening (18:00 IST):** the bot lists each person's tasks with buttons: *All done* or *Update each task* (Done / In progress / Not done).
- Unfinished tasks carry over to the next day automatically.
- Service engineers log and close service calls from WhatsApp.
- **Dashboard:** home page with a tile per department (who reported, tasks done, who is missing), a page per department with a card per person, Service call numbers, each person's 30-day history, and CSV export for Excel.
- **Access:** the proprietor sees everything. Each department head sees only their department.
- **WhatsApp simulator** (proprietor only): test the whole bot in the browser before WhatsApp is connected.

## Staff guide (share this with your team)

| Send this | What happens |
| --- | --- |
| Your tasks, one per line | Saves today's task list |
| 🎤 A voice message (Tamil, English or mixed) | Adds the tasks you said, in English. You can also say things like "second task finished" |
| `add Visit XYZ Ltd` | Adds a task |
| `2 done` / `2 progress` / `2 not done` | Updates task 2 (several work too: `1, 3 done`) |
| `all done` | Marks every task done |
| `remove 2` | Deletes task 2 |
| `list` | Shows today's tasks |
| `none` | No new tasks today (just the carried-over ones) |
| `new call Customer - complaint` | Logs a service call and returns its number |
| `close 12 replaced valve` | Closes call 12 with a note |
| `calls` | Lists your pending calls |
| `help` | Shows all commands |

## Running it on your computer (test mode)

Needs Node.js 20+ and a Postgres database (a free Supabase project works).

```bash
npm install
cp .env.example .env.local      # then fill in DATABASE_URL, SESSION_SECRET and OWNER_PASSWORD
npm run db:setup                # creates tables, dummy staff and dashboard logins (prints the passwords)
npm run dev                     # open http://localhost:3000
```

Leave `WHATSAPP_TOKEN` empty and the app runs in test mode: open **WhatsApp simulator** from the top bar and send messages as any staff member.

`npm test` runs the bot tests against the database in `DATABASE_URL` (it clears task data, so use a test database).

## Going live

### 1. Database (Supabase)
1. Create a project at supabase.com (choose the Mumbai region).
2. Copy the connection string from **Connect > Transaction pooler** into `DATABASE_URL`, and set `DATABASE_SSL=true`.
3. Run `npm run db:setup` once from your computer with that `DATABASE_URL`.
   Or, without a local setup: run `npx tsx scripts/make-setup-sql.ts setup.sql`, paste `setup.sql` into Supabase **SQL Editor** and run it. It prints the dashboard passwords once.
4. After the first sign-in, change your password from your name in the top bar.

### 2. Hosting (Vercel)
1. Push this folder to a GitHub repository and import it at vercel.com.
2. Add every variable from `.env.example` in **Settings > Environment Variables**. Generate `SESSION_SECRET` and `CRON_SECRET` with `openssl rand -hex 32`.
3. The schedule in `vercel.json` runs the morning, reminder and evening jobs automatically.

### 3. WhatsApp (Meta Cloud API)
1. Get a new phone number that isn't already on WhatsApp.
2. At business.facebook.com create a Business Portfolio and start **business verification** (GST or incorporation certificate).
3. At developers.facebook.com create an app of type **Business**, add the **WhatsApp** product, and add your phone number. Set the display name.
4. Create a **System User** in Business Settings, give it the app and WhatsApp account, and generate a permanent token with `whatsapp_business_messaging` and `whatsapp_business_management`. Put it in `WHATSAPP_TOKEN`.
5. Copy the **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID` and the app's **App secret** (App settings > Basic) into `WHATSAPP_APP_SECRET`.
6. In **WhatsApp > Configuration**, set the callback URL to `https://<your-vercel-domain>/api/whatsapp`, the verify token to your `WHATSAPP_VERIFY_TOKEN`, and subscribe to the **messages** field.
7. Add a payment method in WhatsApp Manager.
8. Create these **Utility** templates in WhatsApp Manager, language English, and wait for approval:

| Template name | Body |
| --- | --- |
| `daily_tasks_morning` | Good morning {{1}}. What are your tasks for today? Reply with one task per line. |
| `daily_tasks_reminder` | Hi {{1}}, a reminder to send today's tasks. Reply with one task per line. |
| `daily_tasks_evening` | Hi {{1}}, time to update today's tasks. Reply to this message to see your list. |

Templates are only used when someone hasn't messaged the bot in the last 24 hours (a WhatsApp rule). Otherwise the bot sends normal messages and buttons.

Before verification finishes you can use Meta's free test number and add up to 5 recipient numbers (e.g. the three test numbers) in the API Setup page.

### 4. Voice messages (optional)
1. Sign in at aistudio.google.com with a Google account and click **Get API key > Create API key**.
2. Add it in Vercel as `GEMINI_API_KEY` and redeploy. Voice notes are then transcribed by Google Gemini, translated to English and saved as tasks.
3. To keep the free tier's data out of Google's training, turn on billing for the key's project (cost is well under ₹1 per voice note).

## Adding real staff

Staff live in the `employees` table (Supabase **Table Editor** works well):

- `phone`: country code + number, no `+` or spaces, e.g. `919943991030`
- `department_id`, `role`, `reports_to` (the manager's employee id), `is_head` (true for department heads)
- Set `active` to false when someone leaves.

`db/seed.sql` holds the current dummy staff. The three test numbers are Neha Sharma (Sales Manager, …030), Arjun Patel (Sales Executive 1, …034) and Karthik Reddy (Service Engineer 1, …036). To start fresh with real staff, run `npm run db:setup -- --no-seed` on an empty database and add people in the Table Editor. After adding a new department head, run `npm run db:setup` again to create their login.

## How it's built

- Next.js (App Router, TypeScript) for the dashboard, the WhatsApp webhook (`app/api/whatsapp`) and the scheduled jobs (`app/api/cron/[job]`)
- PostgreSQL via `pg`; schema in `db/schema.sql`
- Bot logic in `lib/bot.ts`, WhatsApp sending in `lib/whatsapp.ts`, voice messages in `lib/voice.ts`
- Every message in and out is stored in the `messages` table
