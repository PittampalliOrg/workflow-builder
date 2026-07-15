import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '+server.ts'), 'utf8');

describe('runtime handoff route', () => {
	it('is authenticated, uncacheable, and delegates identity to the application service', () => {
		expect(source).toContain("if (!locals.session?.userId)");
		expect(source).toContain('runtimeHandoff.current()');
		expect(source).toContain("'cache-control': 'no-store'");
		expect(source).not.toContain('process.env');
		expect(source).not.toContain('import.meta.env');
	});
});
