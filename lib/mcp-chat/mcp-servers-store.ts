"use client";

import { atom } from "jotai";

export type McpServerConfig = {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
};

export type McpServerState = McpServerConfig & {
	status: "disconnected" | "connecting" | "connected" | "error";
	toolCount: number;
	tools: { name: string; description?: string }[];
	error?: string;
};

const STORAGE_KEY = "mcp-chat-servers";

type StoredServerConfig = McpServerConfig & {
	toolCount?: number;
	tools?: { name: string; description?: string }[];
};

function loadFromStorage(): McpServerState[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const configs: StoredServerConfig[] = JSON.parse(raw);
		return configs.map((c) => ({
			...c,
			status: (c.toolCount ? "connected" : "disconnected") as McpServerState["status"],
			toolCount: c.toolCount ?? 0,
			tools: c.tools ?? [],
		}));
	} catch {
		return [];
	}
}

function saveToStorage(servers: McpServerState[]) {
	if (typeof window === "undefined") return;
	const configs: StoredServerConfig[] = servers.map(
		({ id, name, url, enabled, toolCount, tools }) => ({
			id,
			name,
			url,
			enabled,
			toolCount,
			tools,
		}),
	);
	localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

// Base atom with localStorage sync
const baseServersAtom = atom<McpServerState[]>(loadFromStorage());

export const mcpServersAtom = atom(
	(get) => get(baseServersAtom),
	(
		_get,
		set,
		update: McpServerState[] | ((prev: McpServerState[]) => McpServerState[]),
	) => {
		const next =
			typeof update === "function" ? update(_get(baseServersAtom)) : update;
		set(baseServersAtom, next);
		saveToStorage(next);
	},
);

// Derived: only enabled servers
export const enabledMcpServersAtom = atom((get) => {
	return get(mcpServersAtom).filter((s) => s.enabled);
});

// Derived: { url, name }[] for API request body
export const mcpServerConfigsAtom = atom((get) => {
	return get(enabledMcpServersAtom).map(({ url, name }) => ({ url, name }));
});

// Helper: add a new server
export function addServer(
	setter: (update: (prev: McpServerState[]) => McpServerState[]) => void,
	config: { name: string; url: string },
): string {
	const id = crypto.randomUUID();
	setter((prev) => [
		...prev,
		{
			id,
			name: config.name,
			url: config.url,
			enabled: true,
			status: "disconnected",
			toolCount: 0,
			tools: [],
		},
	]);
	return id;
}

// Helper: remove a server
export function removeServer(
	setter: (update: (prev: McpServerState[]) => McpServerState[]) => void,
	id: string,
) {
	setter((prev) => prev.filter((s) => s.id !== id));
}

// Helper: toggle server enabled/disabled
export function toggleServer(
	setter: (update: (prev: McpServerState[]) => McpServerState[]) => void,
	id: string,
) {
	setter((prev) =>
		prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
	);
}

// Helper: update a server's connection status
export function updateServerStatus(
	setter: (update: (prev: McpServerState[]) => McpServerState[]) => void,
	id: string,
	status: McpServerState["status"],
	opts?: {
		toolCount?: number;
		tools?: { name: string; description?: string }[];
		error?: string;
	},
) {
	setter((prev) =>
		prev.map((s) =>
			s.id === id
				? {
						...s,
						status,
						toolCount: opts?.toolCount ?? s.toolCount,
						tools: opts?.tools ?? s.tools,
						error: opts?.error,
					}
				: s,
		),
	);
}
