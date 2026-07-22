import { createHash } from "node:crypto";
import type {
  SessionLifecycleController,
  TeamMemberLaunchReservation,
  TeamMemberPeerDispatchRecipe,
  TeamMemberRevivalReservationInput,
  TeamMemberRow,
  TeamMemberSpawnReservationInput,
  TeamStore,
} from "$lib/server/application/ports";
import type {
  ApplicationPeerSessionSpawnService,
  PeerSessionSpawnPrincipal,
  PeerSessionSpawnResult,
} from "$lib/server/application/peer-session-spawn";
import type { ApplicationTeamMailboxEligibilityService } from "$lib/server/application/team-mailbox-eligibility";

type PeerSpawner = Pick<ApplicationPeerSessionSpawnService, "spawnPeerSession">;

export type TeamMemberDispatchIntent = Pick<
  TeamMemberPeerDispatchRecipe["request"],
  "prompt" | "title" | "skipSpawn" | "provisionSandbox" | "sandboxTemplate"
>;

type TeamMemberDispatchTarget = Pick<
  TeamMemberPeerDispatchRecipe["request"],
  "peerAgentId" | "peerAgentVersion"
>;

export type TeamMemberLaunchResult =
  | {
      status: "ok";
      member: TeamMemberRow;
      spawn: Extract<PeerSessionSpawnResult, { status: "ok" }>;
    }
  | { status: "error"; httpStatus: number; message: string };

/**
 * Owns the persistence-to-dispatch transaction for teammate starts. External
 * peer dispatch cannot share a database transaction, so the member identity is
 * first reserved as non-working, then promoted only after the adapter can prove
 * the exact child and its team lineage are still active.
 */
export class ApplicationTeamMemberLaunchService {
  constructor(
    private readonly deps: {
      teams: Pick<
        TeamStore,
        | "beginMemberSpawn"
        | "beginMemberRevival"
        | "findMemberSpawnReplay"
        | "findMemberRevivalReplay"
        | "promoteStartingMember"
        | "requestMemberLaunchCleanup"
        | "completeMemberLaunchCleanup"
      >;
      peers: PeerSpawner;
      lifecycle: Pick<SessionLifecycleController, "stopSession">;
      eligibility: Pick<
        ApplicationTeamMailboxEligibilityService,
        "checkParticipants"
      >;
    },
  ) {}

  async inspectNewMemberReplay(
    input: TeamMemberSpawnReservationInput,
    principal: PeerSessionSpawnPrincipal,
    dispatchIntent: TeamMemberDispatchIntent,
  ): Promise<TeamMemberLaunchResult | null> {
    const reservation = await this.deps.teams.findMemberSpawnReplay(input);
    return reservation
      ? this.redrivePersistedReplay(
          reservation,
          principal,
          dispatchIntent,
          () => this.deps.teams.findMemberSpawnReplay(input),
        )
      : null;
  }

  async inspectMemberRevivalReplay(
    input: {
      teamId: string;
      name: string;
      prompt?: string | null;
    },
    principal: PeerSessionSpawnPrincipal,
  ): Promise<TeamMemberLaunchResult | null> {
    const reservation = await this.deps.teams.findMemberRevivalReplay(input);
    if (!reservation) return null;
    const dispatchIntent = revivalDispatchIntent(
      reservation.member,
      input.prompt,
    );
    if (!dispatchIntent) {
      return {
        status: "error",
        httpStatus: 409,
        message:
          "teammate revival replay is missing its durable predecessor identity",
      };
    }
    return this.redrivePersistedReplay(
      reservation,
      principal,
      dispatchIntent,
      () => this.deps.teams.findMemberRevivalReplay(input),
    );
  }

