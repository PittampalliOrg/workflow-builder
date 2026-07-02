import type { BrowserRuntimeClient } from "$lib/server/application/ports";
import {
	getBrowserState,
	takeScreenshot,
} from "$lib/server/playwright-mcp-client";

export class PlaywrightMcpBrowserRuntimeClient implements BrowserRuntimeClient {
	getState(input: { agentSlug: string }) {
		return getBrowserState(input.agentSlug);
	}

	takeScreenshot(input: { agentSlug: string }) {
		return takeScreenshot(input.agentSlug);
	}
}
