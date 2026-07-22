import type {
  CompleteSessionRuntimeHostRecoveryResult,
  SessionRuntimeHostLaunchSpec,
  SessionRuntimeHostRecoveryLease,
  SessionRuntimeHostRecoveryRecord,
} from "$lib/server/application/ports";

export interface SessionRuntimeHostRecoveryRepositoryPort {
  inspectSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
  }): Promise<SessionRuntimeHostRecoveryRecord | null>;
  beginSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
  }): Promise<SessionRuntimeHostRecoveryLease | null>;
  completeSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
    expectedStartedAt: Date;
  }): Promise<CompleteSessionRuntimeHostRecoveryResult>;
}

export interface SessionRuntimeHostRecoveryProviderPort {
  activate(input: {
    runtimeAppId: string;
    runtimeSandboxName: string;
  }): Promise<"active" | "absent">;
  recreate(input: {
    runtimeAppId: string;
    runtimeSandboxName: string;
    launchSpec: SessionRuntimeHostLaunchSpec;
    sessionSecretEnv: Record<string, string> | null;
    traceContext: SessionRuntimeHostRecoveryTraceContext | null;
  }): Promise<void>;
}

export interface SessionRuntimeHostRecoveryCleanupPort {
  cleanup(input: {
    sessionId: string;
    runtimeSandboxName: string;
    leaseStartedAt: Date;
  }): Promise<boolean>;
}

export type SessionRuntimeHostRecoveryTraceContext = {
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
};

export type EnsurePublishedSessionRuntimeHostInput = {
  sessionId: string;
  runtimeAppId: string;
  runtimeSandboxName: string;
  sessionSecretEnv?: Record<string, string> | null;
  traceContext?: SessionRuntimeHostRecoveryTraceContext | null;
};

type SessionRuntimeHostRecoveryDependencies = {
  repository: SessionRuntimeHostRecoveryRepositoryPort;
  provider: SessionRuntimeHostRecoveryProviderPort;
  cleanup: SessionRuntimeHostRecoveryCleanupPort;
};

export class SessionRuntimeHostRecoveryError extends Error {
  constructor(
    readonly code:
      | "runtime_stopping"
      | "runtime_superseded"
      | "runtime_recovery_conflict"
      | "runtime_recovery_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SessionRuntimeHostRecoveryError";
  }
}

function assertExactRecoveryRecord(
  record: Pick<
    SessionRuntimeHostRecoveryRecord,
    "runtimeAppId" | "runtimeSandboxName"
  >,
  input: {
    runtimeAppId: string;
    runtimeSandboxName: string;
  },
): void {
  if (
    record.runtimeAppId !== input.runtimeAppId ||
    record.runtimeSandboxName !== input.runtimeSandboxName
  ) {
    throw new SessionRuntimeHostRecoveryError(
      "runtime_superseded",
      "Published runtime generation changed before recovery",
    );
  }
}

async function completeActivatedRecoveryLease(
  deps: SessionRuntimeHostRecoveryDependencies,
  input: EnsurePublishedSessionRuntimeHostInput,
  startedAt: Date,
): Promise<void> {
  const completed = await deps.repository.completeSessionRuntimeHostRecovery({
    sessionId: input.sessionId,
    expectedRuntimeAppId: input.runtimeAppId,
    expectedStartedAt: startedAt,
  });
  if (completed === "completed" || completed === "already_completed") return;

  await deps.cleanup
    .cleanup({
      sessionId: input.sessionId,
      runtimeSandboxName: input.runtimeSandboxName,
      leaseStartedAt: startedAt,
    })
    .catch(() => false);
  const code =
    completed === "stopped"
      ? "runtime_stopping"
      : completed === "superseded"
        ? "runtime_superseded"
        : "runtime_recovery_conflict";
  throw new SessionRuntimeHostRecoveryError(
    code,
    `Session ${input.sessionId} runtime recovery lost authority (${completed})`,
  );
}

/**
 * Ensure an already-published, lifecycle-authorized host generation is active.
 * Provider absence is repaired with the same app id and persisted non-secret
 * recipe. The recreated host remains provisional until the repository CAS
 * proves that neither the session nor its parent workflow has stopped.
 */
export async function ensurePublishedSessionRuntimeHost(
  deps: SessionRuntimeHostRecoveryDependencies,
  input: EnsurePublishedSessionRuntimeHostInput,
): Promise<{ recovered: boolean }> {
  const published = await deps.repository.inspectSessionRuntimeHostRecovery({
    sessionId: input.sessionId,
    expectedRuntimeAppId: input.runtimeAppId,
  });
  if (!published) {
    throw new SessionRuntimeHostRecoveryError(
      "runtime_recovery_unavailable",
      `Session ${input.sessionId} is stopped or has no recoverable published runtime`,
    );
  }
  assertExactRecoveryRecord(published, input);
  const initialActivation = await deps.provider.activate({
    runtimeAppId: input.runtimeAppId,
    runtimeSandboxName: input.runtimeSandboxName,
  });
  if (initialActivation === "active") {
    if (published.recoveryStartedAt) {
      await completeActivatedRecoveryLease(
        deps,
        input,
        published.recoveryStartedAt,
      );
    }
    return { recovered: false };
  }
  if (!published.launchSpec) {
    throw new SessionRuntimeHostRecoveryError(
      "runtime_recovery_unavailable",
      `Published runtime generation ${input.runtimeAppId} has no recovery recipe`,
    );
  }

  const recovery = await deps.repository.beginSessionRuntimeHostRecovery({
    sessionId: input.sessionId,
    expectedRuntimeAppId: input.runtimeAppId,
  });
  if (!recovery) {
    throw new SessionRuntimeHostRecoveryError(
      "runtime_stopping",
      `Session ${input.sessionId} stopped before runtime recovery`,
    );
  }
  assertExactRecoveryRecord(recovery, input);

  try {
    await deps.provider.recreate({
      runtimeAppId: input.runtimeAppId,
      runtimeSandboxName: input.runtimeSandboxName,
      launchSpec: recovery.launchSpec,
      sessionSecretEnv: input.sessionSecretEnv ?? null,
      traceContext: input.traceContext ?? null,
    });
  } catch (error) {
    await deps.cleanup
      .cleanup({
        sessionId: input.sessionId,
        runtimeSandboxName: input.runtimeSandboxName,
        leaseStartedAt: recovery.startedAt,
      })
      .catch(() => false);
    throw error;
  }

  // The recreated host remains provisional while the exact recovery lease is
  // held. Activate it before publishing completion so a transient provider
  // failure leaves durable retry authority for the next reconciliation pass.
  const activation = await deps.provider.activate({
    runtimeAppId: input.runtimeAppId,
    runtimeSandboxName: input.runtimeSandboxName,
  });
  if (activation !== "active") {
    throw new SessionRuntimeHostRecoveryError(
      "runtime_recovery_unavailable",
      `Recovered runtime generation ${input.runtimeAppId} disappeared before activation`,
    );
  }

  await completeActivatedRecoveryLease(deps, input, recovery.startedAt);
  return { recovered: true };
}

/** Application surface used by inbound adapters that need an exact host alive. */
export class ApplicationSessionRuntimeHostRecoveryService {
  constructor(private readonly deps: SessionRuntimeHostRecoveryDependencies) {}

  ensurePublished(
    input: EnsurePublishedSessionRuntimeHostInput,
  ): Promise<{ recovered: boolean }> {
    return ensurePublishedSessionRuntimeHost(this.deps, input);
  }
}