  async startNewMember(input: {
    reservation: TeamMemberSpawnReservationInput;
    agentId: string;
    agentVersion: number;
    peerRequest: unknown;
    principal: PeerSessionSpawnPrincipal;
  }): Promise<TeamMemberLaunchResult> {
    const eligible = await this.checkEligibility(input);
    if (eligible) return eligible;
    const dispatchRecipe = createDispatchRecipe({
      teamId: input.reservation.teamId,
      sessionId: input.reservation.sessionId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      peerRequest: input.peerRequest,
      principal: input.principal,
    });
    if (!dispatchRecipe) return invalidDispatchRecipe();

    const reservation = await this.deps.teams.beginMemberSpawn({
      ...input.reservation,
      dispatchRecipe,
    });
    if (!reservation) {
      return {
        status: "error",
        httpStatus: 409,
        message: `teammate '${input.reservation.name}' could not be reserved because the team or member changed state`,
      };
    }
    const { member, state } = reservation;
    const operationId = member.launch_operation_id?.trim();
    if (!operationId) {
      return {
        status: "error",
        httpStatus: 503,
        message: `teammate '${member.name}' launch reservation is missing its durable operation fence`,
      };
    }
    if (state !== "acquired") {
      return this.redrivePersistedReplay(
        reservation,
        input.principal,
        dispatchIntentFromRequest(dispatchRecipe.request),
        () => this.deps.teams.findMemberSpawnReplay(input.reservation),
        {
          peerAgentId: input.agentId,
          peerAgentVersion: input.agentVersion,
        },
      );
    }

    let spawn: PeerSessionSpawnResult;
    try {
      spawn = await this.deps.peers.spawnPeerSession(
        dispatchRecipe.request,
        input.principal,
        { kind: "team", teamId: input.reservation.teamId },
      );
    } catch {
      return this.acceptPersistedReplay({ ...reservation, state: "in_flight" });
    }
    if (spawn.status === "pending") {
      return this.acceptPersistedReplay({
        ...reservation,
        state: "in_flight",
      });
    }
    if (spawn.status === "error") {
      if (ambiguousPeerFailure(spawn)) {
        return this.acceptPersistedReplay({
          ...reservation,
          state: "in_flight",
        });
      }
      await this.compensateMemberLaunch(
        {
          memberId: member.id,
          sessionId: member.session_id,
          operationId,
        },
        "teammate peer dispatch failed",
      );
      return spawn;
    }

    let promoted = false;
    try {
      promoted = await this.deps.teams.promoteStartingMember({
        memberId: member.id,
        sessionId: member.session_id,
        operationId,
      });
    } catch {
      // The write may have committed before its response was lost. Preserve the
      // recipe so an exact replay can prove or finish activation.
      return this.acceptPersistedReplay({ ...reservation, state: "in_flight" });
    }
    if (!promoted) {
      try {
        const current = await this.deps.teams.findMemberSpawnReplay(
          input.reservation,
        );
        if (current) return this.acceptPersistedReplay(current);
      } catch {
        return this.acceptPersistedReplay({
          ...reservation,
          state: "in_flight",
        });
      }
      await this.compensateMemberLaunch(
        {
          memberId: member.id,
          sessionId: member.session_id,
          operationId,
        },
        "teammate ownership changed during peer dispatch",
      );
      return {
        status: "error",
        httpStatus: 409,
        message: `teammate '${member.name}' changed state while starting`,
      };
    }

    return {
      status: "ok",
      member: { ...member, status: "working" },
      spawn,
    };
  }

