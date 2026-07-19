import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Endpoint = {
	host: string;
	port: number;
	tls?: string;
	access?: string;
	protocol?: string;
};

type SandboxPolicy = {
	network_policies: Record<string, { endpoints?: Endpoint[] }>;
};

const policyPath = new URL('./policy.yaml', import.meta.url);
const dockerfilePath = new URL('./Dockerfile', import.meta.url);
const policy = load(readFileSync(policyPath, 'utf8')) as SandboxPolicy;

describe('OpenShell sandbox package policy', () => {
	it('keeps every npm registry rule on end-to-end TLS', () => {
		const registryHosts = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
		const matching = Object.values(policy.network_policies)
			.flatMap((entry) => entry.endpoints ?? [])
			.filter((endpoint) => registryHosts.has(endpoint.host));

		expect(new Set(matching.map((endpoint) => endpoint.host))).toEqual(registryHosts);
		for (const endpoint of matching) {
			expect(endpoint).toMatchObject({ port: 443, tls: 'skip', access: 'full' });
			expect(endpoint.protocol).toBeUndefined();
		}
	});

	it('bakes the guarded policy into the standalone sandbox image', () => {
		expect(readFileSync(dockerfilePath, 'utf8')).toContain(
			'COPY policy.yaml /etc/openshell/policy.yaml'
		);
	});
});
