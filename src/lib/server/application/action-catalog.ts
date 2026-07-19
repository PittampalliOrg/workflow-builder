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

export type ActionCatalogCapabilityReader = {
	actionAvailability(slug: string): {
		available: boolean;
		code: string;
		message: string | null;
	};
};

export class ApplicationActionCatalogService {
	constructor(
		private readonly reader: ActionCatalogReader,
		private readonly capabilities?: ActionCatalogCapabilityReader,
	) {}

	async loadSnapshot(input: { userId: string | null }): Promise<unknown> {
		const snapshot = await this.reader.loadSnapshot(input.userId);
		if (!isRecord(snapshot) || !Array.isArray(snapshot.items)) return snapshot;
		return {
			...snapshot,
			items: snapshot.items.map((item) => this.applyAvailability(item)),
		};
	}

	async getDetail(input: {
		actionId: string;
		userId: string | null;
	}): Promise<Record<string, unknown> | null> {
		const action = await this.reader.getDetail(input.actionId, input.userId);
		if (!action) return null;

		const raw = isRecord(action.raw) ? action.raw : null;
		return this.applyAvailability({
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
		});
	}

	private applyAvailability<T>(value: T): T {
		if (!isRecord(value) || !this.capabilities) return value;
		const slug = actionSlug(value);
		if (!slug) return value;
		const availability = this.capabilities.actionAvailability(slug);
		if (availability.available) return value;

		const warning = `${availability.code}: ${availability.message ?? `${slug} is unavailable`}`;
		const warnings = Array.isArray(value.warnings)
			? value.warnings.filter((item): item is string => typeof item === "string")
			: [];
		const runtime = isRecord(value.runtime)
			? {
					...value.runtime,
					ready: false,
					errors: appendUniqueStrings(value.runtime.errors, warning),
				}
			: value.runtime;

		return {
			...value,
			insertable: false,
			ready: false,
			warnings: appendUniqueStrings(warnings, warning),
			availability,
			...(runtime === undefined ? {} : { runtime }),
		} as T;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function actionSlug(value: Record<string, unknown>): string | null {
	for (const candidate of [value.slug, value.name, value.actionName]) {
		if (typeof candidate === "string" && candidate.includes("/")) {
			return candidate.trim();
		}
	}
	const functionRef = isRecord(value.functionRef) ? value.functionRef : null;
	return typeof functionRef?.name === "string" ? functionRef.name.trim() : null;
}

function appendUniqueStrings(value: unknown, item: string): string[] {
	const items = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
	return items.includes(item) ? items : [...items, item];
}