  async reviveMember(input: {
    reservation: TeamMemberRevivalReservationInput;
    agentId: string;
    agentVersion: number;
    peerRequest: unknown;
    principal: PeerSessionSpawnPrincipal;
  }): Promise<TeamMemberLaunchResult> {
    const eligible = await this.checkEligibility(input);
    if (eligible) return eligible;
    const dispatchRecipe = createDispatchRecipe({
      teamId: input.reservation.teamId,
      sessionId: input.reservation.sessionId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      peerRequest: input.peerRequest,
      principal: input.principal,
    });
    if (!dispatchRecipe) return invalidDispatchRecipe();

    const reservation = await this.deps.teams.beginMemberRevival({
      ...input.reservation,
      dispatchRecipe,
    });
    if (!reservation) {
      return {
        status: "error",
        httpStatus: 409,
        message: "teammate changed state while revival was being reserved",
      };
    }
    const { member, state } = reservation;
    const operationId = member.launch_operation_id?.trim();
    if (!operationId) {
      return {
        status: "error",
        httpStatus: 503,
        message:
          "teammate revival reservation is missing its durable operation fence",
      };
    }
    if (state !== "acquired") {
      return this.redrivePersistedReplay(
        reservation,
        input.principal,
        dispatchIntentFromRequest(dispatchRecipe.request),
        () =>
          this.deps.teams.findMemberRevivalReplay({
            teamId: input.reservation.teamId,
            name: member.name,
          }),
        {
          peerAgentId: input.agentId,
          peerAgentVersion: input.agentVersion,
        },
      );
    }

    let spawn: PeerSessionSpawnResult;
    try {
      spawn = await this.deps.peers.spawnPeerSession(
        dispatchRecipe.request,
        input.principal,
        { kind: "team", teamId: input.reservation.teamId },
      );
    } catch {
      return this.acceptPersistedReplay({ ...reservation, state: "in_flight" });
    }
    if (spawn.status === "pending") {
      return this.acceptPersistedReplay({
        ...reservation,
        state: "in_flight",
      });
    }
    if (spawn.status === "error") {
      if (ambiguousPeerFailure(spawn)) {
        return this.acceptPersistedReplay({
          ...reservation,
          state: "in_flight",
        });
      }
      await this.compensateMemberLaunch(
        {
          memberId: member.id,
          sessionId: member.session_id,
          operationId,
        },
        "teammate revival peer dispatch failed",
      );
      return spawn;
    }

    let promoted = false;
    try {
      promoted = await this.deps.teams.promoteStartingMember({
        memberId: member.id,
        sessionId: member.session_id,
        operationId,
      });
    } catch {
      return this.acceptPersistedReplay({ ...reservation, state: "in_flight" });
    }
    if (!promoted) {
      try {
        const current = await this.deps.teams.findMemberRevivalReplay({
          teamId: input.reservation.teamId,
          name: member.name,
        });
        if (current) return this.acceptPersistedReplay(current);
      } catch {
        return this.acceptPersistedReplay({
          ...reservation,
          state: "in_flight",
        });
      }
      await this.compensateMemberLaunch(
        {
          memberId: member.id,
          sessionId: member.session_id,
          operationId,
        },
        "teammate revival ownership changed during peer dispatch",
      );
      return {
        status: "error",
        httpStatus: 409,
        message: "teammate changed state while revival was starting",
      };
    }

    return {
      status: "ok",
      member: { ...member, status: "working" },
      spawn,
    };
  }

  private acceptPersistedReplay(
    reservation: TeamMemberLaunchReservation,
  ): TeamMemberLaunchResult {
    const { member, state } = reservation;
    const pending = state !== "active";
    return {
      status: "ok",
      member,
      spawn: {
        status: "ok",
        httpStatus: pending ? 202 : 200,
        body: {
          sessionId: member.session_id,
          reused: true,
          pending,
        },
      },
    };
  }

