import { daprFetch } from "$lib/server/dapr-client";
import {
  deriveLeadTeamId,
  ensureTeamMcpServer,
  stampTeamMcpHeaders,
} from "$lib/server/teams/mcp-wiring";
import { getMemberBySession } from "$lib/server/teams/team-repo";
import { rewriteMcpForBrowserSidecar } from "$lib/server/agents/mcp-sidecar";
import { resolveAgentConfigMcpForProject } from "$lib/server/agents/mcp-resolution-application";
import { getApplicationAdapters } from "$lib/server/application";
import {
	agentRuntimeInvokeTarget,
	resolveAgentRuntimeRoute,
} from "$lib/server/agents/runtime-routing";
import {
  type AgentWorkflowHostLaunchSpec,
	maybeProvisionAgentWorkflowHost,
  recreateAgentWorkflowHostGeneration,
	waitForAgentWorkflowHostAppReady,
} from "$lib/server/sessions/agent-workflow-host";
import { ensurePublishedAgentWorkflowHostGeneration } from "$lib/server/sessions/runtime-host-recovery";
import {
	resolveSessionRuntimeTarget,
	runtimeUsesSharedWorkspace,
} from "$lib/server/sessions/runtime-target";
import { buildCliSessionSecretEnv } from "$lib/server/sessions/session-secret-env";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { evaluateSwap } from "$lib/server/agents/swap-safety";
import { CliTokenError } from "$lib/server/application/cli-credentials";
import type {
  RuntimeProvisioningLease,
  SessionUserEventAcceptance,
  StaleSessionRuntimeProvisioningTarget,
  TeamMailboxDeliveryMetadata,
} from "$lib/server/application/ports";
import { sessionRuntimeGenerationInstanceId } from "$lib/server/lifecycle/resolvers";

/** Session owner (sessions.userId) — not part of the public SessionDetail
 * shape, so resolve it through workflow-data for the CLI-token gate. */
