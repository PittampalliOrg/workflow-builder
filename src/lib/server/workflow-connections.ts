export type WorkflowConnectionRef = {
	workflowId: string;
	nodeId: string;
	connectionExternalId: string;
	pieceName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseConnectionExternalId(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim().length === 0) return null;
	const match = value.match(/connections\['([^']+)'\]/);
	return match?.[1] || (value.trim() ? value.trim() : null);
}

function inferPieceName(nodeData: Record<string, unknown>): string | null {
	const actionDefinition = isRecord(nodeData.actionDefinition) ? nodeData.actionDefinition : null;
	const catalogFunction = isRecord(nodeData.catalogFunction) ? nodeData.catalogFunction : null;
	const actionCatalogDetail = isRecord(nodeData.actionCatalogDetail) ? nodeData.actionCatalogDetail : null;

	const candidates = [
		catalogFunction?.pieceName,
		actionCatalogDetail?.providerId,
		actionCatalogDetail?.pieceName,
		actionDefinition?.providerId,
	];

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}

	return null;
}

function normalizePieceName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-');
	return normalized || null;
}

function addRef(
	refs: Map<string, WorkflowConnectionRef>,
	workflowId: string,
	nodeId: string,
	connectionExternalId: unknown,
	pieceName: unknown,
) {
	const externalId = typeof connectionExternalId === 'string' ? connectionExternalId.trim() : '';
	const normalizedPieceName = normalizePieceName(pieceName);
	if (!nodeId || !externalId || !normalizedPieceName) return;
	refs.set(`${nodeId}:${externalId}:${normalizedPieceName}`, {
		workflowId,
		nodeId,
		connectionExternalId: externalId,
		pieceName: normalizedPieceName,
	});
}

export function collectWorkflowConnectionRefs(
	workflowId: string,
	nodes: unknown,
	spec?: unknown,
): WorkflowConnectionRef[] {
	const refs = new Map<string, WorkflowConnectionRef>();

	if (Array.isArray(nodes)) {
		for (const node of nodes) {
			if (!isRecord(node)) continue;
			const nodeId = typeof node.id === 'string' ? node.id : '';
			if (!nodeId) continue;
			const data = isRecord(node.data) ? node.data : {};
			const actionBinding = isRecord(data.actionBinding) ? data.actionBinding : null;
			const taskConfig = isRecord(data.taskConfig) ? data.taskConfig : null;
			const withConfig = taskConfig && isRecord(taskConfig.with) ? taskConfig.with : null;
			const body = withConfig && isRecord(withConfig.body) ? withConfig.body : null;
			const input = body && isRecord(body.input) ? body.input : null;

			const connectionExternalId =
				(typeof actionBinding?.connectionExternalId === 'string' &&
					actionBinding.connectionExternalId.trim()) ||
				parseConnectionExternalId(input?.auth) ||
				null;
			const pieceName =
				(typeof actionBinding?.pieceName === 'string' && actionBinding.pieceName.trim()) ||
				inferPieceName(data) ||
				null;

			addRef(refs, workflowId, nodeId, connectionExternalId, pieceName);
		}
	}

	const specRecord = isRecord(spec) ? spec : null;
	const doArray = Array.isArray(specRecord?.do) ? specRecord.do : [];
	for (const entry of doArray) {
		if (!isRecord(entry)) continue;
		const taskName = Object.keys(entry)[0];
		const task = taskName && isRecord(entry[taskName]) ? entry[taskName] : null;
		if (!taskName || !task) continue;

		const withConfig = isRecord(task.with) ? task.with : {};
		const body = isRecord(withConfig.body) ? withConfig.body : {};
		const agentConfig = isRecord(withConfig.agentConfig)
			? withConfig.agentConfig
			: isRecord(body.agentConfig)
				? body.agentConfig
				: {};
		const bodyInput = isRecord(body.input) ? body.input : {};
		const call = typeof task.call === 'string' ? task.call : '';

		addRef(
			refs,
			workflowId,
			taskName,
			withConfig.connectionExternalId ?? body.connectionExternalId ?? parseConnectionExternalId(bodyInput.auth),
			withConfig.pieceName ?? body.pieceName ?? (call.includes('/') ? call.split('/')[0] : null),
		);

		const mcpServers = Array.isArray(agentConfig.mcpServers) ? agentConfig.mcpServers : [];
		for (const server of mcpServers) {
			if (!isRecord(server)) continue;
			addRef(refs, workflowId, taskName, server.connectionExternalId, server.pieceName);
		}
	}

	return Array.from(refs.values());
}
