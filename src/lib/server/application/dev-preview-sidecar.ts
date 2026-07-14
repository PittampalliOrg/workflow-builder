import type { SidecarLastRunView } from '$lib/types/dev-previews';
import type {
	DevEnvironmentSummaryReadModel,
	DevPreviewSidecarPort,
	DevPreviewSidecarRunOutput,
	DevPreviewSidecarSyncOutput,
	DevPreviewSyncTimings
} from '$lib/server/application/ports';

/** The dev-service card view of a sidecar `/__status`: the raw `lastRun` parsed
 * into a stable shape, everything else forwarded. */
export type DevSidecarStatusData = {
	ok: boolean;
	dest?: string;
	lastSyncAt: string | null;
	lastSyncBytes: number | null;
	lastSyncTimingsMs: DevPreviewSyncTimings | null;
	commands: string[];
	lastRun: SidecarLastRunView | null;
};

export type DevSidecarStatusView = {
	service: string;
	status:
		| { ok: true; data: DevSidecarStatusData }
		| { ok: false; reason: string; message?: string };
	allowedCommands: string[];
};

export type DevSidecarRunView = {
	service: string;
	cmd: string;
	result:
		| { ok: true; data: DevPreviewSidecarRunOutput }
		| { ok: false; reason: string; message?: string };
};

export type DevSidecarSyncView = {
	service: string;
	result:
		| { ok: true; data: DevPreviewSidecarSyncOutput }
		| { ok: false; reason: string; message?: string };
};

/** Parse the sidecar's raw `lastRun` ({ name, exitCode, durationMs, executedIn,
 * finishedAt }) into the UI view. Returns null for absent/garbage. */
export function parseSidecarLastRun(raw: unknown): SidecarLastRunView | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const cmd = typeof r.name === 'string' ? r.name : typeof r.cmd === 'string' ? r.cmd : null;
	if (!cmd) return null;
	return {
		cmd,
		exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
		durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
		executedIn: r.executedIn === 'app' || r.executedIn === 'sidecar' ? r.executedIn : null,
		finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : null
	};
}

export type DevPreviewSidecarServiceDeps = {
	sidecar: DevPreviewSidecarPort;
	/** Project-scoped dev environment read model (the pod address source of
	 * truth — never caller input). Injected to keep the service port-pure. */
	listEnvironments: (input: {
		projectId: string | null | undefined;
	}) => Promise<DevEnvironmentSummaryReadModel[]>;
};

/**
 * B5 dev-sync-sidecar control for the Dev hub, absorbing the identical env-lookup
 * both sidecar routes did (resolve the project-scoped preview row, then reach its
 * pod). Returns `null` when the (executionId, service) pair isn't an active
 * preview for the project → the route/remote maps that to a 404.
 */
export class ApplicationDevPreviewSidecarService {
	constructor(private readonly deps: DevPreviewSidecarServiceDeps) {}

	allowedCommands(service: string): string[] {
		return this.deps.sidecar.allowedCommands(service);
	}

	private async resolve(input: {
		executionId: string;
		service: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null> {
		const environments = await this.deps.listEnvironments({
			projectId: input.projectId
		});
		return (
			environments.find(
				(e) => e.executionId === input.executionId && e.service === input.service
			) ?? null
		);
	}

	async status(input: {
		executionId: string;
		service: string;
		projectId: string | null | undefined;
	}): Promise<DevSidecarStatusView | null> {
		const environment = await this.resolve(input);
		if (!environment) return null;
		const status = await this.deps.sidecar.status({
			syncUrl: environment.syncUrl,
			executionId: environment.executionId,
			service: environment.service
		});
		const allowedCommands = this.deps.sidecar.allowedCommands(environment.service);
		if (!status.ok) {
			return {
				service: environment.service,
				status: { ok: false, reason: status.reason, message: status.message },
				allowedCommands
			};
		}
		const d = status.data;
		return {
			service: environment.service,
			status: {
				ok: true,
				data: {
					ok: d.ok,
					dest: d.dest,
					lastSyncAt: d.lastSyncAt ?? null,
					lastSyncBytes: d.lastSyncBytes ?? null,
					lastSyncTimingsMs: d.lastSyncTimingsMs ?? null,
					commands: d.commands ?? [],
					lastRun: parseSidecarLastRun(d.lastRun)
				}
			},
			allowedCommands
		};
	}

	async run(input: {
		executionId: string;
		service: string;
		projectId: string | null | undefined;
		cmd: string;
	}): Promise<DevSidecarRunView | null> {
		const environment = await this.resolve(input);
		if (!environment) return null;
		const result = await this.deps.sidecar.run({
			syncUrl: environment.syncUrl,
			executionId: environment.executionId,
			service: environment.service,
			cmd: input.cmd
		});
		return {
			service: environment.service,
			cmd: input.cmd,
			result: result.ok
				? { ok: true, data: result.data }
				: { ok: false, reason: result.reason, message: result.message }
		};
	}

	async sync(input: {
		executionId: string;
		service: string;
		projectId: string | null | undefined;
		archive: ArrayBuffer | Uint8Array;
		contentType?: string | null;
	}): Promise<DevSidecarSyncView | null> {
		const environment = await this.resolve(input);
		if (!environment) return null;
		const result = await this.deps.sidecar.sync({
			syncUrl: environment.syncUrl,
			executionId: environment.executionId,
			service: environment.service,
			archive: input.archive,
			contentType: input.contentType
		});
		return {
			service: environment.service,
			result: result.ok
				? { ok: true, data: result.data }
				: { ok: false, reason: result.reason, message: result.message }
		};
	}
}
