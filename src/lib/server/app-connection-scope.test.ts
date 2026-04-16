import { describe, expect, it } from 'vitest';
import {
	connectionBelongsToProject,
	mergeConnectionProjectId,
	normalizeConnectionProjectIds
} from './app-connection-scope';

describe('app connection project scoping', () => {
	it('normalizes project ids and removes blanks and duplicates', () => {
		expect(normalizeConnectionProjectIds(['project-a', '', 'project-a', ' project-b ', 42])).toEqual([
			'project-a',
			'project-b'
		]);
	});

	it('treats legacy unscoped connections as visible', () => {
		expect(connectionBelongsToProject([], 'project-a')).toBe(true);
		expect(connectionBelongsToProject(null, 'project-a')).toBe(true);
	});

	it('requires scoped connections to include the active project', () => {
		expect(connectionBelongsToProject(['project-a'], 'project-a')).toBe(true);
		expect(connectionBelongsToProject(['project-a'], 'project-b')).toBe(false);
	});

	it('merges the active project without duplicating existing ids', () => {
		expect(mergeConnectionProjectId(['project-a'], 'project-b')).toEqual(['project-a', 'project-b']);
		expect(mergeConnectionProjectId(['project-a'], 'project-a')).toEqual(['project-a']);
	});
});
