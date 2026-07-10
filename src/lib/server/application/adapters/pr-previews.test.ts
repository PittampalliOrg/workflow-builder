import { describe, expect, it, vi } from 'vitest';
import {
	buildPrSeedCommand,
	GithubPrPreviewGateway,
	HttpPrPreviewCommandBrokerAdapter,
	prPreviewRegistryEntries
} from './pr-previews';
import { buildPromotionCommand } from './workflow-code-version-promotion';
import type { SourceBundlePromotionRunnerInput } from '$lib/server/application/ports';

describe('buildPrSeedCommand', () => {
	const input = {
		prNumber: 42,
		headSha: 'deadbeef',
		targets: [
			{
				service: 'workflow-builder',
				repoSubdir: '.',
				syncPaths: ['src'],
				extraSync: [],
				podIp: '10.1.2.3',
				syncPort: 3000,
				syncToken: 'a'.repeat(64),
				appPort: 3000,
				healthPath: '/'
			},
			{
				service: 'workflow-orchestrator',
				repoSubdir: 'services/workflow-orchestrator',
				syncPaths: ['app.py', 'core'],
				extraSync: [
					{
						from: '../shared/workflow-data-contract',
						to: '.contract-fixtures'
					}
				],
				podIp: '10.1.2.4',
				syncPort: 8001,
				syncToken: 'b'.repeat(64),
				appPort: 8080,
				healthPath: '/healthz'
			}
		]
	};

	it('clones the PR head once via pull/<n>/head (fork-safe)', () => {
		const cmd = buildPrSeedCommand(input, 'PittampalliOrg/workflow-builder');
		expect(cmd).toContain('git fetch -q --depth 1 origin "pull/42/head"');
		expect(cmd.match(/git fetch/g)).toHaveLength(1);
		expect(cmd).toContain('SEED_ERR=head_moved');
		expect(cmd).not.toContain('SEED_WARN=head_moved');
	});

	it("gzip-tar-POSTs each target's tree to its /__sync with the x-sync-token", () => {
		const cmd = buildPrSeedCommand(input, 'PittampalliOrg/workflow-builder');
		expect(cmd).toContain('"http://10.1.2.3:3000/__sync"');
		expect(cmd).toContain('"http://10.1.2.4:8001/__sync"');
		expect(cmd).toContain('x-sync-token: $SYNC_TOKEN');
		expect(cmd).toContain('x-sync-generation: deadbeef');
		expect(cmd).toContain('x-sync-service: workflow-builder');
		expect(cmd).toContain('x-sync-roots: ["src"]');
		expect(cmd).toContain('x-sync-roots: [".contract-fixtures","app.py","core"]');
		expect(cmd).toContain(`SYNC_TOKEN='${'a'.repeat(64)}'`);
		expect(cmd).toContain(`SYNC_TOKEN='${'b'.repeat(64)}'`);
		expect(cmd).toContain('Content-Type: application/gzip');
		expect(cmd).toContain('tar -czf /tmp/seed-workflow-builder.tgz');
	});

	it('roots each service at its repoSubdir and stages extraSync trees', () => {
		const cmd = buildPrSeedCommand(input, 'PittampalliOrg/workflow-builder');
		expect(cmd).toContain('cd "/tmp/pr-src"'); // '.' → repo root
		expect(cmd).toContain('cd "/tmp/pr-src/services/workflow-orchestrator"');
		expect(cmd).toContain("'../shared/workflow-data-contract'");
		expect(cmd).toContain('.contract-fixtures');
	});

	it('emits a per-service result marker for the adapter to parse', () => {
		const cmd = buildPrSeedCommand(input, 'PittampalliOrg/workflow-builder');
		expect(cmd).toContain('echo "SEED_workflow_builder=$CODE"');
		expect(cmd).toContain('echo "SEED_workflow_orchestrator=$CODE"');
	});

	it("gates each seed on the dev server's APP port answering (#41 readiness gate)", () => {
		const cmd = buildPrSeedCommand(input, 'PittampalliOrg/workflow-builder');
		// The gate polls the app port's health route — NOT the sync receiver
		// (the sidecar answers long before uvicorn does).
		expect(cmd).toContain('"http://10.1.2.3:3000/"');
		expect(cmd).toContain('"http://10.1.2.4:8080/healthz"');
		// Bounded budget: 30 attempts, 3s curl cap, 3s sleep.
		expect(cmd).toContain('while [ $i -lt 30 ]; do');
		expect(cmd).toContain('-m 3');
		expect(cmd).toContain('sleep 3');
		// ANY http status counts as accepting; only no-response keeps polling.
		expect(cmd).toContain('[ "$READY" != "000" ] && break');
		// Informational markers; the seed still runs after a timed-out gate.
		expect(cmd).toContain('echo "SEED_READY_workflow_builder=$READY"');
		expect(cmd).toContain('echo "SEED_READY_workflow_orchestrator=$READY"');
		// The gate runs BEFORE the sync POST for each target.
		expect(cmd.indexOf('"http://10.1.2.4:8080/healthz"')).toBeLessThan(
			cmd.indexOf('"http://10.1.2.4:8001/__sync"')
		);
	});

	it('falls back to the sync port when a target carries no appPort', () => {
		const bare = {
			...input,
			targets: [
				{
					service: 'workflow-builder',
					repoSubdir: '.',
					syncPaths: ['src'],
					extraSync: [],
					podIp: '10.1.2.3',
					syncPort: 3000,
					syncToken: 'a'.repeat(64)
				}
			]
		};
		const cmd = buildPrSeedCommand(bare, 'PittampalliOrg/workflow-builder');
		expect(cmd).toContain('"http://10.1.2.3:3000/"'); // gate on syncPort + "/"
		expect(cmd).toContain('echo "SEED_READY_workflow_builder=$READY"');
	});
});

