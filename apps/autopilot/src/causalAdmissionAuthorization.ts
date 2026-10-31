import { hashCausalDispatchCapability, newCausalDispatchCapability } from "./causalDispatchBinding";
import { claimRegisteredCausalDispatch, registerCausalDispatchBinding, verifyRegisteredCausalDispatch, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { verifyGithubCodingPublisherIdentity, verifyGithubCodingPublisherRun, verifyGithubCodingSourceRun, type SourceExecutionIdentity } from "./githubActionsOidc";
import { executeGithubDispatch, type GithubExecutorResult } from "./githubExecutor";
import type { AutopilotExecutionRequest } from "./executionPlanner";

type GithubFetch = NonNullable<Parameters<typeof verifyGithubCodingPublisherIdentity>[2]>;

export interface CausalDispatchContext {
  readonly coordinator: ExecutionCoordinatorNamespace;
  readonly allowedRepository: string;
  readonly githubToken: string;
  readonly dedupeKey: string;
  readonly executionId: string;
  readonly source: SourceExecutionIdentity;
  readonly now: number;
  readonly fetchImpl?: GithubFetch;
}

/** Dispatches a provenance-bound consumer; this operation never establishes causal content. */
export async function dispatchWithCausalBinding(context: CausalDispatchContext, request: AutopilotExecutionRequest, expiresAt: number): Promise<GithubExecutorResult | null> {
  if (request.kind !== "REPOSITORY_AUTOPILOT" || request.repository !== context.allowedRepository
    || request.dedupeKey !== context.dedupeKey || request.executionId !== context.executionId
    || request.headSha !== context.source.sha || !Number.isSafeInteger(request.workflowRunId)
    || String(request.workflowRunId) !== context.source.runId) return null;
  const capability = await prepareCausalDispatch(context, expiresAt);
  if (!capability) return null;
  try {
    return await executeGithubDispatch({ ...request, causalDispatchCapability: capability, causalSourceRunAttempt: Number(context.source.runAttempt) }, {
      token: context.githubToken, allowedRepository: context.allowedRepository,
    }, context.fetchImpl as typeof fetch | undefined);
  } catch {
    return null;
  }
}

/** Registers provenance only; it does not establish a code-actionable cause. */
export async function prepareCausalDispatch(context: CausalDispatchContext, expiresAt: number): Promise<string | null> {
  try {
    await verifyGithubCodingSourceRun(context.source, context.allowedRepository, context.githubToken, context.fetchImpl);
    const capability = newCausalDispatchCapability();
    const capabilityDigest = await hashCausalDispatchCapability(capability);
    const registered = await registerCausalDispatchBinding(context.coordinator, {
      dedupeKey: context.dedupeKey, executionId: context.executionId, source: context.source,
      capabilityDigest, now: context.now, expiresAt,
    });
    return registered ? capability : null;
  } catch {
    return null;
  }
}

/** A successful result proves publisher/source provenance only, not a causal regression or coding permission. */
export async function claimVerifiedCausalDispatch(context: CausalDispatchContext, oidcToken: string, capability: string): Promise<boolean> {
  try {
    const publisher = await verifyGithubCodingPublisherIdentity(oidcToken, context.allowedRepository, context.fetchImpl, Math.floor(context.now / 1000));
    await verifyGithubCodingPublisherRun(publisher, context.githubToken, context.fetchImpl);
    await verifyGithubCodingSourceRun(context.source, context.allowedRepository, context.githubToken, context.fetchImpl);
    const capabilityDigest = await hashCausalDispatchCapability(capability);
    return await claimRegisteredCausalDispatch(context.coordinator, {
      dedupeKey: context.dedupeKey, executionId: context.executionId, source: context.source,
      publisher, capabilityDigest, now: context.now,
    });
  } catch {
    return false;
  }
}

/** Re-validates the same bound run; still provides no causal-result or coding authority. */
export async function verifyClaimedCausalDispatch(context: CausalDispatchContext, oidcToken: string, capability: string): Promise<boolean> {
  try {
    const publisher = await verifyGithubCodingPublisherIdentity(oidcToken, context.allowedRepository, context.fetchImpl, Math.floor(context.now / 1000));
    await verifyGithubCodingPublisherRun(publisher, context.githubToken, context.fetchImpl);
    await verifyGithubCodingSourceRun(context.source, context.allowedRepository, context.githubToken, context.fetchImpl);
    const capabilityDigest = await hashCausalDispatchCapability(capability);
    return await verifyRegisteredCausalDispatch(context.coordinator, {
      dedupeKey: context.dedupeKey, executionId: context.executionId, source: context.source,
      publisher, capabilityDigest, now: context.now,
    });
  } catch {
    return false;
  }
}
