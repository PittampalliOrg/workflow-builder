/**
 * WebSocket dialer for the upstream KueueViz backend.
 *
 * Wraps `ws@8.20.0` with the bits we need:
 *   - Mandatory `kueueviz.v1` subprotocol negotiation.
 *   - Optional bearer token via the `kueueviz.auth.<base64url>` subprotocol
 *     prefix (KueueViz' undocumented WS-auth scheme — see
 *     `cmd/kueueviz/backend/middleware/auth.go::extractToken`).
 *   - JSON framing: every message is a complete JSON document.
 *
 * Browsers can't set custom WS headers, but server-side `ws` can.
 * For now `KUEUEVIZ_AUTH_MODE=Disabled` (chart default) — token is wired
 * but unused. Flipping to TokenReview becomes a one-line stacks change.
 */

import { env as privEnv } from '$env/dynamic/private';
import WebSocket from 'ws';

const SUBPROTOCOL = 'kueueviz.v1';

function backendBaseUrl(): string {
	const raw = (
		privEnv.KUEUEVIZ_BACKEND_URL ??
		process.env.KUEUEVIZ_BACKEND_URL ??
		'http://kueue-kueueviz-backend.kueue-system.svc.cluster.local:8080'
	).trim();
	return raw.replace(/\/+$/, '');
}

function authToken(): string | null {
	const raw = (
		privEnv.KUEUEVIZ_AUTH_TOKEN ??
		process.env.KUEUEVIZ_AUTH_TOKEN ??
		''
	).trim();
	return raw || null;
}

function toBase64Url(value: string): string {
	return Buffer.from(value, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function toWsUrl(httpUrl: string, path: string, query: Record<string, string>): string {
	const url = new URL(httpUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = path.startsWith('/') ? path : `/${path}`;
	for (const [k, v] of Object.entries(query)) {
		if (v) url.searchParams.set(k, v);
	}
	return url.toString();
}

export type WsClientOptions = {
	path: string;
	query?: Record<string, string>;
};

export function dialKueueViz(options: WsClientOptions): WebSocket {
	const url = toWsUrl(backendBaseUrl(), options.path, options.query ?? {});
	const protocols: string[] = [SUBPROTOCOL];
	const token = authToken();
	if (token) protocols.push(`kueueviz.auth.${toBase64Url(token)}`);
	return new WebSocket(url, protocols, {
		// Match the upstream React client — server negotiates kueueviz.v1
		// and either rejects or echoes it back. We validate on 'open'.
		handshakeTimeout: 10_000,
	});
}

/** Lift a string `Buffer | ArrayBuffer | Buffer[]` payload to a string. */
export function payloadToString(data: WebSocket.Data): string {
	if (typeof data === 'string') return data;
	if (Buffer.isBuffer(data)) return data.toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
	return '';
}

export const WS_SUBPROTOCOL = SUBPROTOCOL;
