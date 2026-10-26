export const metadata = { title: "Privacy policy · Task Manager" };

export default function PrivacyPage() {
  return (
    <article className="card" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1>Privacy policy</h1>
      <p className="sub">Task Manager internal WhatsApp bot</p>
      <p>
        This WhatsApp number is used only by our own employees to send daily work updates. We store the messages
        employees send to it, their name, phone number, department and role, and the tasks and service calls they report.
      </p>
      <p>
        This information is used only to track daily work inside the company. It is visible to the proprietor and to
        each employee&apos;s department head. It is not sold or shared with anyone else, and it is not used for marketing.
      </p>
      <p>
        Data is stored on our database provider (Supabase) and hosting provider (Vercel), and messages are delivered
        through the WhatsApp Business Platform operated by Meta.
      </p>
      <p>
        Employees can ask the company admin to see, correct or delete their data at any time. When an employee leaves,
        their number is deactivated and stops receiving messages.
      </p>
    </article>
  );
}
