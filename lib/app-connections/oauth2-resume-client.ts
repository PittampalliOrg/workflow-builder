import type { OAuth2AuthorizationMethod } from "@/lib/types/app-connection";

export const OAUTH2_SAME_TAB_STATE_KEY = "oauth2_same_tab_state";

export function oauth2PendingKey(state: string) {
	return `oauth2_pending:${state}`;
}

export function oauth2ResultKey(state: string) {
	return `oauth2_callback_result:${state}`;
}

export type OAuth2PendingResume = {
	state: string;
	pieceName: string;
	displayName: string;
	clientId: string;
	redirectUrl: string;
	codeVerifier: string;
	scope: string;
	props: Record<string, unknown>;
	authorizationMethod?: OAuth2AuthorizationMethod;
};

export type OAuth2CallbackResult =
	| { state: string; code: string }
	| {
			state: string;
			error: string;
			errorDescription?: string | null;
	  };

export function saveOAuth2Pending(pending: OAuth2PendingResume) {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.setItem(
			oauth2PendingKey(pending.state),
			JSON.stringify(pending),
		);
		sessionStorage.setItem(OAUTH2_SAME_TAB_STATE_KEY, pending.state);
	} catch {
		// ignore
	}
}

export function loadOAuth2Pending(state: string): OAuth2PendingResume | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = sessionStorage.getItem(oauth2PendingKey(state));
		if (!raw) return null;
		return JSON.parse(raw) as OAuth2PendingResume;
	} catch {
		return null;
	}
}

export function clearOAuth2Pending(state: string) {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.removeItem(oauth2PendingKey(state));
	} catch {
		// ignore
	}
}

export function loadOAuth2Result(state: string): OAuth2CallbackResult | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = localStorage.getItem(oauth2ResultKey(state));
		if (!raw) return null;
		return JSON.parse(raw) as OAuth2CallbackResult;
	} catch {
		return null;
	}
}

export function clearOAuth2Result(state: string) {
	if (typeof window === "undefined") return;
	try {
		localStorage.removeItem(oauth2ResultKey(state));
	} catch {
		// ignore
	}
}
