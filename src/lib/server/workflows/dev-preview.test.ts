import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewDatabaseProvisioner } from '$lib/server/application/ports';
import {
	captureAllDevPreviewSources,
	provisionDevPreview,
	provisionDevPreviews,
	replaceDevPreviewImages,
	type DevPreviewPersistence
} from './dev-preview';
import {
	devPreviewCaptureMappings,
	DEV_PREVIEW_CATALOG_DIGEST,
	resolveDevPreviewDescriptor
} from './dev-preview-registry';

function fakePersistence(
	rows: Array<{
		workspaceRef: string;
		sandboxState: Record<string, unknown> | null;
	}> = []
): DevPreviewPersistence {
	return {
		upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
			workspaceRef: input.workspaceRef
		})),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => rows),
		markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
		getExecutionById: vi.fn(async () => ({
			id: 'exec-1',
			userId: 'user-1',
			projectId: 'project-1'
		})),
		persistSourceBundleArtifact: vi.fn(async () => ({
			id: 'artifact-1',
			fileId: 'file-1',
			bytes: 12
		}))
	};
}

function fakePreviewDatabases(): PreviewDatabaseProvisioner {
	return {
		provision: vi.fn(async () => ({
			databaseUrl: 'postgres://preview-db',
			sourceUrl: 'postgres://source-db',
			dbName: 'preview_exec1'
		})),
		drop: vi.fn(async () => undefined)
	};
}

