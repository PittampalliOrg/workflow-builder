export type ActionCatalogDetailReadModel = Record<string, unknown> & {
	version: string | null;
	raw?: Record<string, unknown> | null;
	sw: {
		functionName: string | null;
		definition: Record<string, unknown> | null;
		taskConfig: Record<string, unknown> | null;
	};
};

export type ActionCatalogReader = {
	loadSnapshot(userId: string | null): Promise<unknown>;
	getDetail(
		actionId: string,
		userId: string | null,
	): Promise<ActionCatalogDetailReadModel | null>;
};

export class ApplicationActionCatalogService {
	constructor(private readonly reader: ActionCatalogReader) {}

	loadSnapshot(input: { userId: string | null }): Promise<unknown> {
		return this.reader.loadSnapshot(input.userId);
	}

	async getDetail(input: {
		actionId: string;
		userId: string | null;
	}): Promise<Record<string, unknown> | null> {
		const action = await this.reader.getDetail(input.actionId, input.userId);
		if (!action) return null;

		const raw = isRecord(action.raw) ? action.raw : null;
		return {
			...action,
			definition: action.sw.definition,
			taskConfig: action.sw.taskConfig,
			functionRef: action.sw.functionName
				? {
						name: action.sw.functionName,
						version: action.version,
					}
				: null,
			...(raw ?? {}),
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