async function resolveSessionOwnerUserId(
	sessionId: string,
): Promise<string | null> {
	try {
		return await getApplicationAdapters().workflowData.getSessionOwnerUserId(
			sessionId,
		);
	} catch (err) {
		console.warn(
			`[session-spawn] session owner lookup failed for ${sessionId}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * The per-run shared workspace (`/sandbox/work`) the dev-session handoff must
 * mount. The orchestrator's `cliWorkspace` nodes (e.g. clone_repo) key the
 * JuiceFS subPath on the run's DAPR INSTANCE id (`sw-<wf>-exec-<id>`), NOT
 * `workflow_executions.id`. The handoff session's `workflowExecutionId` is the
 * canonical id (for hub linkage), so resolve the run's dapr_instance_id here to
 * mount the SAME subtree (and thus see the cloned repo + sync.sh). Falls back to
 * the canonical id when no dapr_instance_id is recorded.
 */
async function resolveRunWorkspaceKey(executionId: string): Promise<string> {
	try {
		return await getApplicationAdapters().workflowData.getWorkflowExecutionWorkspaceKey(
			executionId,
		);
	} catch (err) {
		console.warn(
			`[session-spawn] workflow execution workspace key lookup failed for ${executionId}:`,
			err instanceof Error ? err.message : err,
		);
		return executionId;
	}
}

async function resolveRuntimeHostSessionSecretEnv(input: {
  sessionId: string;
  runtimeDescriptor: ReturnType<typeof getRuntimeDescriptor>;
}): Promise<Record<string, string> | null> {
  const cliAuth = input.runtimeDescriptor?.capabilities?.interactiveTerminal
    ? input.runtimeDescriptor.cliAuth
    : undefined;
  if (!cliAuth || cliAuth.credentialKind === "device_login") return null;
  const { provider, envVar, setupCommand, credentialKind } = cliAuth;
  if (!envVar) {
    throw new Error(
      `Runtime "${input.runtimeDescriptor?.id}" cliAuth.credentialKind=${credentialKind} requires an envVar`,
    );
  }
  const optional = credentialKind === "file_bundle";
  const setupHint = setupCommand
    ? `run \`${setupCommand}\` locally`
    : "see the runtime docs";
  const ownerUserId = await resolveSessionOwnerUserId(input.sessionId);
  const { cliCredentials } = getApplicationAdapters();
  if (ownerUserId && cliCredentials.needsBootLease(provider)) {
    const leased = await cliCredentials.acquireBootLease(
      ownerUserId,
      provider,
      input.sessionId,
    );
    if (!leased) {
      console.warn(
        `[spawn] ${provider} boot-lease not acquired in time for session ${input.sessionId}; proceeding (may race a concurrent refresh)`,
      );
    }
  }
  const credential = ownerUserId
    ? await cliCredentials.getUserCredential(ownerUserId, provider)
    : null;
  if (!credential) {
    if (optional) return null;
    throw new CliTokenError(
      "CLI_TOKEN_MISSING",
      provider,
      `No ${provider} CLI credential linked for this user. ` +
        `Add one under Settings → CLI tokens (${setupHint}).`,
    );
  }
  if (
    !optional &&
    credential.expiresAt &&
    credential.expiresAt.getTime() < Date.now()
  ) {
    throw new CliTokenError(
      "CLI_TOKEN_EXPIRED",
      provider,
      `The linked ${provider} CLI credential has expired. ` +
        `Re-enroll under Settings → CLI tokens (${setupHint}).`,
    );
  }
  if (!input.runtimeDescriptor) {
    throw new Error(
      `Runtime auth descriptor resolved for ${provider}, but no runtime target was selected`,
    );
  }
  return buildCliSessionSecretEnv(input.runtimeDescriptor, credential.token);
}

async function requestPendingTeamMailboxDelivery(
  sessionId: string,
): Promise<void> {
  try {
    await getApplicationAdapters().teamMailboxDelivery.requestDeliveryAfterRuntimePublished(
      sessionId,
    );
  } catch (err) {
    // Runtime publication is already authoritative. Keep the durable mailbox row
    // for the sweeper rather than compensating a healthy workflow generation.
    console.warn(
      `[session-spawn] mailbox delivery trigger failed for ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Spawn a `session_workflow` instance in `dapr-agent-py` for the given
 * session row. Uses the Dapr sidecar's workflow API directly — no new
 * orchestrator endpoint, no new Dapr primitive. The sidecar URL resolves
 * from `DAPR_HTTP_ENDPOINT` / `DAPR_HTTP_PORT` the same way other callers
 * use it.
 *
 * Idempotent per provisioning lease. A new lease receives a new durable
 * instance id, preventing a late start or cleanup from crossing generations.
 */
export interface SpawnSessionWorkflowOptions {
	/**
	 * Keep the workflow host pod alive even when the session is linked to a
	 * workflow execution. Used for workflow → interactive-session handoffs where
	 * follow-up messages are expected after the parent workflow completes.
	 */
	persistentHost?: boolean;
	/**
	 * Fail if the per-session host cannot be provisioned. Preview dev handoffs
	 * require their exact JuiceFS execution class and must not fall back to a
	 * configured shared pool or dedicated runtime app id.
	 */
	requireWorkflowHost?: boolean;
  /** Signed capabilities inherited from a principalized peer-spawn request. */
  workflowMcpCapabilities?: {
    scriptDepth: number;
    teamId: string | null;
    teamRole: "none" | "lead" | "member";
  };
  /** Existing exclusive lease held by the application service. */
  provisioningLease?: RuntimeProvisioningLease;
  /** Keep an exact staged lease retryable after recovery-side cleanup. */
  preserveStagedLeaseOnFailure?: boolean;
  /** Exact target forwarded only by the stale-provisioning reconciler. */
  stagedRuntimeTarget?: StaleSessionRuntimeProvisioningTarget;
}

/**
 * Persist the provisioning lease before an application service performs any
 * external setup needed by the session. The raw spawn path repeats this
 * idempotently so legacy/internal callers cannot bypass the lifecycle fence.
 */
export async function reserveSessionWorkflow(
  sessionId: string,
): Promise<RuntimeProvisioningLease | null> {
  return getApplicationAdapters().workflowData.reserveSessionRuntimeProvisioning(
    { sessionId },
  );
}

export async function releaseSessionWorkflow(
  sessionId: string,
  lease: RuntimeProvisioningLease,
): Promise<boolean> {
  return getApplicationAdapters().workflowData.releaseSessionRuntimeProvisioning(
    {
      sessionId,
      expectedStartedAt: lease.startedAt,
    },
  );
}

/**
 * Re-drive the exact published host generation for an existing durable session.
 * Runtime credentials are resolved at the composition boundary and never read
 * by the team-delivery use case or persisted in the recovery recipe.
 */
export async function ensurePublishedSessionWorkflowHost(input: {
  sessionId: string;
  runtimeAppId: string;
  runtimeSandboxName: string;
}): Promise<{ recovered: boolean }> {
  const workflowData = getApplicationAdapters().workflowData;
  const session = await workflowData.getSessionDetail({
    sessionId: input.sessionId,
  });
  if (!session) throw new Error(`Session ${input.sessionId} not found`);
  const agent = await workflowData.resolveSessionAgent({
    agentId: session.agentId,
    agentVersion: session.agentVersion ?? undefined,
  });
  if (!agent) throw new Error(`Agent ${session.agentId} not found`);
  const runtime = getRuntimeDescriptor(
    (agent.config as { runtime?: string }).runtime ?? agent.runtime,
  );
  const sessionSecretEnv = await resolveRuntimeHostSessionSecretEnv({
    sessionId: input.sessionId,
    runtimeDescriptor: runtime,
  });
  return ensurePublishedAgentWorkflowHostGeneration(
    getApplicationAdapters().sessionRuntimeHostRecovery,
    {
      ...input,
      sessionSecretEnv,
    },
  );
}

export async function spawnSessionWorkflow(
	sessionId: string,
	options: SpawnSessionWorkflowOptions = {},
): Promise<{
	instanceId: string;
	natsSubject: string;
}> {
	const workflowData = getApplicationAdapters().workflowData;
	const session = await workflowData.getSessionDetail({
		sessionId,
	});
	if (!session) throw new Error(`Session ${sessionId} not found`);
  const stagedRuntimeTarget = options.stagedRuntimeTarget;
  if (
    stagedRuntimeTarget &&
    (!options.provisioningLease ||
      stagedRuntimeTarget.sessionId !== sessionId ||
      !stagedRuntimeTarget.runtimeAppId.trim() ||
      !stagedRuntimeTarget.durableInstanceId.trim() ||
      stagedRuntimeTarget.startedAt.getTime() !==
        options.provisioningLease.startedAt.getTime())
  ) {
    throw new Error(
      `Session ${sessionId} staged runtime target requires its exact provisioning lease`,
    );
  }
  // Published durable identity is stronger than the asynchronous status
  // projection. A retry can observe `rescheduling` after publication but before
  // status_running; only the exact staged-generation reconciler may bypass this.
  if (session.daprInstanceId && !stagedRuntimeTarget) {
    if (options.provisioningLease) {
      await workflowData.releaseSessionRuntimeProvisioning({
        sessionId,
        expectedStartedAt: options.provisioningLease.startedAt,
      });
    }
    if (
      session.status !== "terminated" &&
      !session.completedAt &&
      session.runtimeAppId &&
      session.runtimeSandboxName
    ) {
      await ensurePublishedSessionWorkflowHost({
        sessionId,
        runtimeAppId: session.runtimeAppId,
        runtimeSandboxName: session.runtimeSandboxName,
      });
    }
    await requestPendingTeamMailboxDelivery(sessionId);
		return {
			instanceId: session.daprInstanceId,
			natsSubject: session.natsSubject ?? `session.events.${sessionId}`,
		};
	}
  const provisioningLease =
    options.provisioningLease ??
    (await workflowData.reserveSessionRuntimeProvisioning({ sessionId }));
  if (!provisioningLease) {
    throw new Error(`Session ${sessionId} is stopping or terminal`);
  }
  const instanceId =
    stagedRuntimeTarget?.durableInstanceId.trim() ||
    sessionRuntimeGenerationInstanceId(sessionId, provisioningLease.startedAt);
  if (!instanceId) {
    throw new Error(`Session ${sessionId} has an invalid provisioning lease`);
  }
  let provisionedRuntimeSandboxName: string | null = null;
  let targetRuntimeAppId: string | null = null;
  let provisioningFinalized = false;
  let durableStartState: "not_issued" | "ambiguous" | "accepted" | "rejected" =
    "not_issued";
  try {
	const agent = await workflowData.resolveSessionAgent({
		agentId: session.agentId,
		agentVersion: session.agentVersion ?? undefined,
	});
	if (!agent) throw new Error(`Agent ${session.agentId} not found`);

	// Enrich callableAgents: config stores slugs; the runtime needs full
	// metadata ({slug, agentId, appId, team, registryKey}) to dispatch to
	// the peer's app_id without re-hitting the registry. Mirrors what the
	// workflow resolver does for durable/run nodes.
	const callableSlugs = Array.isArray(agent.config.callableAgents)
		? agent.config.callableAgents
		: [];
	const callableAgents = await (async () => {
		if (!agent.projectId || callableSlugs.length === 0)
			return [] as Array<{
				slug: string;
				agentId: string;
				version: number;
				appId: string;
				team: string;
				registryKey: string;
			}>;
		const context = await workflowData.resolvePeerAgentDispatchContext({
			agentId: agent.id,
			agentVersion: agent.version ?? undefined,
		});
		return context?.callableAgents ?? [];
	})();

	const environment = session.environmentId
    ? (
        await getApplicationAdapters().environments.resolveRuntimeByRef({
				id: session.environmentId,
				version: session.environmentVersion ?? undefined,
        })
      ).environment
		: null;

    // Seed ordinary user input posted between session.create and workflow spawn
    // (for example POST /api/v1/sessions `initialMessage`). Team-origin rows
    // remain in the mailbox so their stable ids flow through claim/receipt.
  const existingEvents =
    await getApplicationAdapters().workflowData.listSessionEvents(sessionId, {
      limit: 50,
    });
    const initialEvents =
      getApplicationAdapters().teamMailboxDelivery.initialUserEvents(
        existingEvents,
      );

	// Rewrite Playwright MCP entries to point at the per-agent browser
	// sidecar (http://localhost:3100/mcp). The DB config stores stdio
	// presets from agent-mcp-picker; sending those unmodified makes the
	// agent try to launch Chromium inside the dapr-agent-py container
	// (no binary). The per-turn config wins at runtime over the bootstrap
	// env var (see dapr-agent-py _ensure_mcp_client_async), so this
	// rewrite must happen here — registry-sync only covers the bootstrap.
	// Flatten reusable capability bundles (Pillar 2) into the effective config
	// BEFORE MCP resolution, so bundle-contributed MCP servers participate in
	// project-connection resolution exactly like inline ones.
	const flattenedAgentConfig =
		await getApplicationAdapters().capabilityBundles.flattenBundles(
			agent.config,
			agent.projectId,
		);
	const resolutionTarget = getRuntimeDescriptor(
		(flattenedAgentConfig as { runtime?: string }).runtime ?? agent.runtime,
	);
	const resolvedAgentConfig = await resolveAgentConfigMcpForProject(
		flattenedAgentConfig,
		agent.projectId,
		{
			autoIncludesProjectConnections:
				resolutionTarget?.cliAdapter !== "antigravity",
		},
	);
	const { mcpServers: rewrittenMcp, useBrowserSidecar } =
		resolvedAgentConfig.runtime === "browser-use-agent"
			? {
					mcpServers:
						((resolvedAgentConfig as { mcpServers?: unknown[] })
							.mcpServers as never) ?? [],
					useBrowserSidecar: false,
				}
			: rewriteMcpForBrowserSidecar(
					(resolvedAgentConfig as { mcpServers?: unknown[] })
						.mcpServers as never,
					{ runtime: resolvedAgentConfig.runtime },
				);
	const runtimeRoute = resolveAgentRuntimeRoute({
		agentSlug: agent.slug,
		runtimeAppId: agent.runtimeAppId,
		config: resolvedAgentConfig,
		useBrowserSidecar,
	});
	// Swap-safety gate (Phase 3): surface when the dispatched runtime would
	// drop a capability the agent's config relies on (e.g. an unsupported model
	// provider, or MCP on a non-MCP runtime). WARN-first: logs the degraded
	// capabilities; only hard-fails when AGENT_RUNTIME_REJECT_LOSSY_SWAP is set.
	// Normal spawns (agent on its own runtime) resolve to "allow".
	const swapTarget = getRuntimeDescriptor(
		(resolvedAgentConfig as { runtime?: string }).runtime,
	);
	if (swapTarget) {
		const verdict = evaluateSwap(
			resolvedAgentConfig as Record<string, unknown>,
			swapTarget,
			// The agent row's configured runtime is the swap SOURCE; crossing the
			// interactive-cli family boundary is reject-class (interaction model
			// changes, not just feature degradation). Source hook-blocking
			// granularity lets swap-safety WARN on full→advisory hook degradation.
			{
				sourceFamily: getRuntimeDescriptor(agent.runtime)?.family ?? null,
				sourceHookBlockingGranularity:
					getRuntimeDescriptor(agent.runtime)?.capabilities
						?.hookBlockingGranularity ?? null,
			},
		);
		if (verdict.drops.length > 0) {
			console.warn(
				`[swap-safety] session ${sessionId} \u2192 runtime "${swapTarget.id}" ${verdict.decision}: ` +
            verdict.drops
              .map((d) => `${d.capability}(${d.severity})`)
              .join(", "),
			);
			for (const d of verdict.drops)
				console.warn(`[swap-safety]   ${d.detail}`);
			// Surface the degraded swap as a session event so it's queryable in
			// session_events + visible in the UI (the WARN-phase audit dataset).
			// Fire-and-forget with a deterministic sourceEventId (dedupes re-spawns);
			// an event-write failure must never block the spawn.
      void getApplicationAdapters()
        .workflowData.appendSessionEvent(sessionId, {
				type: "runtime.swap_degraded",
				data: {
					runtimeId: swapTarget.id,
					decision: verdict.decision,
					drops: verdict.drops,
				},
				sourceEventId: `swap:${sessionId}:${swapTarget.id}`,
        })
        .catch((err) =>
				console.warn(
					`[swap-safety] swap_degraded event emit failed: ${err instanceof Error ? err.message : err}`,
				),
			);
			if (verdict.decision === "reject") {
				throw new Error(
					`Runtime "${swapTarget.id}" cannot satisfy required agent capabilities: ` +
						verdict.drops
							.filter((d) => d.severity === "reject")
							.map((d) => d.detail)
							.join("; "),
				);
			}
		}
	}
	// Resolve Prompt Workbench preset bindings (version-pinned) into raw text
	// arrays the runtime can stitch into the bundle without DB access. Fail
	// open: a missing preset must never block a session spawn.
	const emptyPresetStack = {
		static: [] as string[],
		dynamic: [] as string[],
		staticManifest: [] as Array<{
			promptId: string;
			version: number;
			promptVersionId: string;
			mlflowUri: string | null;
		}>,
		dynamicManifest: [] as Array<{
			promptId: string;
			version: number;
			promptVersionId: string;
			mlflowUri: string | null;
		}>,
	};
	const compiledPresetStack = agent.projectId
		? await getApplicationAdapters()
				.promptStackCompiler.compilePromptStack(resolvedAgentConfig, {
					projectId: agent.projectId,
				})
				.catch((err) => {
					console.warn(
						"[session-spawn] compilePromptStack failed, continuing with empty stack:",
						err instanceof Error ? err.message : err,
					);
					return emptyPresetStack;
				})
		: emptyPresetStack;
	// Agent Teams scope: a teammate (team_members row exists) carries the lead's
	// team id + the X-Wfb-Team-Depth nesting guard; a potential lead derives its
	// team id from its own session id and is stamped only when TEAM_MCP_AUTO_WIRE
	// is enabled (teammates are always stamped). Best-effort — a lookup failure
	// must never block a spawn.
	const teamMember = await getMemberBySession(sessionId).catch(() => null);
    const signedTeamId =
      options.workflowMcpCapabilities?.teamId?.trim() || null;
    const signedTeamRole = options.workflowMcpCapabilities?.teamRole ?? "none";
    const teamId =
      signedTeamId ?? teamMember?.team_id ?? deriveLeadTeamId(sessionId);
    const isTeammate =
      signedTeamRole === "member"
        ? signedTeamId !== null
        : !!teamMember && teamMember.role !== "lead";
	// A lead opts into the team tools per-agent via agentConfig.teamsEnabled.
	const teamsEnabled =
		(resolvedAgentConfig as { teamsEnabled?: boolean }).teamsEnabled === true;
  const teamMcpEnabled =
    isTeammate || teamsEnabled || process.env.TEAM_MCP_AUTO_WIRE === "true";
  const sessionOwner = await workflowData.getSessionFileOwner(sessionId);
  const workflowMcpSessionToken = (() => {
    if (!sessionOwner?.projectId) return null;
    try {
      return getApplicationAdapters().workflowMcpSessionTokenSigner.sign({
        userId: sessionOwner.userId,
        projectId: sessionOwner.projectId,
        sessionId,
        capabilities: options.workflowMcpCapabilities ?? {
          scriptDepth: 0,
          teamId: teamMcpEnabled ? teamId : null,
          teamRole: isTeammate ? "member" : teamMcpEnabled ? "lead" : "none",
        },
      });
    } catch (err) {
      console.warn(
        `[session-spawn] workflow MCP session token unavailable for ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  })();
    if (!workflowMcpSessionToken) {
      throw new Error(
        `Session ${sessionId} cannot start without signed lifecycle authority`,
      );
    }
	// The Codex-"ultra" policy dial: teamMode 'proactive' injects ONE system
	// fragment flipping the default only-when-asked posture — deliberately
	// prompt-text-only (mirrors Codex's MultiAgentMode developer message).
	// Leads only; teammates never inherit it (a worker proactively spawning
	// siblings would be chaos even without the depth guard).
	const teamModeFragment =
		teamsEnabled &&
		!isTeammate &&
		(resolvedAgentConfig as { teamMode?: string }).teamMode === "proactive"
			? "\n\n# Proactive team delegation\nProactive team delegation is active. Spawn teammates (spawn_teammate) and seed the shared task list (create_task) whenever parallel work would materially improve speed or quality — you do not need the user to ask. Keep teammate prompts self-contained, prefer 2-4 teammates, and use wait_teammates plus teammate idle messages to integrate results."
			: "";
	const agentConfigForDispatch = {
		...resolvedAgentConfig,
		...(teamModeFragment
			? {
					systemPrompt: `${
            (resolvedAgentConfig as { systemPrompt?: string }).systemPrompt ??
            ""
					}${teamModeFragment}`.trim(),
				}
			: {}),
		// Goals are authored in code (dynamic-script) and completed by the BFF
		// evidence backstop, so the goal MCP server is no longer auto-wired.
		// Team-capable sessions still get the Workflow MCP server injected (for
		// the team tools), then stamped with their team headers.
		mcpServers: stampTeamMcpHeaders(
			ensureTeamMcpServer(rewrittenMcp, {
				isTeammate,
				teamsEnabled,
				isCliRuntime: swapTarget?.capabilities?.interactiveTerminal === true,
			}),
			{ teamId, isTeammate, teamsEnabled },
		),
		compiledStaticPresetSections: compiledPresetStack.static,
		compiledDynamicPresetSections: compiledPresetStack.dynamic,
		// Phase 3a v2: per-ref version-id + mlflow_uri manifest so
		// dapr-agent-py can stamp `tag.prompt_version_id` / `tag.prompt_version`
		// on agent traces. Empty array when no presets are bound.
		promptPresetManifest: [
			...compiledPresetStack.staticManifest,
			...compiledPresetStack.dynamicManifest,
		],
	};

	// Interactive-CLI lane: the runtime hosts the real CLI TUI in the session
	// pod. The host selects the adapter from `agentConfig.cliAdapter`, stamped
	// here from the runtime descriptor (one image hosts claude/codex/agy).
    if (
      swapTarget?.capabilities?.interactiveTerminal &&
      swapTarget.cliAdapter
    ) {
		(agentConfigForDispatch as Record<string, unknown>).cliAdapter =
			swapTarget.cliAdapter;
		// Resume: this session re-mounts the original's durable transcript subtree
		// (via resumeFromSessionId on the host request below). Signal the in-pod
		// adapter to launch the CLI in continue mode (`claude --continue`) so it
		// picks up the prior conversation from the re-mounted projects dir.
		if (session.resumedFromSessionId) {
			(agentConfigForDispatch as Record<string, unknown>).continueSession =
				true;
		}

		// Belt-and-suspenders cold-start warm-up. The Claude Code CLI connects
		// every MCP server ONCE at startup; a scale-to-zero ap-<piece>-service
		// (Knative) that is cold at that moment fails the connect and the TUI
		// mis-surfaces it as "not authenticated". The in-pod host also warms these
		// just before launch (cli_lifecycle._warm_ap_mcp_servers); firing the
		// scale-from-zero GETs HERE — in parallel with Kueue pod admission — means
		// the services are likely already warm by launch. Fire-and-forget: never
		// awaited, never throws into spawn; no X-Connection-External-Id (warm-up
		// only triggers the Knative activator).
		const warmUrls = ((agentConfigForDispatch.mcpServers as unknown[]) ?? [])
        .filter(
          (s): s is Record<string, unknown> => !!s && typeof s === "object",
        )
			.filter((s) => {
				const sourceType = String(s.sourceType ?? s.source_type ?? "");
				const registryRef = String(s.registryRef ?? s.registry_ref ?? "");
				return sourceType === "nimble_piece" || registryRef.startsWith("ap-");
			})
			.map((s) => String(s.url ?? s.serverUrl ?? ""))
			.filter((u) => u.startsWith("http"));
		if (warmUrls.length > 0) {
			void Promise.allSettled(
				warmUrls.map((u) =>
            daprFetch(u, { method: "GET", maxRetries: 2 }).catch(
              () => undefined,
            ),
				),
			);
		}
	}

	// OAuth credential delivery, generalized over cliAuth.credentialKind:
	//   - env_token / file → resolve the session owner's stored credential and
	//     deliver it as the secret env var (`sessionSecretEnv`); the in-pod
	//     adapter consumes it (env_token: read directly; file: seed() writes the
	//     credential file). REQUIRED — fail fast with a typed 412 if missing.
	//   - file_bundle → OPTIONAL: deliver the captured login bundle if the user
	//     has one (agy ~/.gemini); if not, fall through to in-terminal device-code
	//     login (the runtime auto-captures the bundle afterward). Expiry is NOT
	//     enforced — agy refreshes the token on boot.
	//   - device_login → no pre-provisioned credential; the user completes the
	//     in-terminal device-code OAuth flow on first launch. No gate, no secret.
	// Tokens are NEVER placed in agentConfig or the Dapr payload.
    const sessionSecretEnv = await resolveRuntimeHostSessionSecretEnv({
				sessionId,
      runtimeDescriptor: swapTarget,
    });

    const natsSubject = `session.events.${sessionId}`;

	// Resolve the dispatch app-id. Two paths share the same downstream shape
	// (Dapr service-invoke into `/internal/sessions/spawn`); only the pod
	// backing the app-id differs:
	//   1. Kueue Sandbox path (preferred for non-browser agents): a fresh
	//      `agents.x-k8s.io/v1alpha1 Sandbox` is admitted via Kueue, the pod
	//      gets a deterministic `agent-session-<sha20>` app-id, and the BFF
	//      blocks until the pod is ready. No wake handshake needed.
	//   2. SandboxWarmPool path (browser-use-agent + Playwright MCP): per-slug
	//      pool emitted at agent publish; we patch `spec.replicas: 1` on demand
	//      via `wakeAgentRuntime` and the upstream agent-sandbox controller
	//      manages the pod.
    let sessionHost: Awaited<
      ReturnType<typeof maybeProvisionAgentWorkflowHost>
    >;
	try {
      if (stagedRuntimeTarget?.runtimeHostOwned) {
        const sandboxName = stagedRuntimeTarget.runtimeSandboxName?.trim();
        const launchSpec = stagedRuntimeTarget.runtimeHostLaunchSpec;
        if (!sandboxName || !launchSpec) {
          throw new Error(
            `Session ${sessionId} exact staged host is missing recovery metadata`,
          );
        }
        await recreateAgentWorkflowHostGeneration({
          agentAppId: stagedRuntimeTarget.runtimeAppId,
          sandboxName,
          launchSpec,
          sessionSecretEnv,
        });
        sessionHost = {
          agentAppId: stagedRuntimeTarget.runtimeAppId,
          sandboxName,
          status: "recreated",
          launchSpec: launchSpec as AgentWorkflowHostLaunchSpec,
        };
      } else if (stagedRuntimeTarget) {
        sessionHost = null;
      } else {
		sessionHost = await maybeProvisionAgentWorkflowHost({
			sessionId,
			agentConfig: agentConfigForDispatch,
			workflowExecutionId: session.workflowExecutionId ?? null,
			// Shared-workspace dev-session handoff (P3): a session row carrying a
			// workflowExecutionId mounts the SAME per-execution /sandbox/work the
			// workflow used (the agent sees the cloned repo). The orchestrator keys that
			// workspace on the run's dapr_instance_id, so resolve it (NOT the canonical
			// workflowExecutionId) to mount the same JuiceFS subPath. This applies to
			// interactive terminals and JuiceFS-local Dapr agents. Direct UI sessions
			// have workflowExecutionId=null -> no shared mount (unchanged).
			sharedWorkspaceKey:
				runtimeUsesSharedWorkspace(swapTarget?.capabilities) &&
				session.workflowExecutionId
					? await resolveRunWorkspaceKey(session.workflowExecutionId)
					: null,
			benchmarkRunId: null,
			benchmarkInstanceId: null,
			timeoutMinutes: null,
			persistentHost: options.persistentHost === true,
			sessionSecretEnv,
			// Resume: the sandbox host keys the per-session transcript CSI subPath on
			// this id, so the resumed pod re-mounts the original conversation's
			// Postgres-backed subtree (paired with continueSession above).
			resumeFromSessionId: session.resumedFromSessionId ?? null,
          provisioningStartedAt: provisioningLease.startedAt,
		});
      }
	} catch (err) {
      if (stagedRuntimeTarget || options.requireWorkflowHost) throw err;
		console.warn(
			`[session-spawn] sandbox provision failed, falling back to warm-pool wake:`,
			err instanceof Error ? err.message : err,
		);
		sessionHost = null;
	}
	if (options.requireWorkflowHost && !sessionHost) {
		throw new Error("required per-session workflow host was not provisioned");
	}
    const targetAppId =
      stagedRuntimeTarget?.runtimeAppId ??
      sessionHost?.agentAppId ??
      runtimeRoute.appId;
    targetRuntimeAppId = targetAppId;
    provisionedRuntimeSandboxName = stagedRuntimeTarget
      ? stagedRuntimeTarget.runtimeSandboxName
      : (sessionHost?.sandboxName ?? null);
    const runtimeHostOwned =
      stagedRuntimeTarget?.runtimeHostOwned ??
      provisionedRuntimeSandboxName != null;
    const runtimeHostLaunchSpec = stagedRuntimeTarget
      ? stagedRuntimeTarget.runtimeHostLaunchSpec
      : (sessionHost?.launchSpec ?? null);
    const staged = await workflowData.stageSessionRuntimeProvisioning({
      sessionId,
      expectedStartedAt: provisioningLease.startedAt,
      runtimeAppId: targetAppId,
      durableInstanceId: instanceId,
      runtimeSandboxName: provisionedRuntimeSandboxName,
      runtimeHostOwned,
      runtimeHostLaunchSpec,
    });
    if (!staged) {
      await getApplicationAdapters().sessionCommands.cleanupUnpublishedRuntimeProvisioning(
        {
          sessionId,
          sandboxName: provisionedRuntimeSandboxName,
          leaseStartedAt: provisioningLease.startedAt,
          preserveActiveLease: options.preserveStagedLeaseOnFailure === true,
        },
      );
      provisioningFinalized = true;
      throw new Error(
        `Session ${sessionId} stopped before its runtime start was staged`,
      );
    }
	if (!sessionHost) {
		try {
			const { wakeAgentRuntime } = await import("$lib/server/kube/client");
			await wakeAgentRuntime(runtimeRoute.slug, 30_000);
		} catch (err) {
			console.warn(
				`[session-spawn] wake ${runtimeRoute.slug} failed, continuing anyway:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	const payload = {
		sessionId,
		agentId: agent.id,
		agentVersion: session.agentVersion ?? agent.version ?? null,
		agentSlug: agent.slug,
		agentAppId: targetAppId,
		agentRuntimeClass: runtimeRoute.runtimeClass,
		agentRuntimeIsolation: runtimeRoute.isolation,
		runtimeConfigInspectionVersion: 1,
    workflowMcpSessionToken,
		agentConfig: agentConfigForDispatch,
		// Flat metadata the call_agent tool needs to dispatch peers by name.
		callableAgents,
		registryTeam: agent.projectId ?? null,
		environmentConfig: environment ? environment.config : null,
		vaultIds: session.vaultIds,
		dbExecutionId: session.workflowExecutionId ?? null,
		// UI sessions get a per-session OpenShell sandbox provisioned on
		// create (see src/lib/server/sandboxes/provision.ts). session_workflow
		// inlines this into every child agent_workflow turn so
		// OpenShellRuntime.set_sandbox_name(...) fires before tool execution.
		// Workflow-driven sessions leave this null — the preceding
		// workspace_profile node provides its own sandboxName.
		sandboxName: session.workspaceSandboxName ?? null,
		initialEvents,
      // Every newly scheduled session revalidates the persisted lifecycle fence
      // before emitting events or performing model/tool work. This closes the
      // accepted-start-to-runtime-publication window for UI sessions as well as
      // native and separately hosted peer sessions.
      requiresStartAuthority: true,
	};

	const daprEndpoint = getDaprSidecarUrl();
	// Per-agent runtime pods now live in the same namespace as the
	// BFF + orchestrator (workflow-builder). Bare app-id routing works
	// for Dapr service-invoke within a namespace. Cross-namespace
	// suffix (`<app-id>.<ns>`) is only appended when
	// AGENT_RUNTIME_NAMESPACE is overridden away from the BFF's own
	// namespace — supports the rollback path back to openshell.
	const invokeTarget = agentRuntimeInvokeTarget(targetAppId);
	let directRuntimeBaseUrl: string | null = null;
	if (sessionHost) {
		const ready = await waitForAgentWorkflowHostAppReady({
			agentAppId: targetAppId,
		});
		directRuntimeBaseUrl = ready.baseUrl;
	}
	// Interactive-CLI runtimes work in the agent pod's own /sandbox (no
	// OpenShell workspace sandbox), so attached repos are cloned via the host's
	// `/internal/workspace/command` BEFORE the TUI starts. Best-effort —
	// failures emit session events, never block the spawn.
	if (directRuntimeBaseUrl && swapTarget?.capabilities?.interactiveTerminal) {
		try {
      await getApplicationAdapters().sessionCommands.materializeSessionRepositoriesViaHost(
        {
				sessionId,
				hostBaseUrl: directRuntimeBaseUrl,
        },
      );
		} catch (err) {
			console.warn(
				`[session-spawn] host repository mount failed for ${sessionId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
    // Once dispatch begins, a thrown transport error cannot prove that
    // StartInstance was rejected. Keep the staged generation authoritative until
    // the reconciler can inspect its deterministic instance id.
    durableStartState = "ambiguous";
	const res = await (directRuntimeBaseUrl
		? daprFetch(`${directRuntimeBaseUrl}/internal/sessions/spawn`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceId, payload }),
				maxRetries: 0,
			})
		: daprFetch(
				`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(invokeTarget)}/method/internal/sessions/spawn`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ instanceId, payload }),
				},
			));
	if (!res.ok && res.status !== 409) {
      durableStartState = "rejected";
		const text = await res.text().catch(() => "");
		throw new Error(
			`Dapr workflow start failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}
    durableStartState = "accepted";

    // Publish positive start evidence only after the runtime accepted the durable
    // instance. Until this CAS succeeds, the lease keeps lifecycle cleanup aware
    // of the deterministic prospective host and the child polls start authority.
    const attached = await workflowData.attachStagedSessionRuntimeProvisioning({
      sessionId,
      expectedStartedAt: provisioningLease.startedAt,
    });
    if (!attached) {
      await getApplicationAdapters().sessionCommands.cleanupUnpublishedRuntimeProvisioning(
        {
		sessionId,
          sandboxName: provisionedRuntimeSandboxName,
          leaseStartedAt: provisioningLease.startedAt,
          durableInstance: {
		runtimeAppId: targetAppId,
            instanceId,
            runtimeSandboxName: provisionedRuntimeSandboxName,
          },
          preserveActiveLease: options.preserveStagedLeaseOnFailure === true,
        },
      );
      provisioningFinalized = true;
      throw new Error(
        `Session ${sessionId} stopped while its runtime host was provisioning`,
      );
    }
    if (runtimeHostOwned && provisionedRuntimeSandboxName) {
      await ensurePublishedAgentWorkflowHostGeneration(
        getApplicationAdapters().sessionRuntimeHostRecovery,
        {
          sessionId,
          runtimeAppId: targetAppId,
          runtimeSandboxName: provisionedRuntimeSandboxName,
          sessionSecretEnv,
        },
      );
    }
    const completion = await workflowData.completeSessionRuntimeHostRecovery({
      sessionId,
      expectedRuntimeAppId: targetAppId,
      expectedStartedAt: provisioningLease.startedAt,
	});
    if (completion !== "completed" && completion !== "already_completed") {
      await getApplicationAdapters().sessionCommands.cleanupUnpublishedRuntimeProvisioning(
        {
          sessionId,
          sandboxName: provisionedRuntimeSandboxName,
          leaseStartedAt: provisioningLease.startedAt,
          durableInstance: {
            runtimeAppId: targetAppId,
            instanceId,
            runtimeSandboxName: provisionedRuntimeSandboxName,
          },
          preserveActiveLease: options.preserveStagedLeaseOnFailure === true,
        },
      );
      provisioningFinalized = true;
      throw new Error(
        `Session ${sessionId} runtime publication lost authority (${completion})`,
      );
    }
    provisioningFinalized = true;
    await requestPendingTeamMailboxDelivery(sessionId);

	return { instanceId, natsSubject };
  } catch (err) {
    if (!provisioningFinalized && durableStartState !== "ambiguous") {
      // Remove a host created by a failed setup before releasing/acknowledging
      // the exact lease. If the runtime accepted the durable start, purge that
      // exact generation first even when the runtime host is a shared pool.
      // Sandbox deletion remains conditional on owning a dedicated host.
      await getApplicationAdapters()
        .sessionCommands.cleanupUnpublishedRuntimeProvisioning({
          sessionId,
          sandboxName: provisionedRuntimeSandboxName,
          leaseStartedAt: provisioningLease.startedAt,
          ...(durableStartState === "accepted" && targetRuntimeAppId
            ? {
                durableInstance: {
                  runtimeAppId: targetRuntimeAppId,
                  instanceId,
                  runtimeSandboxName: provisionedRuntimeSandboxName,
                },
              }
            : {}),
          preserveActiveLease: options.preserveStagedLeaseOnFailure === true,
        })
        .catch((cleanupErr) => {
          console.error(
            `[session-spawn] unpublished runtime cleanup failed for ${sessionId}/${instanceId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
          return false;
        });
    } else if (!provisioningFinalized) {
      console.warn(
        `[session-spawn] retaining ambiguous staged runtime ${sessionId}/${instanceId} for reconciliation`,
      );
    }
    throw err;
  }
}

