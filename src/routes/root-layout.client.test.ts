import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('root layout preview runtime watcher', () => {
	it('is session-scoped and owned by a reactive effect', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '+layout.svelte'),
			'utf8'
		);

		expect(source).toContain('$effect(() => {');
		expect(source).toContain('if (!data.session?.userId) return;');
		expect(source).toContain('return startRuntimeHandoffWatcher({');
	});
});
