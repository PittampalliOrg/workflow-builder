import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '+page.svelte'),
	'utf8'
);

function outputsTab(): string {
	const start = source.indexOf('<TabsContent value="outputs"');
	const end = source.indexOf('<!-- Tab: Changes', start);
	return source.slice(start, end);
}

describe('workflow run Outputs tab', () => {
	it('renders the workflow return independently from persisted artifacts', () => {
		const tab = outputsTab();

		expect(tab).toContain('{#if output !== null}');
		expect(tab).toContain('<JsonViewer data={output} label="Workflow return" collapsed={false} />');
		expect(tab).toContain('{#if outputArtifacts.length > 0}');
		expect(tab.indexOf('label="Workflow return"')).toBeLessThan(
			tab.indexOf('<ArtifactList artifacts={outputArtifacts}')
		);
	});

	it('only shows a combined empty state when neither return nor artifacts exist', () => {
		const tab = outputsTab();

		expect(tab).toContain('{:else if output === null}');
		expect(tab).toContain(
			'No workflow return or output artifacts are available for this execution.'
		);
	});
});
