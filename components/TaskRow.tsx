import { StatusPill } from "@/components/DateBar";
import type { PersonDay } from "@/lib/dashboard";
import { formatStamp } from "@/lib/time";

/**
 * One task in a list: number, description, when it was added and finished (IST),
 * its note (or a warning when a reason is missing), and status.
 * `date` is the day the list is for, so times on another day also show the date.
 */
export function TaskRow({ task, date }: { task: PersonDay["tasks"][number]; date: string }) {
  const needsReason = (task.status === "partial" || task.status === "not_done") && !task.note;
  const finished = task.completed_at ? `${task.status === "partial" ? "Partly done" : "Done"} ${formatStamp(task.completed_at, date)}` : "";
  return (
    <li>
      <span>
        {task.seq}. {task.description}
        {task.carried && <span className="carried"> · carried over</span>}
        {task.added_at && (
          <span className="task-times">
            Added {formatStamp(task.added_at, date)}
            {finished && <> · {finished}</>}
          </span>
        )}
        {task.note && <span className="task-note">📝 {task.note}</span>}
        {needsReason && <span className="task-note missing">No reason given yet</span>}
      </span>
      <StatusPill status={task.status} />
    </li>
  );
}
