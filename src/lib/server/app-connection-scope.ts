export function normalizeConnectionProjectIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.map((item) => (typeof item === 'string' ? item.trim() : ''))
				.filter(Boolean)
		)
	);
}

export function connectionBelongsToProject(value: unknown, projectId: string): boolean {
	const projectIds = normalizeConnectionProjectIds(value);
	return projectIds.length === 0 || projectIds.includes(projectId);
}

export function mergeConnectionProjectId(value: unknown, projectId: string): string[] {
	const projectIds = normalizeConnectionProjectIds(value);
	if (!projectIds.includes(projectId)) projectIds.push(projectId);
	return projectIds;
}