describe('prPreviewRegistryEntries', () => {
	it('exposes the dev-preview registry slice (bff at repo root)', () => {
		const entries = prPreviewRegistryEntries();
		const bff = entries.find((e) => e.service === 'workflow-builder');
		expect(bff?.repoSubdir).toBe('.');
		expect(bff?.syncPaths.length).toBeGreaterThan(0);
		const orch = entries.find((e) => e.service === 'workflow-orchestrator');
		expect(orch?.repoSubdir).toBe('services/workflow-orchestrator');
	});

	it('carries the dev-server app port + health route for the seed readiness gate', () => {
		const entries = prPreviewRegistryEntries();
		const bff = entries.find((e) => e.service === 'workflow-builder');
		expect(bff?.appPort).toBe(3000);
		expect(bff?.healthPath).toBe('/');
		const orch = entries.find((e) => e.service === 'workflow-orchestrator');
		expect(orch?.appPort).toBe(8080);
		expect(orch?.healthPath).toBe('/healthz');
	});
});

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

describe('GithubPrPreviewGateway', () => {
	it('fails closed when the broker read credential is absent', async () => {
		const fetch = vi.fn();
		await expect(
			new GithubPrPreviewGateway({
				fetch,
				readToken: () => null
			}).inspect({ prNumber: 42, expectedHeadSha: HEAD_SHA })
		).rejects.toThrow('preview control GitHub App token');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('verifies the canonical open same-repo main PR and paginates every file', async () => {
		const first = Array.from({ length: 100 }, (_, index) => ({
			filename: `src/file-${index}.ts`,
			status: 'modified'
		}));
		const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
			const href = String(url);
			if (!href.includes('/files?')) {
				return Response.json({
					number: 42,
					state: 'open',
					labels: [{ name: 'preview' }],
					changed_files: 101,
					base: {
						ref: 'main',
						sha: BASE_SHA,
						repo: { full_name: 'PittampalliOrg/workflow-builder' }
					},
					head: {
						sha: HEAD_SHA,
						repo: { full_name: 'PittampalliOrg/workflow-builder' }
					}
				});
			}
			return new URL(href).searchParams.get('page') === '1'
				? Response.json(first)
				: Response.json([
						{
							filename: 'src/new-name.ts',
							previous_filename: 'src/old-name.ts',
							status: 'renamed'
						}
					]);
		});
		const gateway = new GithubPrPreviewGateway({
			repository: 'PittampalliOrg/workflow-builder',
			readToken: () => 'read-only',
			fetch
		});
		const result = await gateway.inspect({
			prNumber: 42,
			expectedHeadSha: HEAD_SHA
		});
		expect(result).toMatchObject({
			repository: 'PittampalliOrg/workflow-builder',
			baseRef: 'main',
			baseSha: BASE_SHA,
			headSha: HEAD_SHA
		});
		expect(result.changedPaths).toHaveLength(102);
		expect(result.changedPaths).toContain('src/old-name.ts');
		expect(fetch).toHaveBeenCalledTimes(3);
		for (const call of fetch.mock.calls) {
			const headers = call[1]?.headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer read-only');
		}
	});

	it.each([
		['closed PR', { state: 'closed' }],
		['missing preview label', { labels: [] }],
		['non-main base', { base: { ref: 'release' } }],
		['fork head', { head: { repo: { full_name: 'someone/workflow-builder' } } }],
		['moved head', { head: { sha: 'c'.repeat(40) } }]
	])('rejects %s before reading files', async (_label, override) => {
		const pull = {
			number: 42,
			state: 'open',
			labels: [{ name: 'preview' }],
			changed_files: 1,
			base: {
				ref: 'main',
				sha: BASE_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			},
			head: {
				sha: HEAD_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			},
			...override
		};
		if ('base' in override) pull.base = { ...pull.base, ...override.base };
		if ('head' in override) pull.head = { ...pull.head, ...override.head } as never;
		const fetch = vi.fn(async () => Response.json(pull));
		const gateway = new GithubPrPreviewGateway({
			fetch,
			readToken: () => 'read-only'
		});
		await expect(gateway.inspect({ prNumber: 42, expectedHeadSha: HEAD_SHA })).rejects.toThrow(
			/expected open, same-repository main PR/
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('fails closed when any files page is incomplete or the declared count exceeds the cap', async () => {
		const pull = {
			number: 42,
			state: 'open',
			labels: [{ name: 'preview' }],
			changed_files: 2,
			base: {
				ref: 'main',
				sha: BASE_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			},
			head: {
				sha: HEAD_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			}
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(pull))
			.mockResolvedValueOnce(Response.json([{ filename: 'src/one.ts' }]));
		await expect(
			new GithubPrPreviewGateway({
				fetch,
				readToken: () => 'read-only'
			}).inspect({
				prNumber: 42,
				expectedHeadSha: HEAD_SHA
			})
		).rejects.toThrow('changed-file count mismatch');

		const capped = vi.fn(async () => Response.json({ ...pull, changed_files: 3 }));
		await expect(
			new GithubPrPreviewGateway({
				fetch: capped,
				maxChangedFiles: 2,
				readToken: () => 'read-only'
			}).inspect({
				prNumber: 42,
				expectedHeadSha: HEAD_SHA
			})
		).rejects.toThrow('exceeding the 2 file cap');
		expect(capped).toHaveBeenCalledTimes(1);
	});

	it('fails closed when a changed-files page cannot be read', async () => {
		const pull = {
			number: 42,
			state: 'open',
			labels: [{ name: 'preview' }],
			changed_files: 1,
			base: {
				ref: 'main',
				sha: BASE_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			},
			head: {
				sha: HEAD_SHA,
				repo: { full_name: 'PittampalliOrg/workflow-builder' }
			}
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json(pull))
			.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
		await expect(
			new GithubPrPreviewGateway({
				fetch,
				readToken: () => 'read-only'
			}).inspect({ prNumber: 42, expectedHeadSha: HEAD_SHA })
		).rejects.toThrow('files page 1 failed (HTTP 503)');
	});
});

describe('HttpPrPreviewCommandBrokerAdapter', () => {
	it('projects only the broker credential and narrow PR command', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json(
				{
					prNumber: 42,
					alias: 'pr-42',
					url: null,
					state: 'provisioning',
					headSha: HEAD_SHA,
					services: ['workflow-builder'],
					error: null,
					verify: null,
					updatedAt: '2026-07-09T12:00:00.000Z'
				},
				{ status: 202 }
			)
		);
		const adapter = new HttpPrPreviewCommandBrokerAdapter({
			baseUrl: () => 'http://preview-control-broker:3000/',
			token: () => 'broker-only',
			fetch
		});
		await expect(
			adapter.up({ prNumber: 42, headSha: HEAD_SHA, verify: true })
		).resolves.toMatchObject({ state: 'provisioning' });
		expect(fetch).toHaveBeenCalledWith(
			'http://preview-control-broker:3000/api/internal/preview-control/pr-preview',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Preview-Control-Broker-Token': 'broker-only'
				},
				body: JSON.stringify({
					action: 'up',
					prNumber: 42,
					headSha: HEAD_SHA,
					verify: true
				})
			})
		);
		const init = fetch.mock.calls[0]?.[1];
		expect(JSON.stringify(init)).not.toContain('GITHUB');
		expect(JSON.stringify(init)).not.toContain('kubeconfig');
	});

	it('fails closed without broker location or credential', async () => {
		const noUrl = new HttpPrPreviewCommandBrokerAdapter({
			baseUrl: () => null,
			token: () => 'token'
		});
		await expect(noUrl.status(42)).rejects.toThrow('PREVIEW_CONTROL_BROKER_URL');
		const noToken = new HttpPrPreviewCommandBrokerAdapter({
			baseUrl: () => 'http://broker',
			token: () => null
		});
		await expect(noToken.status(42)).rejects.toThrow('PREVIEW_CONTROL_BROKER_TOKEN');
	});
});

