import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

export type GitOpsActivityEventListOptions = {
	limit?: number;
	since?: string | null;
	afterSequence?: number | null;
	ascending?: boolean;
};

export type GitOpsActivityEventStore = {
	ingest(payload: unknown): Promise<GitOpsActivityEvent>;
	list(options?: GitOpsActivityEventListOptions): Promise<GitOpsActivityEvent[]>;
	getLatestSequence(): Promise<number>;
	subscribe(onEvent: () => void): Promise<() => Promise<void>>;
};

export class ApplicationGitOpsActivityEventService {
	constructor(private readonly store: GitOpsActivityEventStore) {}

	ingest(payload: unknown): Promise<GitOpsActivityEvent> {
		return this.store.ingest(payload);
	}

	list(
		options: GitOpsActivityEventListOptions = {},
	): Promise<GitOpsActivityEvent[]> {
		return this.store.list(options);
	}

	getLatestSequence(): Promise<number> {
		return this.store.getLatestSequence();
	}

	subscribe(onEvent: () => void): Promise<() => Promise<void>> {
		return this.store.subscribe(onEvent);
	}
}
