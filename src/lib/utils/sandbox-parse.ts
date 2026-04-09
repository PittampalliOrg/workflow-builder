import type { Sandbox } from '$lib/types/sandbox';

/**
 * Strip ANSI escape sequences from CLI output.
 */
export function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse `openshell sandbox list` tabular CLI stdout into structured Sandbox objects.
 * Handles ANSI escape codes and various column layouts.
 */
export function parseSandboxListStdout(raw: string): Sandbox[] {
	const clean = stripAnsi(raw);
	const lines = clean.split('\n').filter((l) => l.trim());
	if (lines.length < 2) return [];

	const header = lines[0];
	const cols: { name: string; start: number }[] = [];
	for (const word of ['NAME', 'NAMESPACE', 'CREATED', 'PHASE', 'IMAGE']) {
		const idx = header.indexOf(word);
		if (idx >= 0) cols.push({ name: word.toLowerCase(), start: idx });
	}
	cols.sort((a, b) => a.start - b.start);

	return lines
		.slice(1)
		.map((line) => {
			const entry: Record<string, string> = {};
			for (let i = 0; i < cols.length; i++) {
				const end = i + 1 < cols.length ? cols[i + 1].start : line.length;
				entry[cols[i].name] = line.slice(cols[i].start, end).trim();
			}

			// CLI dates like "2026-04-09 11:30:10" lack timezone — append UTC
			let createdAt = entry.created;
			if (createdAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)) {
				createdAt = createdAt.replace(' ', 'T') + 'Z';
			}

			return {
				name: entry.name ?? '',
				type: 'openshell' as const,
				phase: (entry.phase?.toUpperCase() ?? 'UNKNOWN') as Sandbox['phase'],
				image: entry.image,
				createdAt
			};
		})
		.filter((s) => s.name);
}

/**
 * Normalize a response from the agent-runtime's /api/v1/sandboxes endpoint
 * into a Sandbox array. Handles both the new JSON format and legacy CLI stdout format.
 */
export function normalizeSandboxResponse(data: Record<string, unknown>): Sandbox[] {
	// New format: { ok: true, sandboxes: [...] }
	if (Array.isArray(data.sandboxes)) {
		return data.sandboxes as Sandbox[];
	}

	// Legacy format: { ok: true, stdout: "NAME ...\n...", ... }
	if (typeof data.stdout === 'string') {
		return parseSandboxListStdout(data.stdout);
	}

	// Already an array
	if (Array.isArray(data)) {
		return data as Sandbox[];
	}

	return [];
}