describe('buildPromotionCommand preview label (D2)', () => {
	const input: SourceBundlePromotionRunnerInput = {
		executionId: 'exec-1',
		fileId: 'file-1',
		repo: 'PittampalliOrg/workflow-builder',
		base: 'main',
		mode: 'pr',
		title: 'Promote test',
		tier: 'tar-overlay',
		repoSubdir: '.',
		syncPaths: ['src']
	};

	it('adds the preview-label curl only when the flag is on', () => {
		const withLabel = buildPromotionCommand(input, 'tok', 'http://bff/bundle', {
			addPreviewLabel: true
		});
		expect(withLabel).toContain('/issues/$NUM/labels');
		expect(withLabel).toContain('{"labels":["preview"]}');
		expect(withLabel).toContain('PREVIEW_LABEL_HTTP=');

		const withoutLabel = buildPromotionCommand(input, 'tok', 'http://bff/bundle');
		expect(withoutLabel).not.toContain('/labels');
		expect(withoutLabel).not.toContain('PREVIEW_LABEL_HTTP');
	});

	it('keeps the PR-create call untouched', () => {
		const cmd = buildPromotionCommand(input, 'tok', 'http://bff/bundle', {
			addPreviewLabel: true
		});
		expect(cmd).toContain('https://api.github.com/repos/$REPO/pulls');
		expect(cmd).toContain('echo "PR_URL=$URL"');
	});
});
