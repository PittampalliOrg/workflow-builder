// Ports for the Dev hub preview surfaces (Track 1): the Tier-2 vcluster preview
// gateway and the per-service dev-sync-sidecar. These wrap the privileged
// legacy clients (`$lib/server/workflows/{vcluster-preview,dev-preview-sidecar}`)
// so the four dev routes stop importing legacy domain modules directly.

import type {
	VclusterPreviewCounts,
	VclusterPreviewRecord,
} from "$lib/types/dev-previews";

/** A4 activity/wake outcome: whether a resume Job was started for a slept preview. */
export type VclusterPreviewTouchResult = {
	name: string;
	state: string;
	resuming: boolean;
	lastActive: string | null;
};

/** A4 sleep outcome at the gateway boundary. A 409 (protected preview, or a
 * free/recycling pool member that stays claim-ready) is data — `{ok:false,
 * status:409}` — not an exception; other HTTP failures still throw. */
export type VclusterPreviewSleepOutcome =
	| { ok: true; name: string; alreadySlept: boolean }
	| { ok: false; status: number; detail: string };

/** Lifecycle labels accepted by claim/provision (all optional). */
export type VclusterPreviewLifecycleInput = {
	origin?: "user" | "pr";
	prNumber?: number;
	ttlHours?: number;
};

/**
 * Privileged Tier-2 (vcluster full-isolation) preview gateway. Mirrors the
 * legacy client verbs, but returns the serializable `VclusterPreviewRecord`
 * (not the legacy shape) and turns the sleep 409 into data. The capacity-
 * admission policy lives ABOVE this port, in `ApplicationVclusterPreviewService`.
 */
export interface VclusterPreviewGatewayPort {
	/** List active previews + A3/A4 capacity counts (null against an older SEA). */
	listWithCounts(): Promise<{
		previews: VclusterPreviewRecord[];
		counts: VclusterPreviewCounts | null;
	}>;
	/** Current status of one preview (accepts a claimed alias). */
	get(name: string): Promise<VclusterPreviewRecord>;
	/** A3 warm-pool claim (instant, no capacity gate); null when the pool is
	 * empty/off → the service cold-provisions instead. */
	claim(
		input: { name: string; user?: string } & VclusterPreviewLifecycleInput,
	): Promise<VclusterPreviewRecord | null>;
	/** Cold-provision (ACTION=up). Capacity gating is the service's job. */
	provision(
		input: { name: string } & VclusterPreviewLifecycleInput,
	): Promise<VclusterPreviewRecord>;
	/** Tear down (drops the per-preview DB + `vcluster delete`). */
	teardown(name: string): Promise<VclusterPreviewRecord>;
	/** A4 activity ping + wake: stamps last-active, resumes a slept preview. */
	touch(name: string): Promise<VclusterPreviewTouchResult>;
	/** A4 explicit sleep; refusal (409) returned as data. */
	sleep(name: string): Promise<VclusterPreviewSleepOutcome>;
}

/** Raw dev-sync-sidecar `/__status` body (before the service parses `lastRun`). */
export type DevPreviewSidecarStatus = {
	ok: boolean;
	service?: string;
	dest?: string;
	lastSyncAt?: string | null;
	lastSyncBytes?: number | null;
	lastRun?: unknown;
	commands?: string[];
};

export type DevPreviewSidecarRunOutput = {
	ok: boolean;
	cmd: string;
	exitCode: number | null;
	durationMs: number | null;
	truncated: boolean;
	output: string;
	/** #40: where the command ran ("app" bridge vs "sidecar" node fallback). */
	executedIn: "app" | "sidecar" | null;
};

export type DevPreviewSidecarSyncOutput = {
	ok: boolean;
	status: number;
	bytes: number;
	body: unknown;
};

/** Sidecar reachability outcome: unreachable/plugin-mode pods are data, not throws. */
export type DevPreviewSidecarResult<T> =
	| { ok: true; data: T }
	| {
			ok: false;
			reason: "no-sidecar" | "unreachable" | "bad-response" | "forbidden";
			message?: string;
	  };

/** Per-service dev pod control channel (B5). Wraps the pod-IP `/__status` /
 * `/__run` calls the BFF makes with the shared sync token. */
export interface DevPreviewSidecarPort {
	status(input: {
		syncUrl: string | null | undefined;
	}): Promise<DevPreviewSidecarResult<DevPreviewSidecarStatus>>;
	run(input: {
		syncUrl: string | null | undefined;
		service: string;
		cmd: string;
	}): Promise<DevPreviewSidecarResult<DevPreviewSidecarRunOutput>>;
	sync(input: {
		syncUrl: string | null | undefined;
		archive: ArrayBuffer | Uint8Array;
		contentType?: string | null;
	}): Promise<DevPreviewSidecarResult<DevPreviewSidecarSyncOutput>>;
	/** Registry-declared allowlisted command names for a service (deny = []). */
	allowedCommands(service: string): string[];
}
