export class ApplicationCatalogFunctionDefinitionError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationCatalogFunctionDefinitionError";
	}
}

export type CatalogFunctionDefinitionReader = {
	getCodeFunctionDefinition(input: {
		name: string;
		version: string;
		userId: string;
	}): Promise<Record<string, unknown> | null>;
	getPieceFunctionDefinition(
		name: string,
	): Promise<Record<string, unknown> | null>;
};

export class ApplicationCatalogFunctionDefinitionService {
	constructor(private readonly reader: CatalogFunctionDefinitionReader) {}

	async getDefinition(input: {
		name: string;
		version: string;
		userId?: string | null;
	}): Promise<Record<string, unknown>> {
		if (input.userId) {
			const codeDefinition = await this.reader.getCodeFunctionDefinition({
				name: input.name,
				version: input.version,
				userId: input.userId,
			});
			if (codeDefinition) return codeDefinition;
		}

		let pieceDefinition: Record<string, unknown> | null;
		try {
			pieceDefinition = await this.reader.getPieceFunctionDefinition(input.name);
		} catch (err) {
			throw new ApplicationCatalogFunctionDefinitionError(502, String(err));
		}

		if (!pieceDefinition) {
			throw new ApplicationCatalogFunctionDefinitionError(
				404,
				"Function not found",
			);
		}

		return pieceDefinition;
	}
}
