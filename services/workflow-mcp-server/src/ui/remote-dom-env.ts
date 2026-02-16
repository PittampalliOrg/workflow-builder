import "@remote-dom/core/polyfill";

import {
	RemoteElement,
	RemoteFragmentElement,
} from "@remote-dom/core/elements";

declare global {
	var __wfRemoteDomInitialized: boolean | undefined;
}

export function initRemoteDomEnv(): void {
	if (globalThis.__wfRemoteDomInitialized) return;
	globalThis.__wfRemoteDomInitialized = true;

	// Some host renderers may introduce this wrapper element; safe to define always.
	if (!customElements.get("remote-fragment")) {
		customElements.define("remote-fragment", RemoteFragmentElement);
	}

	class WfAppElement extends RemoteElement {
		static get remoteProperties() {
			return {
				// Entire UI view-model as a single serializable object.
				model: { type: Object },
			};
		}
	}

	if (!customElements.get("wf-app")) {
		customElements.define("wf-app", WfAppElement);
	}
}
