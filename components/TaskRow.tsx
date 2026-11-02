import { StatusPill } from "@/components/DateBar";
import type { PersonDay } from "@/lib/dashboard";

/** One task in a list: number, description, its note (or a warning when a reason is missing), and status. */
export function TaskRow({ task }: { task: PersonDay["tasks"][number] }) {
  const needsReason = (task.status === "partial" || task.status === "not_done") && !task.note;
  return (
    <li>
      <span>
        {task.seq}. {task.description}
        {task.carried && <span className="carried"> · carried over</span>}
        {task.note && <span className="task-note">📝 {task.note}</span>}
        {needsReason && <span className="task-note missing">No reason given yet</span>}
      </span>
      <StatusPill status={task.status} />
    </li>
  );
}
