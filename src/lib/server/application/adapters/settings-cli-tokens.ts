import { listRuntimes } from "$lib/server/agents/runtime-registry";
import type {
	SettingsCliRuntimeCatalogReader,
	CliRuntimeReadModel,
} from "$lib/server/application/settings-cli-tokens";

export class LocalSettingsCliRuntimeCatalogReader
	implements SettingsCliRuntimeCatalogReader
{
	listCliRuntimes(): CliRuntimeReadModel[] {
		return listRuntimes()
			.filter((runtime) => runtime.cliAuth)
			.map((runtime) => ({
				id: runtime.id,
				displayName: runtime.agentMetadataFramework,
				cliAuth: {
					provider: runtime.cliAuth!.provider,
					tokenKind: runtime.cliAuth!.tokenKind,
					credentialKind: runtime.cliAuth!.credentialKind,
					...(runtime.cliAuth!.loginStyle
						? { loginStyle: runtime.cliAuth!.loginStyle }
						: {}),
					...(runtime.cliAuth!.envVar ? { envVar: runtime.cliAuth!.envVar } : {}),
					...(runtime.cliAuth!.credentialPath
						? { credentialPath: runtime.cliAuth!.credentialPath }
						: {}),
					...(runtime.cliAuth!.setupCommand
						? { setupCommand: runtime.cliAuth!.setupCommand }
						: {}),
				},
			}));
	}
}
