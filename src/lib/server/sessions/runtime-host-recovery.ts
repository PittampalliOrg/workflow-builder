import type {
  ApplicationSessionRuntimeHostRecoveryService,
  EnsurePublishedSessionRuntimeHostInput,
} from "$lib/server/application/session-runtime-host-recovery";

/** Thin spawn-side convenience wrapper around the composed application service. */
export function ensurePublishedAgentWorkflowHostGeneration(
  recovery: Pick<
    ApplicationSessionRuntimeHostRecoveryService,
    "ensurePublished"
  >,
  input: EnsurePublishedSessionRuntimeHostInput,
): Promise<{ recovered: boolean }> {
  return recovery.ensurePublished(input);
}
