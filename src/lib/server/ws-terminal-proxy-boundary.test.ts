import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dev terminal WebSocket proxy persistence boundary', () => {
	it.each([
		['shell', './ws-kube-exec-proxy.ts'],
		['cli terminal', './ws-cli-terminal-proxy.ts'],
	])('%s proxy resolves session runtime through application ports', (_name, path) => {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');

		expect(source).toContain('getApplicationAdapters');
		expect(source).toContain('getSessionRuntimeDebugTarget');
		expect(source).not.toContain(['sessions', 'runtime-target'].join('/'));
		expect(source).not.toContain(['$lib', 'server', 'db'].join('/'));
		expect(source).not.toContain(['drizzle', 'orm'].join('-'));
	});
});