  private async redrivePersistedReplay(
    reservation: TeamMemberLaunchReservation,
    principal: PeerSessionSpawnPrincipal,
    dispatchIntent: TeamMemberDispatchIntent,
    refresh: () => Promise<TeamMemberLaunchReservation | null>,
    dispatchTarget?: TeamMemberDispatchTarget,
  ): Promise<TeamMemberLaunchResult> {
    const authorityError = persistedReplayAuthorityError(
      reservation,
      principal,
    );
    if (authorityError) return authorityError;
    const payloadError = persistedReplayPayloadError(
      reservation,
      dispatchIntent,
      dispatchTarget,
    );
    if (payloadError) return payloadError;
    if (reservation.state === "active") {
      return this.acceptPersistedReplay(reservation);
    }
    const operationId = reservation.member.launch_operation_id?.trim();
    if (!operationId) {
      return {
        status: "error",
        httpStatus: 409,
        message: "teammate replay lost its durable operation fence",
      };
    }

    let spawn: PeerSessionSpawnResult;
    try {
      spawn = await this.deps.peers.spawnPeerSession(
        reservation.dispatchRecipe.request,
        principal,
        { kind: "team", teamId: reservation.dispatchRecipe.teamId },
      );
    } catch {
      return this.acceptPersistedReplay(reservation);
    }
    if (spawn.status === "pending") {
      return this.acceptPersistedReplay(reservation);
    }
    if (spawn.status === "error") {
      if (ambiguousPeerFailure(spawn)) {
        return this.acceptPersistedReplay(reservation);
      }
      await this.compensateMemberLaunch(
        {
          memberId: reservation.member.id,
          sessionId: reservation.member.session_id,
          operationId,
        },
        "persisted teammate peer dispatch failed",
      );
      return spawn;
    }
    try {
      const promoted = await this.deps.teams.promoteStartingMember({
        memberId: reservation.member.id,
        sessionId: reservation.member.session_id,
        operationId,
      });
      if (promoted) {
        return {
          status: "ok",
          member: { ...reservation.member, status: "working" },
          spawn,
        };
      }
      const current = await refresh();
      if (current) return this.acceptPersistedReplay(current);
      return {
        status: "error",
        httpStatus: 409,
        message: "teammate replay is no longer active",
      };
    } catch {
      return this.acceptPersistedReplay(reservation);
    }
  }

  private async compensateMemberLaunch(
    launch: { memberId: string; sessionId: string; operationId: string },
    reason: string,
  ): Promise<void> {
    try {
      const cleanup = await this.deps.teams.requestMemberLaunchCleanup(launch);
      if (!cleanup) return;
      if (cleanup.action === "unwind") {
        await this.deps.teams.completeMemberLaunchCleanup(launch);
        return;
      }
    } catch {
      // The periodic reconciler will fence an unchanged starting operation.
      return;
    }

    try {
      const stopped = await this.deps.lifecycle.stopSession(launch.sessionId, {
        mode: "purge",
        reason,
        graceMs: 0,
      });
      if (!stopped.confirmed && !stopped.notFound) return;
    } catch {
      // Cleanup intent is durable; leave it for the next periodic redrive.
      return;
    }

    try {
      await this.deps.teams.completeMemberLaunchCleanup(launch);
    } catch {
      // The exact cleanup fence remains durable when finalization is unavailable.
    }
  }

  private async checkEligibility(input: {
    agentId: string;
    agentVersion: number;
    peerRequest: unknown;
    principal: PeerSessionSpawnPrincipal;
  }): Promise<Extract<TeamMemberLaunchResult, { status: "error" }> | null> {
    if (
      !peerRequestTargetsAgent(
        input.peerRequest,
        input.agentId,
        input.agentVersion,
      )
    ) {
      return {
        status: "error",
        httpStatus: 400,
        message:
          "team member dispatch agent/version does not match its eligibility check",
      };
    }
    const result = await this.deps.eligibility.checkParticipants({
      leadSessionId: input.principal.sessionId,
      memberAgentId: input.agentId,
      memberAgentVersion: input.agentVersion,
    });
    if (result.status === "error") return result;
    if (result.agentVersion !== input.agentVersion) {
      return {
        status: "error",
        httpStatus: 409,
        message: "team member agent version changed before launch reservation",
      };
    }
    return null;
  }
}

function peerRequestTargetsAgent(
  request: unknown,
  agentId: string,
  agentVersion: number,
): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "peerAgentId" in request &&
    (request as { peerAgentId?: unknown }).peerAgentId === agentId &&
    "peerAgentVersion" in request &&
    (request as { peerAgentVersion?: unknown }).peerAgentVersion ===
      agentVersion
  );
}

