import {
	listRuntimes,
	type RuntimeCliAuth,
} from "$lib/server/agents/runtime-registry";
import type {
	RuntimeRegistryReader,
	SessionRuntimeCliAuthReadModel,
} from "$lib/server/application/ports";

function toCliAuthReadModel(auth: RuntimeCliAuth): SessionRuntimeCliAuthReadModel {
	return {
		provider: auth.provider,
		credentialKind: auth.credentialKind,
		setupCommand: auth.setupCommand ?? null,
	};
}

export class LocalRuntimeRegistryReader implements RuntimeRegistryReader {
	async listSessionRuntimeCliAuth(): Promise<
		Record<string, SessionRuntimeCliAuthReadModel>
	> {
		return Object.fromEntries(
			listRuntimes()
				.filter((runtime) => runtime.cliAuth)
				.map((runtime) => [
					runtime.id,
					toCliAuthReadModel(runtime.cliAuth as RuntimeCliAuth),
				]),
		);
	}
}
