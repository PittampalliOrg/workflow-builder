function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function cloneForInput(value: unknown): unknown {
	if (!isRecord(value) && !Array.isArray(value)) return value;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return value;
	}
}

function setRecordValue(
	record: Record<string, unknown> | null | undefined,
	key: string,
	value: unknown
): void {
	if (record) record[key] = value;
}

function injectCodeCheckpointRestore(
	baseInput: unknown,
	restore: Record<string, unknown>
): Record<string, unknown> {
	const cloned = cloneForInput(baseInput);
	const inputRecord: Record<string, unknown> = isRecord(cloned)
		? { ...cloned }
		: { triggerData: cloned ?? {} };

	inputRecord.codeCheckpointRestore = restore;

	const metadata = asRecord(inputRecord._message_metadata) ?? {};
	metadata.codeCheckpointRestore = restore;
	inputRecord._message_metadata = metadata;

	const node = asRecord(inputRecord.node);
	const nodeData = asRecord(node?.data);
	const config = asRecord(node?.config) ?? asRecord(nodeData?.config);
	if (config) {
		config.codeCheckpointRestore = restore;
		const configMetadata = asRecord(config.metadata) ?? {};
		configMetadata.codeCheckpointRestore = restore;
		config.metadata = configMetadata;
		setRecordValue(asRecord(config.body), 'codeCheckpointRestore', restore);
		setRecordValue(asRecord(config.input), 'codeCheckpointRestore', restore);
	}

	return inputRecord;
}

function injectSandboxName(baseInput: unknown, sandboxName: string): Record<string, unknown> {
	const cloned = cloneForInput(baseInput);
	const inputRecord: Record<string, unknown> = isRecord(cloned)
		? { ...cloned }
		: { triggerData: cloned ?? {} };
	inputRecord.sandboxName = sandboxName;
	const metadata = asRecord(inputRecord._message_metadata) ?? {};
	metadata.sandboxName = sandboxName;
	inputRecord._message_metadata = metadata;
	return inputRecord;
}

export function buildCodeCheckpointReplayInput(
	baseInput: unknown,
	restore: Record<string, unknown>,
	sandboxName?: string | null
): Record<string, unknown> {
	const effectiveRestore = sandboxName ? { ...restore, sandboxName } : { ...restore };
	const replayInput = injectCodeCheckpointRestore(baseInput, effectiveRestore);
	return sandboxName ? injectSandboxName(replayInput, sandboxName) : replayInput;
}
