/** A bounded observation contract. Its output alone is not trusted causal evidence. */
export const REPAIRABLE_WORKFLOW_CONTRACT = "REPAIRABLE_WORKFLOW_POLICY_V1" as const;

interface ContractCase {
  readonly id: string;
  readonly run: Readonly<Record<string, unknown>>;
  readonly expected: boolean;
}

const CASES: readonly ContractCase[] = Object.freeze([
  { id: "main-ci-failure", run: { name: "CI", conclusion: "failure", head_branch: "main", event: "push" }, expected: true },
  { id: "main-ci-timeout", run: { name: "CI", conclusion: "timed_out", head_branch: "main", event: "push" }, expected: true },
  { id: "cancelled", run: { name: "CI", conclusion: "cancelled", head_branch: "main", event: "push" }, expected: false },
  { id: "success", run: { name: "CI", conclusion: "success", head_branch: "main", event: "push" }, expected: false },
  { id: "feature-branch", run: { name: "CI", conclusion: "failure", head_branch: "feature", event: "push" }, expected: false },
  { id: "audit-workflow", run: { name: "Autopilot Deterministic Audit Release", conclusion: "failure", head_branch: "main", event: "push" }, expected: false },
  { id: "unknown-event", run: { name: "CI", conclusion: "failure", head_branch: "main", event: "repository_dispatch" }, expected: false },
]);

export type CausalContractObservation =
  | Readonly<{ contract: typeof REPAIRABLE_WORKFLOW_CONTRACT; status: "MATCH" }>
  | Readonly<{ contract: typeof REPAIRABLE_WORKFLOW_CONTRACT; status: "OBSERVED_MISMATCH"; caseId: string; expected: boolean; observed: boolean }>
  | Readonly<{ contract: typeof REPAIRABLE_WORKFLOW_CONTRACT; status: "INSUFFICIENT_EVIDENCE" }>;

/**
 * Executes a fixed finite truth table twice. The caller must supply the actual
 * target implementation in an isolated trusted producer. A mismatch does not
 * prove a GitHub run's failure was caused by this contract; that requires
 * independently authenticated source/run and receipt evidence.
 */
export function observeRepairableWorkflowContract(candidate: (run: Readonly<Record<string, unknown>>) => unknown): CausalContractObservation {
  try {
    if (typeof candidate !== "function") return Object.freeze({ contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "INSUFFICIENT_EVIDENCE" });
    let mismatch: CausalContractObservation | undefined;
    for (const item of CASES) {
      const first = candidate(Object.freeze({ ...item.run }));
      const second = candidate(Object.freeze({ ...item.run }));
      if (typeof first !== "boolean" || first !== second) return Object.freeze({ contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "INSUFFICIENT_EVIDENCE" });
      if (first !== item.expected && !mismatch) mismatch = Object.freeze({ contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "OBSERVED_MISMATCH", caseId: item.id, expected: item.expected, observed: first });
    }
    return mismatch ?? Object.freeze({ contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "MATCH" });
  } catch {
    return Object.freeze({ contract: REPAIRABLE_WORKFLOW_CONTRACT, status: "INSUFFICIENT_EVIDENCE" });
  }
}
