import type {
	BrowserRuntimeClient,
	SessionBrowserResult,
	SessionBrowserScreenshot,
	SessionBrowserService,
	SessionBrowserState,
	WorkflowDataService,
} from "$lib/server/application/ports";

type SessionBrowserDependencies = {
	workflowData: Pick<WorkflowDataService, "getSessionBrowserTarget">;
	browserRuntime: BrowserRuntimeClient;
	now?: () => Date;
};

export class ApplicationSessionBrowserService implements SessionBrowserService {
	constructor(private readonly deps: SessionBrowserDependencies) {}

	async getState(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserResult<SessionBrowserState>> {
		const target = await this.deps.workflowData.getSessionBrowserTarget(input);
		if (!target) return { status: "not_found" };

		const state = await this.deps.browserRuntime.getState({
			agentSlug: target.agentSlug,
		});
		if (!state) return { status: "not_ready" };

		return {
			status: "ok",
			data: {
				...state,
				lastUpdatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
			},
		};
	}

	async takeScreenshot(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserResult<SessionBrowserScreenshot>> {
		const target = await this.deps.workflowData.getSessionBrowserTarget(input);
		if (!target) return { status: "not_found" };

		const shot = await this.deps.browserRuntime.takeScreenshot({
			agentSlug: target.agentSlug,
		});
		if (!shot) return { status: "not_ready" };

		return {
			status: "ok",
			data: {
				jpeg: shot.jpeg,
				contentType: "image/jpeg",
			},
		};
	}
}
