import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationCliCredentialsService,
	type HostCliCredentialStore,
	type UserCliCredentialStore,
} from "$lib/server/application/cli-credentials";

describe("ApplicationCliCredentialsService", () => {
	let userStore: UserCliCredentialStore;
	let hostStore: HostCliCredentialStore;
	let service: ApplicationCliCredentialsService;
	const now = new Date("2026-01-01T00:00:00.000Z");

	beforeEach(() => {
		userStore = {
			getCredential: vi.fn(async () => null),
			upsertCredential: vi.fn(async () => undefined),
			deleteCredential: vi.fn(async () => true),
			getCredentialSummary: vi.fn(async (_userId, provider) => ({
				provider,
				linked: false,
				expiresAt: null,
				lastValidatedAt: null,
				status: null,
			})),
			acquireBootLease: vi.fn(async () => true),
			releaseBootLease: vi.fn(async () => undefined),
		};
		hostStore = {
			isEnabled: vi.fn(() => false),
			getProviderCredential: vi.fn(async () => null),
			captureProviderCredential: vi.fn(async () => null),
			acquireBootLease: vi.fn(async () => true),
			releaseBootLease: vi.fn(async () => undefined),
		};
		service = new ApplicationCliCredentialsService({
			userStore,
			hostStore,
			now: () => now,
			sleep: vi.fn(async () => undefined),
		});
	});

	it("stores validated credentials through the user credential port with a default expiry", async () => {
		await expect(
			service.upsertUserCredential("user-1", "unknown-provider", "x".repeat(24)),
		).resolves.toMatchObject({
			provider: "unknown-provider",
			linked: true,
			status: "active",
			expiresAt: "2026-12-30T00:00:00.000Z",
		});

		expect(userStore.upsertCredential).toHaveBeenCalledWith({
			userId: "user-1",
			provider: "unknown-provider",
			token: "x".repeat(24),
			expiresAt: new Date("2026-12-30T00:00:00.000Z"),
			updatedAt: now,
		});
	});

	it("uses the host credential store for single-use-refresh provider reads and captures when enabled", async () => {
		vi.mocked(hostStore.isEnabled).mockReturnValue(true);
		vi.mocked(hostStore.getProviderCredential).mockResolvedValue({
			token: JSON.stringify({ tokens: { access_token: "a" } }),
			ownerUserId: "host-user",
			expiresAt: null,
		});
		vi.mocked(hostStore.captureProviderCredential).mockResolvedValue("host-user");

		await expect(
			service.getUserCredential("preview-user", "openai"),
		).resolves.toMatchObject({
			status: "active",
			token: JSON.stringify({ tokens: { access_token: "a" } }),
		});
		await expect(
			service.upsertUserCredential(
				"preview-user",
				"openai",
				JSON.stringify({ tokens: { refresh_token: "r" } }),
			),
		).resolves.toMatchObject({
			provider: "openai",
			linked: true,
			status: "active",
		});

		expect(userStore.getCredential).not.toHaveBeenCalled();
		expect(userStore.upsertCredential).not.toHaveBeenCalled();
		expect(hostStore.captureProviderCredential).toHaveBeenCalledWith(
			"openai",
			JSON.stringify({ tokens: { refresh_token: "r" } }),
		);
	});

	it("serializes single-use-refresh boot leases against the host owner when enabled", async () => {
		vi.mocked(hostStore.isEnabled).mockReturnValue(true);
		vi.mocked(hostStore.getProviderCredential).mockResolvedValue({
			token: JSON.stringify({ tokens: { access_token: "a" } }),
			ownerUserId: "host-user",
			expiresAt: null,
		});

		await expect(
			service.acquireBootLease("preview-user", "openai", "session-1", {
				staleMs: 10_000,
				timeoutMs: 1,
			}),
		).resolves.toBe(true);
		await service.releaseBootLease("preview-user", "openai", "session-1");

		expect(hostStore.acquireBootLease).toHaveBeenCalledWith({
			ownerUserId: "host-user",
			provider: "openai",
			sessionId: "session-1",
			staleSecs: 10,
		});
		expect(hostStore.releaseBootLease).toHaveBeenCalledWith({
			ownerUserId: "host-user",
			provider: "openai",
			sessionId: "session-1",
		});
		expect(userStore.acquireBootLease).not.toHaveBeenCalled();
	});

	it("does not touch lease stores for providers without single-use refresh tokens", async () => {
		await expect(
			service.acquireBootLease("user-1", "anthropic", "session-1"),
		).resolves.toBe(true);
		await service.releaseBootLease("user-1", "anthropic", "session-1");

		expect(userStore.acquireBootLease).not.toHaveBeenCalled();
		expect(userStore.releaseBootLease).not.toHaveBeenCalled();
		expect(hostStore.acquireBootLease).not.toHaveBeenCalled();
		expect(hostStore.releaseBootLease).not.toHaveBeenCalled();
	});
});
