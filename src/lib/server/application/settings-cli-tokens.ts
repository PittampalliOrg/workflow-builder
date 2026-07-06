export type CliCredentialSummaryReadModel = {
	provider: string;
	linked: boolean;
	expiresAt: string | null;
	lastValidatedAt: string | null;
	status: string | null;
};

export type CliRuntimeAuthReadModel = {
	provider: string;
	tokenKind: string;
	credentialKind: "env_token" | "file" | "file_bundle" | "device_login";
	loginStyle?: "browser_token" | "auth_file" | "device_code" | "api_key";
	envVar?: string;
	credentialPath?: string;
	setupCommand?: string;
};

export type CliRuntimeReadModel = {
	id: string;
	displayName: string;
	cliAuth: CliRuntimeAuthReadModel;
};

export type SettingsCliTokensPageReadModel = {
	cliRuntimes: CliRuntimeReadModel[];
	tokensByProvider: Record<string, CliCredentialSummaryReadModel>;
};

export type SettingsCliRuntimeCatalogReader = {
	listCliRuntimes(): CliRuntimeReadModel[];
};

export type SettingsCliCredentialSummaryReader = {
	getCredentialSummary(
		userId: string,
		provider: string,
	): Promise<CliCredentialSummaryReadModel>;
};

export class ApplicationSettingsCliTokensService {
	constructor(
		private readonly deps: {
			runtimes: SettingsCliRuntimeCatalogReader;
			credentials: SettingsCliCredentialSummaryReader;
		},
	) {}

	async load(input: {
		userId?: string | null;
	}): Promise<SettingsCliTokensPageReadModel> {
		const cliRuntimes = this.deps.runtimes.listCliRuntimes();
		const userId = input.userId ?? null;
		const providers = [...new Set(cliRuntimes.map((runtime) => runtime.cliAuth.provider))];
		const tokenEntries = userId
			? await Promise.all(
					providers.map(async (provider) => {
						try {
							return await this.deps.credentials.getCredentialSummary(
								userId,
								provider,
							);
						} catch {
							return emptySummary(provider);
						}
					}),
				)
			: [];

		return {
			cliRuntimes,
			tokensByProvider: Object.fromEntries(
				tokenEntries.map((entry) => [entry.provider, entry]),
			),
		};
	}
}

function emptySummary(provider: string): CliCredentialSummaryReadModel {
	return {
		provider,
		linked: false,
		expiresAt: null,
		lastValidatedAt: null,
		status: null,
	};
}