describe('dev-preview portability boundary', () => {
	beforeEach(() => {
		const sha = 'a'.repeat(40);
		vi.stubEnv(
			'WORKFLOW_BUILDER_DEV_IMAGE',
			`ghcr.io/pittampalliorg/workflow-builder-dev:git-${sha}`
		);
		vi.stubEnv(
			'WORKFLOW_ORCHESTRATOR_DEV_IMAGE',
			`ghcr.io/pittampalliorg/workflow-orchestrator-dev:git-${sha}`
		);
		vi.stubEnv(
			'FUNCTION_ROUTER_DEV_IMAGE',
			`ghcr.io/pittampalliorg/function-router-dev:git-${sha}`
		);
		vi.stubEnv('PREVIEW_DEV_SYNC_MINT_TOKEN', '');
		vi.stubEnv('WFB_DEV_SYNC_TOKEN', '1'.repeat(64));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('keeps dev-preview persistence behind an injected port', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'dev-preview.ts'),
			'utf8'
		);

		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toContain('$lib/server/db/schema');
		expect(source).not.toContain('drizzle-orm');
		expect(source).not.toContain('from "postgres"');
		expect(source).not.toContain('workflows/preview-database');
		expect(source).not.toContain('$lib/server/files/registry');
		expect(source).not.toContain('persistSourceBundle(');
	});

	it('persists provisioned preview sessions through the injected port', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: 'dev-preview-exec-1',
						podIP: '10.0.0.12',
						port: 8080,
						syncPort: 8001,
						url: 'http://10.0.0.12:8080',
						syncUrl: 'http://10.0.0.12:8001/__sync',
						ready: true,
						status: 'running'
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);
		const persistence = fakePersistence();

		const info = await provisionDevPreview(
			{
				executionId: 'exec-1',
				service: 'function-router'
			},
			persistence
		);

		expect(info.sandboxName).toBe('dev-preview-exec-1');
		expect(fetchMock).toHaveBeenCalledWith(
			'http://sandbox-api/internal/dev-preview',
			expect.objectContaining({ method: 'POST' })
		);
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const requestBody = JSON.parse(String(request.body));
		expect(requestBody.syncToken).toMatch(/^[a-f0-9]{64}$/);
		expect(requestBody.syncAgentToken).toMatch(/^[a-f0-9]{64}$/);
		expect(requestBody.syncToken).not.toBe(requestBody.syncAgentToken);
		expect(info.syncCapability).toBe(requestBody.syncAgentToken);
		expect(requestBody.devSyncAllowedRoots).toEqual([
			'.preview-capture/development.Dockerfile',
			'.preview-capture/production.Dockerfile',
			'config',
			'package.json',
			'pnpm-lock.yaml',
			'src'
		]);
		expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceRef: 'dev-preview-exec-1',
				workflowExecutionId: 'exec-1',
				name: 'dev-preview',
				backend: 'juicefs',
				status: 'active'
			})
		);
	});

	it('fails closed before provisioning when the server sync token is absent', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		vi.stubEnv('WFB_DEV_SYNC_TOKEN', '');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			provisionDevPreview({ executionId: 'exec-1', service: 'function-router' }, fakePersistence())
		).rejects.toThrow('Dev-sync credential authority is not configured');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('forces applyDaprShadowDefaults:false for a preview-native provision', async () => {
		// The workflow-orchestrator descriptor does NOT set applyDaprShadowDefaults,
		// so pre-fix the request omitted it and the SEA default (true) injected
		// PUBSUB_NAME=pubsub-dev into a vcluster whose component is named `pubsub`.
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
						podIP: '10.0.0.13',
						port: 8080,
						syncPort: 8001,
						ready: true,
						status: 'running'
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		await provisionDevPreview(
			{
				executionId: 'exec-1',
				service: 'workflow-orchestrator',
				mode: 'preview-native'
			},
			fakePersistence()
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.previewNative).toBe(true);
		expect(body.applyDaprShadowDefaults).toBe(false);
		// The host-only shadow pubsub name must NOT leak into a preview-native pod.
		expect(body.env?.PUBSUB_NAME).toBeUndefined();
	});

	it('touches the vcluster preview on a preview-native provision with an origin', async () => {
		// A4: a dev pod landing INSIDE a vcluster preview is activity on that preview —
		// the provision pings SEA's touch endpoint (alias derived from the wfb-<name>
		// origin host) so the lifecycle reaper never sleeps a preview mid-session.
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			calls.push(url);
			if (url.endsWith('/touch'))
				return new Response(
					JSON.stringify({
						name: 'myprev',
						state: 'hot',
						resuming: false
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				);
			return new Response(
				JSON.stringify({
					sandboxName: 'wfb-dev-preview-workflow-builder-exec-1',
					podIP: '10.0.0.13',
					port: 3000,
					syncPort: 3000,
					ready: true,
					status: 'running'
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		await provisionDevPreview(
			{
				executionId: 'exec-1',
				service: 'workflow-builder',
				mode: 'preview-native',
				origin: 'https://wfb-myprev.tail286401.ts.net'
			},
			fakePersistence()
		);

		expect(calls).toContain('http://sandbox-api/internal/vcluster-preview/myprev/touch');
	});

	it('does not touch on a host-throwaway provision or without an origin', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			calls.push(url);
			return new Response(
				JSON.stringify({
					sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
					ready: true,
					status: 'running'
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		// preview-native but NO origin -> no alias to touch.
		await provisionDevPreview(
			{
				executionId: 'exec-1',
				service: 'workflow-orchestrator',
				mode: 'preview-native'
			},
			fakePersistence()
		);
		expect(calls.some((u) => u.endsWith('/touch'))).toBe(false);
	});

	it('omits applyDaprShadowDefaults for a shadow-default host provision', async () => {
		// A host-throwaway orchestrator preview keeps the SEA default (the shadow env
		// IS the host-isolation mechanism there), so the BFF sends no override.
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: 'wfb-dev-preview-exec-1',
						ready: true,
						status: 'running'
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		await provisionDevPreview(
			{ executionId: 'exec-1', service: 'workflow-orchestrator' },
			fakePersistence()
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.previewNative).toBeUndefined();
		expect('applyDaprShadowDefaults' in body).toBe(false);
	});

	it('fans out provisionDevPreviews and keeps successes on partial failure', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(async (_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			if (body.service === 'workflow-orchestrator') {
				return new Response(JSON.stringify({ detail: 'boom' }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify({
					sandboxName: `wfb-dev-preview-${body.service}-exec-1`,
					podIP: '10.0.0.5',
					port: 3000,
					syncPort: 3000,
					ready: true,
					status: 'running'
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const persistence = fakePersistence();

		const result = await provisionDevPreviews(
			{
				executionId: 'exec-1',
				services: ['workflow-builder', 'workflow-orchestrator'],
				mode: 'preview-native'
			},
			persistence
		);

		expect(result.ok).toBe(false);
		const bySvc = Object.fromEntries(result.services.map((s) => [s.service, s]));
		expect(bySvc['workflow-builder'].ok).toBe(true);
		expect(bySvc['workflow-builder'].info?.sandboxName).toBe(
			'wfb-dev-preview-workflow-builder-exec-1'
		);
		expect(bySvc['workflow-orchestrator'].ok).toBe(false);
		expect(bySvc['workflow-orchestrator'].error).toContain('boom');
		// The service that came up is persisted and NOT torn down (session still useful).
		expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledTimes(1);
	});

	it('settles slower peer services before starting an adopted workflow-builder cutover', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const started: string[] = [];
		let finishPeer: ((response: Response) => void) | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String((init as RequestInit).body));
				started.push(body.service);
				if (body.service === 'workflow-orchestrator') {
					return new Promise<Response>((resolve) => {
						finishPeer = resolve;
					});
				}
				return Response.json({
					sandboxName: `wfb-dev-preview-${body.service}-exec-1`,
					ready: true,
					status: 'running'
				});
			})
		);

		const pending = provisionDevPreviews(
			{
				executionId: 'exec-1',
				services: ['workflow-builder', 'workflow-orchestrator'],
				mode: 'preview-native',
				adopt: true
			},
			fakePersistence()
		);
		await vi.waitFor(() => expect(started).toEqual(['workflow-orchestrator']));
		finishPeer?.(
			Response.json({
				sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
				ready: true,
				status: 'running'
			})
		);
		await expect(pending).resolves.toMatchObject({ ok: true });
		expect(started).toEqual(['workflow-orchestrator', 'workflow-builder']);
	});

	it('restores every prior image when one coherent replacement fails', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const oldRouter = `ghcr.io/pittampalliorg/function-router-dev@sha256:${'1'.repeat(64)}`;
		const oldOrchestrator = `ghcr.io/pittampalliorg/workflow-orchestrator-dev@sha256:${'2'.repeat(64)}`;
		const newRouter = `ghcr.io/pittampalliorg/function-router-dev@sha256:${'3'.repeat(64)}`;
		const newOrchestrator = `ghcr.io/pittampalliorg/workflow-orchestrator-dev@sha256:${'4'.repeat(64)}`;
		const rows = [
			{
				workspaceRef: 'sandbox-router',
				sandboxState: {
					details: { service: 'function-router', image: oldRouter }
				}
			},
			{
				workspaceRef: 'sandbox-orchestrator',
				sandboxState: {
					details: {
						service: 'workflow-orchestrator',
						image: oldOrchestrator
					}
				}
			}
		];
		const requestedImages: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String((init as RequestInit).body));
				requestedImages.push(body.image);
				if (body.image === newOrchestrator) {
					return new Response(JSON.stringify({ detail: 'replacement failed' }), {
						status: 503,
						headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(
					JSON.stringify({
						sandboxName: `sandbox-${body.service}`,
						podIP: '10.0.0.5',
						port: body.service === 'workflow-builder' ? 3000 : 8080,
						syncPort: body.service === 'workflow-builder' ? 3000 : 8001,
						ready: true,
						status: 'running'
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			})
		);

		const result = await replaceDevPreviewImages(
			{
				executionId: 'exec-1',
				services: [
					{ service: 'function-router', image: newRouter },
					{ service: 'workflow-orchestrator', image: newOrchestrator }
				],
				mode: 'preview-native',
				adopt: true
			},
			fakePersistence(rows)
		);

		expect(result).toMatchObject({
			ok: false,
			rollback: {
				attempted: true,
				ok: true,
				services: [
					{ service: 'function-router', ok: true },
					{ service: 'workflow-orchestrator', ok: true }
				]
			}
		});
		expect(requestedImages).toEqual([newRouter, newOrchestrator, oldRouter, oldOrchestrator]);
	});

	it('fails closed before replacing the adopted workflow-builder image in place', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			replaceDevPreviewImages(
				{
					executionId: 'exec-1',
					services: [
						{
							service: 'workflow-builder',
							image: `ghcr.io/pittampalliorg/workflow-builder-dev@sha256:${'3'.repeat(64)}`
						}
					],
					mode: 'preview-native',
					adopt: true
				},
				fakePersistence()
			)
		).rejects.toThrow('fresh acceptance preview');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('forwards the sidecar /__run command allowlist + extraSync to SEA', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: 'wfb-dev-preview-workflow-orchestrator-exec-1',
						podIP: '10.0.0.13',
						port: 8080,
						syncPort: 8001,
						ready: true,
						status: 'running'
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		const info = await provisionDevPreview(
			{ executionId: 'exec-1', service: 'workflow-orchestrator' },
			fakePersistence()
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		// deps + the contract test lane travel to SEA (→ DEV_SYNC_COMMANDS_JSON).
		expect(body.devSyncCommands).toEqual({
			deps: 'pip install -r requirements.txt && touch /app/app.py',
			contract: 'python -m pytest tests/test_workflow_data_activity_migration.py -q'
		});
		// The returned info carries the extraSync sources the sync client stages.
		expect(info.extraSync).toEqual([
			{
				from: '../shared/workflow-data-contract',
				to: '.contract-fixtures'
			}
		]);
	});

	it('provisions functional preview databases through the injected port', async () => {
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(async (_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			return new Response(
				JSON.stringify({
					sandboxName: 'dev-preview-exec-1',
					podIP: '10.0.0.12',
					port: 3000,
					syncPort: 3000,
					url: 'http://10.0.0.12:3000',
					syncUrl: 'http://10.0.0.12:3000/__sync',
					ready: true,
					status: 'running',
					serviceSecretEnv: body.serviceSecretEnv
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const persistence = fakePersistence();
		const previewDatabases = fakePreviewDatabases();

		await provisionDevPreview(
			{
				executionId: 'exec-1',
				service: 'workflow-builder'
			},
			persistence,
			previewDatabases
		);

		expect(previewDatabases.provision).toHaveBeenCalledWith({
			executionId: 'exec-1'
		});
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.serviceSecretEnv).toMatchObject({
			DATABASE_URL: 'postgres://preview-db',
			PREVIEW_SOURCE_DATABASE_URL: 'postgres://source-db'
		});
	});

	it('persists the resolved image and reuses it over a newer pin on re-entry', async () => {
		// function-router is a non-functional (no-DB) preview, so it needs no DB provisioner.
		vi.stubEnv('SANDBOX_EXECUTION_API_URL', 'http://sandbox-api');
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: 'wfb-dev-preview-function-router-exec-1',
						podIP: '10.0.0.14',
						port: 8080,
						syncPort: 8001,
						ready: true,
						status: 'running'
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		// First provision: no persisted row, env pins the image → resolver used + persisted.
		const imageV1 = `ghcr.io/pittampalliorg/function-router-dev:git-${'1'.repeat(40)}`;
		const imageV2 = `ghcr.io/pittampalliorg/function-router-dev:git-${'2'.repeat(40)}`;
		vi.stubEnv('FUNCTION_ROUTER_DEV_IMAGE', imageV1);
		const persistence = fakePersistence();
		const first = await provisionDevPreview(
			{ executionId: 'exec-1', service: 'function-router' },
			persistence
		);
		expect(first.image).toBe(imageV1);
		expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sandboxState: {
					details: expect.objectContaining({ image: imageV1 })
				}
			})
		);

		// Re-entry: a persisted row exists AND the env pin moved to a newer image. The
		// persisted image must WIN over the fresh resolution (run stability).
		vi.stubEnv('FUNCTION_ROUTER_DEV_IMAGE', imageV2);
		const reentry = fakePersistence();
		reentry.listWorkflowWorkspaceSessionsByExecutionId = vi.fn(async () => [
			{
				workspaceRef: 'wfb-dev-preview-function-router-exec-1',
				sandboxState: {
					details: { service: 'function-router', image: imageV1 }
				}
			}
		]);
		const second = await provisionDevPreview(
			{ executionId: 'exec-1', service: 'function-router' },
			reentry
		);
		expect(second.image).toBe(imageV1);
		const body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
		expect(body.image).toBe(imageV1);
	});
});

describe('atomic multi-service dev-preview capture', () => {
	beforeEach(() => {
		vi.stubEnv('PREVIEW_DEV_SYNC_MINT_TOKEN', '');
		vi.stubEnv('WFB_DEV_SYNC_TOKEN', '1'.repeat(64));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function rows() {
		return [
			{
				workspaceRef: 'dev-builder',
				sandboxState: {
					details: {
						service: 'workflow-builder',
						podIP: '10.0.0.11',
						syncPort: 3000
					}
				}
			},
			{
				workspaceRef: 'dev-orchestrator',
				sandboxState: {
					details: {
						service: 'workflow-orchestrator',
						podIP: '10.0.0.12',
						syncPort: 8001
					}
				}
			}
		];
	}

	function atomicExport(
		service: string,
		body: Buffer,
		generation = 'generation-1',
		rootContractService = service
	): Response {
		return new Response(new Uint8Array(body), {
			status: 200,
			headers: {
				'content-type': 'application/gzip',
				'x-sync-generation': generation,
				'x-sync-service': service,
				'x-sync-roots': JSON.stringify(
					[
						...new Set(
							devPreviewCaptureMappings(resolveDevPreviewDescriptor(rootContractService)).map(
								(mapping) => mapping.from
							)
						)
					].sort()
				),
				'x-content-sha256': `sha256:${createHash('sha256').update(body).digest('hex')}`
			}
		});
	}

	it('fetches a complete set before persisting one versioned artifact', async () => {
		const builderTar = gzipSync(Buffer.from('builder-overlay'));
		const orchestratorTar = gzipSync(Buffer.from('orchestrator-overlay'));
		let inFlight = 0;
		let maxInFlight = 0;
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				const body = String(url).includes('10.0.0.11') ? builderTar : orchestratorTar;
				return new Response(body, {
					status: 200,
					headers: { 'content-type': 'application/gzip' }
				});
			})
		);
		const persistence = fakePersistence(rows());

		const result = await captureAllDevPreviewSources(
			'exec-1',
			{ nodeId: 'snapshot', iteration: 4 },
			persistence
		);

		expect(result).toMatchObject({ ok: true, artifactId: 'artifact-1' });
		expect(maxInFlight).toBe(2);
		const persist = vi.mocked(persistence.persistSourceBundleArtifact);
		expect(persist).toHaveBeenCalledTimes(1);
		const input = persist.mock.calls[0]?.[0];
		expect(input?.meta).toMatchObject({
			tier: 'tar-overlay-set',
			manifestVersion: 1,
			serviceCount: 2,
			services: ['workflow-builder', 'workflow-orchestrator'],
			repoUrl: 'PittampalliOrg/workflow-builder',
			base: 'main',
			iteration: 4
		});
		const manifest = JSON.parse(gunzipSync(input?.bytes ?? Buffer.alloc(0)).toString());
		expect(manifest).toMatchObject({
			version: 1,
			tier: 'tar-overlay-set',
			captureProtocol: 'legacy',
			acceptanceEligible: false,
			generation: null,
			repoUrl: 'PittampalliOrg/workflow-builder',
			base: 'main'
		});
		expect(manifest.captureId).toMatch(/^[0-9a-f-]{36}$/);
		expect(new Date(manifest.capturedAt).toISOString()).toBe(manifest.capturedAt);
		expect(manifest.services.map((entry: { service: string }) => entry.service)).toEqual([
			'workflow-builder',
			'workflow-orchestrator'
		]);
		expect(manifest.services[0]).toMatchObject({
			repoSubdir: '.',
			syncPaths: expect.arrayContaining([
				'src',
				'services/shared/workflow-data-contract',
				'package.json',
				'pnpm-lock.yaml'
			]),
			captureMappings: expect.arrayContaining([
				{
					from: 'services/shared/workflow-data-contract',
					to: 'services/shared/workflow-data-contract'
				}
			])
		});
		expect(Buffer.from(manifest.services[0].tarGzipBase64, 'base64')).toEqual(builderTar);
		expect(manifest.services[1]).toMatchObject({
			repoSubdir: 'services/workflow-orchestrator',
			captureMappings: expect.arrayContaining([
				{
					from: '.contract-fixtures',
					to: 'services/shared/workflow-data-contract'
				}
			])
		});
		const exportedUrls = vi
			.mocked(fetch)
			.mock.calls.map(([url]) => decodeURIComponent(String(url)));
		expect(exportedUrls).toContainEqual(expect.stringContaining('.contract-fixtures'));
		expect(Buffer.from(manifest.services[1].tarGzipBase64, 'base64')).toEqual(orchestratorTar);
	});

	it('persists a strict v2 capture only for one complete immutable generation', async () => {
		const builderTar = gzipSync(Buffer.from('builder-v2'));
		const orchestratorTar = gzipSync(Buffer.from('orchestrator-v2'));
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) =>
				String(url).includes('10.0.0.11')
					? atomicExport('workflow-builder', builderTar)
					: atomicExport('workflow-orchestrator', orchestratorTar)
			)
		);
		const persistence = fakePersistence(rows());
		const platformRevision = 'a'.repeat(40);
		const sourceRevision = 'b'.repeat(40);

		const result = await captureAllDevPreviewSources(
			'exec-1',
			{
				nodeId: 'snapshot',
				iteration: 7,
				expectedServices: ['workflow-orchestrator', 'workflow-builder'],
				requireImmutableProvenance: true,
				platformRevision,
				sourceRevision,
				catalogDigest: DEV_PREVIEW_CATALOG_DIGEST
			},
			persistence
		);

		expect(result).toMatchObject({ ok: true, generation: 'generation-1' });
		const input = vi.mocked(persistence.persistSourceBundleArtifact).mock.calls[0]?.[0];
		expect(input?.fileName).toContain(result.captureId);
		expect(input?.meta).toMatchObject({
			manifestVersion: 2,
			captureProtocol: 'atomic-generation-v2',
			acceptanceEligible: true,
			generation: 'generation-1',
			catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
			platformRevision,
			sourceRevision
		});
		const manifest = JSON.parse(gunzipSync(input?.bytes ?? Buffer.alloc(0)).toString());
		expect(manifest).toMatchObject({
			version: 2,
			captureProtocol: 'atomic-generation-v2',
			acceptanceEligible: true,
			generation: 'generation-1',
			catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
			platformRevision,
			sourceRevision
		});
		expect(manifest.services).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					service: 'workflow-builder',
					contentSha256: `sha256:${createHash('sha256').update(builderTar).digest('hex')}`
				}),
				expect.objectContaining({
					service: 'workflow-orchestrator',
					contentSha256: `sha256:${createHash('sha256').update(orchestratorTar).digest('hex')}`
				})
			])
		);
	});

	it('persists nothing when strict exports report different generations', async () => {
		const tar = gzipSync(Buffer.from('overlay'));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) =>
				String(url).includes('10.0.0.11')
					? atomicExport('workflow-builder', tar, 'generation-1')
					: atomicExport('workflow-orchestrator', tar, 'generation-2')
			)
		);
		const persistence = fakePersistence(rows());
		const result = await captureAllDevPreviewSources(
			'exec-1',
			{
				expectedServices: ['workflow-builder', 'workflow-orchestrator'],
				requireImmutableProvenance: true,
				platformRevision: 'a'.repeat(40),
				sourceRevision: 'b'.repeat(40)
			},
			persistence
		);
		expect(result).toMatchObject({
			ok: false,
			skipped: 'generation_mismatch'
		});
		expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});

	it('strict capture rejects caller service subsets and supersets of persisted sessions', async () => {
		const persistence = fakePersistence(rows());
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		for (const expectedServices of [
			['workflow-builder'],
			['workflow-builder', 'workflow-orchestrator', 'function-router']
		]) {
			expect(
				await captureAllDevPreviewSources(
					'exec-1',
					{ requireImmutableProvenance: true, expectedServices },
					persistence
				)
			).toMatchObject({
				ok: false,
				skipped: 'persisted_service_set_mismatch'
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});

	it('strict mode rejects missing provenance, catalog drift, and invalid services', async () => {
		const persistence = fakePersistence(rows());
		expect(
			await captureAllDevPreviewSources('exec-1', { requireImmutableProvenance: true }, persistence)
		).toMatchObject({ ok: false, skipped: 'missing_expected_services' });
		expect(
			await captureAllDevPreviewSources(
				'exec-1',
				{
					requireImmutableProvenance: true,
					expectedServices: ['not-in-catalog']
				},
				persistence
			)
		).toMatchObject({ ok: false, skipped: 'invalid_expected_services' });

		const tar = gzipSync(Buffer.from('overlay'));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) =>
				String(url).includes('10.0.0.11')
					? atomicExport('workflow-builder', tar)
					: atomicExport('workflow-orchestrator', tar)
			)
		);
		expect(
			await captureAllDevPreviewSources(
				'exec-1',
				{
					requireImmutableProvenance: true,
					expectedServices: ['workflow-builder', 'workflow-orchestrator'],
					platformRevision: 'a'.repeat(40),
					sourceRevision: 'b'.repeat(40),
					catalogDigest: `sha256:${'0'.repeat(64)}`
				},
				persistence
			)
		).toMatchObject({ ok: false, skipped: 'catalog_digest_mismatch' });
	});

	it('strict mode rejects a digest or service header that does not describe the bytes', async () => {
		const tar = gzipSync(Buffer.from('overlay'));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				const service = String(url).includes('10.0.0.11')
					? 'wrong-service'
					: 'workflow-orchestrator';
				return atomicExport(
					service,
					tar,
					'generation-1',
					String(url).includes('10.0.0.11') ? 'workflow-builder' : 'workflow-orchestrator'
				);
			})
		);
		const persistence = fakePersistence(rows());
		const result = await captureAllDevPreviewSources(
			'exec-1',
			{
				requireImmutableProvenance: true,
				expectedServices: ['workflow-builder', 'workflow-orchestrator'],
				platformRevision: 'a'.repeat(40),
				sourceRevision: 'b'.repeat(40)
			},
			persistence
		);
		expect(result).toMatchObject({
			ok: false,
			skipped: 'incomplete_export_set'
		});
		expect(result.services).toContainEqual({
			service: 'workflow-builder',
			ok: false,
			skipped: 'export_service_mismatch'
		});
		expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});

	it('persists nothing when one required service export fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const goodTar = gzipSync(Buffer.from('builder-overlay'));
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) =>
				String(url).includes('10.0.0.12')
					? new Response('unavailable', { status: 503 })
					: new Response(goodTar, { status: 200 })
			)
		);
		const persistence = fakePersistence(rows());

		const result = await captureAllDevPreviewSources(
			'exec-1',
			{ nodeId: 'snapshot', iteration: 5 },
			persistence
		);

		expect(result).toMatchObject({
			ok: false,
			skipped: 'incomplete_export_set',
			services: expect.arrayContaining([
				{ service: 'workflow-builder', ok: true },
				{
					service: 'workflow-orchestrator',
					ok: false,
					skipped: 'export_http_503'
				}
			])
		});
		expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});
});