export function buildTeamMemberSpawnPrompt(
  prompt: string,
  planModeRequired: boolean,
): string {
  if (!planModeRequired) return prompt;
  return `${prompt}\n\n# Plan approval required\nYou are in PLAN MODE. Before doing any work: study the task, write a concrete plan, and call submit_plan with it. You cannot claim tasks until the lead approves your plan (you will receive an approval or revision-request message). If revisions are requested, update the plan and submit_plan again.`;
}

export function canonicalTeamMemberIdentity(
  value: unknown,
): { name: string; title: string } | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name ? { name, title: `teammate:${name}` } : null;
}

export function buildTeamMemberRevivalPrompt(input: {
  name: string;
  previousSessionId: string;
  previousStatus: "failed" | "shutdown";
  prompt?: string | null;
}): string {
  return [
    `You are "${input.name}", REVIVED into your team after your previous session (${input.previousSessionId}) ${input.previousStatus === "failed" ? "failed" : "was shut down"}.`,
    "You do not inherit that session's memory — treat the team task list and teammate messages as ground truth for what remains.",
    "Call claim_task to pick up your next unblocked task.",
    input.prompt?.trim() ? `\nLead's instruction: ${input.prompt.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createTeamMemberSessionId(input: {
  teamId: string;
  name: string;
  previousSessionId?: string | null;
}): string {
  const kind = input.previousSessionId ? "revival" : "spawn";
  const canonicalName = input.name.trim();
  const readable =
    canonicalName
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "member";
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        2,
        kind,
        input.teamId,
        canonicalName,
        input.previousSessionId ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `tm2-${readable}-${digest}`;
}

function dispatchIntentFromRequest(
  request: TeamMemberPeerDispatchRecipe["request"],
): TeamMemberDispatchIntent {
  return {
    prompt: request.prompt,
    title: request.title,
    skipSpawn: request.skipSpawn,
    provisionSandbox: request.provisionSandbox,
    sandboxTemplate: request.sandboxTemplate,
  };
}

function revivalDispatchIntent(
  member: TeamMemberRow,
  prompt?: string | null,
): TeamMemberDispatchIntent | null {
  const previousSessionId = member.launch_previous_session_id?.trim();
  const previousStatus = member.launch_previous_status;
  if (
    !previousSessionId ||
    (previousStatus !== "failed" && previousStatus !== "shutdown")
  ) {
    return null;
  }
  return {
    prompt: buildTeamMemberRevivalPrompt({
      name: member.name,
      previousSessionId,
      previousStatus,
      prompt,
    }),
    title: `teammate:${member.name}`,
    skipSpawn: false,
    provisionSandbox: true,
    sandboxTemplate: null,
  };
}

function createDispatchRecipe(input: {
  teamId: string;
  sessionId: string;
  agentId: string;
  agentVersion: number;
  peerRequest: unknown;
  principal: PeerSessionSpawnPrincipal;
}): TeamMemberPeerDispatchRecipe | null {
  const request = objectRecord(input.peerRequest);
  const title =
    typeof request?.title === "string" && request.title.trim()
      ? request.title.trim()
      : null;
  const sandboxTemplate =
    typeof request?.sandboxTemplate === "string" &&
    request.sandboxTemplate.trim()
      ? request.sandboxTemplate.trim()
      : null;
  if (
    !nonEmptyString(input.teamId) ||
    !nonEmptyString(input.sessionId) ||
    !nonEmptyString(input.agentId) ||
    !Number.isSafeInteger(input.agentVersion) ||
    input.agentVersion < 1 ||
    !nonEmptyString(input.principal.userId) ||
    !nonEmptyString(input.principal.projectId) ||
    !nonEmptyString(input.principal.sessionId) ||
    request?.sessionId !== input.sessionId ||
    request.peerAgentId !== input.agentId ||
    request.peerAgentVersion !== input.agentVersion ||
    typeof request.prompt !== "string" ||
    request.parentSessionId !== input.principal.sessionId ||
    input.principal.capabilities.teamId !== input.teamId ||
    input.principal.capabilities.teamRole !== "lead" ||
    !Number.isSafeInteger(input.principal.capabilities.scriptDepth) ||
    input.principal.capabilities.scriptDepth < 0
  ) {
    return null;
  }
  return {
    version: 1,
    teamId: input.teamId,
    principal: {
      userId: input.principal.userId,
      projectId: input.principal.projectId,
      sessionId: input.principal.sessionId,
      capabilities: {
        scriptDepth: input.principal.capabilities.scriptDepth,
        teamId: input.teamId,
        teamRole: "lead",
      },
    },
    request: {
      sessionId: input.sessionId,
      peerAgentId: input.agentId,
      peerAgentVersion: input.agentVersion,
      prompt: request.prompt,
      parentSessionId: input.principal.sessionId,
      title,
      skipSpawn: request.skipSpawn === true,
      provisionSandbox: request.provisionSandbox === true,
      sandboxTemplate,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidDispatchRecipe(): Extract<
  TeamMemberLaunchResult,
  { status: "error" }
> {
  return {
    status: "error",
    httpStatus: 400,
    message:
      "team member dispatch request does not match its reservation and principal",
  };
}

function persistedReplayAuthorityError(
  reservation: TeamMemberLaunchReservation,
  principal: PeerSessionSpawnPrincipal,
): Extract<TeamMemberLaunchResult, { status: "error" }> | null {
  const { dispatchRecipe: recipe, member } = reservation;
  if (
    recipe.teamId !== member.team_id ||
    recipe.request.sessionId !== member.session_id ||
    recipe.request.parentSessionId !== principal.sessionId ||
    recipe.principal.userId !== principal.userId ||
    recipe.principal.projectId !== principal.projectId ||
    recipe.principal.sessionId !== principal.sessionId ||
    recipe.principal.capabilities.scriptDepth !==
      principal.capabilities.scriptDepth ||
    recipe.principal.capabilities.teamId !== principal.capabilities.teamId ||
    recipe.principal.capabilities.teamRole !==
      principal.capabilities.teamRole ||
    principal.capabilities.teamId !== member.team_id ||
    principal.capabilities.teamRole !== "lead"
  ) {
    return {
      status: "error",
      httpStatus: 403,
      message:
        "teammate replay principal does not match the durable launch recipe",
    };
  }
  return null;
}

function persistedReplayPayloadError(
  reservation: TeamMemberLaunchReservation,
  dispatchIntent: TeamMemberDispatchIntent,
  dispatchTarget?: TeamMemberDispatchTarget,
): Extract<TeamMemberLaunchResult, { status: "error" }> | null {
  const persisted = dispatchIntentFromRequest(
    reservation.dispatchRecipe.request,
  );
  if (
    persisted.prompt !== dispatchIntent.prompt ||
    persisted.title !== dispatchIntent.title ||
    persisted.skipSpawn !== dispatchIntent.skipSpawn ||
    persisted.provisionSandbox !== dispatchIntent.provisionSandbox ||
    persisted.sandboxTemplate !== dispatchIntent.sandboxTemplate ||
    (dispatchTarget != null &&
      (reservation.dispatchRecipe.request.peerAgentId !==
        dispatchTarget.peerAgentId ||
        reservation.dispatchRecipe.request.peerAgentVersion !==
          dispatchTarget.peerAgentVersion))
  ) {
    return {
      status: "error",
      httpStatus: 409,
      message:
        "teammate replay request does not match the durable launch recipe",
    };
  }
  return null;
}

function ambiguousPeerFailure(
  result: Extract<PeerSessionSpawnResult, { status: "error" }>,
): boolean {
  return (
    [408, 425, 429].includes(result.httpStatus) ||
    (result.httpStatus >= 500 && result.httpStatus <= 599)
  );
}
