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

	it.each([
		['openshell terminal', './ws-terminal-proxy.ts'],
		['shell', './ws-kube-exec-proxy.ts'],
		['cli terminal', './ws-cli-terminal-proxy.ts'],
	])('%s proxy verifies access tokens through auth-session ports', (_name, path) => {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');

		expect(source).toContain('authSession.verifyAccessToken');
		expect(source).not.toMatch(/from ['"].*server\/auth['"]/);
		expect(source).not.toContain('verifyAccessToken } from');
		expect(source).not.toContain('verifyAccessToken,');
	});
});
