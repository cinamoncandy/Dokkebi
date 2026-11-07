/**
 * Which failed GitHub Actions runs the scheduled Autopilot may treat as repair targets.
 *
 * Only named code checks that ran on main from a push or a manual run qualify (the same origins the
 * canonical CI lookup accepts). A failure of a control-plane workflow (Codex coding, the execution
 * consumer, the event bridge, Audit/Release, deploy) or of a runtime evidence workflow is not a code
 * defect a bounded patch can fix;
 * treating it as one re-dispatched the same repair about every five minutes for up to a day
 * (2026-10-12: one Codex coding failure was re-dispatched eleven times). This predicate only
 * narrows the input; it grants no authority.
 */
export const REPAIRABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set(["CI", "Autopilot Sandbox New-File Guard"]);

const REPAIRABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);
const REPAIRABLE_EVENTS: ReadonlySet<string> = new Set(["push", "workflow_dispatch"]);

export function isRepairableMainWorkflowFailure(run: Readonly<Record<string, unknown>>): boolean {
  return typeof run.conclusion === "string" && REPAIRABLE_CONCLUSIONS.has(run.conclusion)
    && run.head_branch === "main"
    && typeof run.event === "string" && REPAIRABLE_EVENTS.has(run.event)
    && typeof run.name === "string" && REPAIRABLE_WORKFLOW_NAMES.has(run.name.trim());
}
