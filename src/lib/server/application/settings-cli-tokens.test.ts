import { describe, expect, it, vi } from "vitest";
import {
	ApplicationSettingsCliTokensService,
	type CliRuntimeReadModel,
	type SettingsCliCredentialSummaryReader,
	type SettingsCliRuntimeCatalogReader,
} from "$lib/server/application/settings-cli-tokens";

describe("ApplicationSettingsCliTokensService", () => {
	it("loads CLI runtimes and safe credential summaries through ports", async () => {
		const cliRuntimes = [
			{
				id: "codex-cli",
				displayName: "Codex CLI",
				cliAuth: {
					provider: "openai",
					tokenKind: "subscription_oauth",
					credentialKind: "file",
					loginStyle: "auth_file",
				},
			},
			{
				id: "agy-cli",
				displayName: "AGY CLI",
				cliAuth: {
					provider: "google",
					tokenKind: "subscription_oauth",
					credentialKind: "file_bundle",
					loginStyle: "device_code",
				},
			},
			{
				id: "codex-cli-canary",
				displayName: "Codex CLI Canary",
				cliAuth: {
					provider: "openai",
					tokenKind: "subscription_oauth",
					credentialKind: "file",
				},
			},
		] satisfies CliRuntimeReadModel[];
		const runtimes: SettingsCliRuntimeCatalogReader = {
			listCliRuntimes: vi.fn(() => cliRuntimes),
		};
		const credentials: SettingsCliCredentialSummaryReader = {
			getCredentialSummary: vi.fn(async (_userId, provider) => ({
				provider,
				linked: provider === "openai",
				expiresAt: null,
				lastValidatedAt: null,
				status: provider === "openai" ? "valid" : null,
			})),
		};

		const result = await new ApplicationSettingsCliTokensService({
			runtimes,
			credentials,
		}).load({ userId: "user-1" });

		expect(result.cliRuntimes).toHaveLength(3);
		expect(result.tokensByProvider).toEqual({
			openai: {
				provider: "openai",
				linked: true,
				expiresAt: null,
				lastValidatedAt: null,
				status: "valid",
			},
			google: {
				provider: "google",
				linked: false,
				expiresAt: null,
				lastValidatedAt: null,
				status: null,
			},
		});
		expect(credentials.getCredentialSummary).toHaveBeenCalledTimes(2);
	});

	it("does not query credentials without a signed-in user and tolerates summary failures", async () => {
		const cliRuntimes = [
			{
				id: "codex-cli",
				displayName: "Codex CLI",
				cliAuth: {
					provider: "openai",
					tokenKind: "subscription_oauth",
					credentialKind: "file",
				},
			},
		] satisfies CliRuntimeReadModel[];
		const runtimes: SettingsCliRuntimeCatalogReader = {
			listCliRuntimes: vi.fn(() => cliRuntimes),
		};
		const credentials: SettingsCliCredentialSummaryReader = {
			getCredentialSummary: vi.fn(async () => {
				throw new Error("db down");
			}),
		};
		const service = new ApplicationSettingsCliTokensService({
			runtimes,
			credentials,
		});

		await expect(service.load({ userId: null })).resolves.toEqual({
			cliRuntimes: runtimes.listCliRuntimes(),
			tokensByProvider: {},
		});
		expect(credentials.getCredentialSummary).not.toHaveBeenCalled();

		await expect(service.load({ userId: "user-1" })).resolves.toEqual({
			cliRuntimes: runtimes.listCliRuntimes(),
			tokensByProvider: {
				openai: {
					provider: "openai",
					linked: false,
					expiresAt: null,
					lastValidatedAt: null,
					status: null,
				},
			},
		});
	});
});
