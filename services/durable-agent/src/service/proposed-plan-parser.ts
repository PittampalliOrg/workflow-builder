const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

function splitLines(text: string): string[] {
	return text.match(/[^\r\n]*\r?\n|[^\r\n]+$/g) ?? [];
}

function isStandaloneTagLine(line: string, tag: string): boolean {
	return line.trim() === tag;
}

export function extractProposedPlanText(text: string): string | null {
	if (!text) return null;
	const lines = splitLines(text);
	let inPlanBlock = false;
	let sawPlanBlock = false;
	let currentBlock = "";
	let latestBlock = "";

	for (const line of lines) {
		if (!inPlanBlock) {
			if (isStandaloneTagLine(line, OPEN_TAG)) {
				inPlanBlock = true;
				sawPlanBlock = true;
				currentBlock = "";
			}
			continue;
		}
		if (isStandaloneTagLine(line, CLOSE_TAG)) {
			latestBlock = currentBlock;
			inPlanBlock = false;
			continue;
		}
		currentBlock += line;
	}

	// Match Codex behavior: if tag is left open, treat finish as implicit close.
	if (inPlanBlock) {
		latestBlock = currentBlock;
	}

	return sawPlanBlock ? latestBlock : null;
}

export function stripProposedPlanBlocks(text: string): string {
	if (!text) return "";
	const lines = splitLines(text);
	let inPlanBlock = false;
	let out = "";

	for (const line of lines) {
		if (!inPlanBlock) {
			if (isStandaloneTagLine(line, OPEN_TAG)) {
				inPlanBlock = true;
				continue;
			}
			out += line;
			continue;
		}
		if (isStandaloneTagLine(line, CLOSE_TAG)) {
			inPlanBlock = false;
		}
	}

	return out;
}
