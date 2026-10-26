import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Task Manager", description: "Daily task updates from WhatsApp" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        {user && (
          <header className="top">
            <Link href="/" className="brand">Task Manager</Link>
            <nav>
              {user.access === "proprietor" && <Link href="/simulator">WhatsApp simulator</Link>}
              <Link href="/account">{user.display_name}</Link>
              <form action="/logout" method="post">
                <button className="link" type="submit">Log out</button>
              </form>
            </nav>
          </header>
        )}
        <main>{children}</main>
      </body>
    </html>
  );
}