function getDaprSidecarUrl(): string {
	const host = process.env.DAPR_HOST ?? "127.0.0.1";
	const port = process.env.DAPR_HTTP_PORT ?? "3500";
	return `http://${host}:${port}`;
}

/**
 * Raise a user-side event batch into the session's workflow. Used by
 * `POST /api/v1/sessions/[id]/events` after DB append.
 */
export async function raiseSessionUserEvents(
	sessionId: string,
	events: unknown[],
  delivery?: TeamMailboxDeliveryMetadata,
): Promise<SessionUserEventAcceptance> {
	const session = await getApplicationAdapters().workflowData.getSessionDetail({
		sessionId,
	});
  if (!session?.daprInstanceId) {
    if (delivery) {
      throw new Error("Session runtime has not accepted the mailbox delivery");
    }
    return { accepted: true, deliveryId: null };
  }
	// Route raise-event to the exact runtime that owns the session. New rows
	// persist this at spawn time; older rows fall back through the agent route.
	const target = await resolveSessionRuntimeTarget(sessionId);
	const invokeTarget =
		target?.invokeTarget ?? agentRuntimeInvokeTarget("dapr-agent-py");
	const daprEndpoint = getDaprSidecarUrl();
	const body = JSON.stringify({
		instanceId: session.daprInstanceId,
		eventName: "session.user_events",
    payload: { events, ...(delivery ? { delivery } : {}) },
	});
	const res =
		target?.runtimeSandboxName || target?.appId.startsWith("agent-session-")
			? await daprFetch(
					`${(await waitForAgentWorkflowHostAppReady({ agentAppId: target.appId })).baseUrl}/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
						maxRetries: 0,
					},
				)
			: await daprFetch(
					`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(invokeTarget)}/method/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
					},
				);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Dapr raiseEvent failed (${res.status}): ${text.slice(0, 200)}`,
		);
	}
  if (delivery) {
    const receipt = (await res.json().catch(() => null)) as {
      accepted?: unknown;
      deliveryId?: unknown;
    } | null;
    if (receipt?.accepted !== true || receipt.deliveryId !== delivery.batchId) {
      throw new Error(
        `Runtime did not acknowledge mailbox delivery ${delivery.batchId}`,
      );
    }
    return { accepted: true, deliveryId: delivery.batchId };
  }
  return { accepted: true, deliveryId: null };
}
