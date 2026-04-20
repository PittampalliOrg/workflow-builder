import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import net from 'node:net';

import { verifyAccessToken } from './auth';
import { ACCESS_TOKEN_COOKIE } from './auth';
import { getAgentRuntimePodIP } from './kube/client';
import { db } from './db';
import { agents, sessions } from './db/schema';
import { and, eq } from 'drizzle-orm';

const VNC_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/browser\/vnc$/;
const IDLE_MS = 10 * 60 * 1000; // 10 min inactivity cap

const wss = new WebSocketServer({ noServer: true });

function readCookie(raw: string | undefined, name: string): string | undefined {
	if (!raw) return undefined;
	for (const part of raw.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v ?? '');
	}
	return undefined;
}

async function authenticate(req: IncomingMessage): Promise<{ userId: string; projectId?: string } | null> {
	const auth = req.headers.authorization;
	let token: string | undefined;
	if (auth?.startsWith('Bearer ')) token = auth.slice(7);
	else token = readCookie(req.headers.cookie, ACCESS_TOKEN_COOKIE);
	if (!token) return null;
	const payload = await verifyAccessToken(token);
	if (!payload?.sub) return null;
	return {
		userId: payload.sub,
		projectId: (payload as { projectId?: string }).projectId,
	};
}

/**
 * Resolve session -> agent slug. Enforces workspace scope when the caller has
 * an active projectId (matches the agent-runtime route policy). Returns null
 * on any mismatch so the proxy can close the socket without leaking info.
 */
async function resolveAgentSlug(sessionId: string, projectId?: string): Promise<string | null> {
	if (!db) return null;
	const rows = await db
		.select({ slug: agents.slug, projectId: agents.projectId })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(
			and(
				eq(sessions.id, sessionId),
				projectId ? eq(agents.projectId, projectId) : undefined,
			),
		)
		.limit(1);
	return rows[0]?.slug ?? null;
}

/**
 * Decide whether to forward an RFB client -> server message. In viewOnly mode
 * we drop keyboard, pointer, and clipboard messages so a user watching a
 * session can't accidentally (or intentionally) drive the agent's browser.
 *
 * RFB 3.8 client-to-server message types:
 *   0x00 SetPixelFormat       — allow (display tuning)
 *   0x02 SetEncodings         — allow (display tuning)
 *   0x03 FramebufferUpdateReq — allow (we need this to get frames)
 *   0x04 KeyEvent             — block
 *   0x05 PointerEvent         — block
 *   0x06 ClientCutText        — block (client->server paste)
 *
 * Messages come over TCP as a byte stream and can straddle packet
 * boundaries, so we run a small parser that knows each message's total
 * length, buffers until the complete message is in hand, and then either
 * forwards it or drops it. We also skip the first 12 bytes of the initial
 * protocol handshake ("RFB 003.008\n") — that's server->client, so our
 * client->server filter never sees it.
 */
class RFBViewOnlyFilter {
	// Use a plain Uint8Array-backed buffer so the @types/node generic on
	// `Buffer<ArrayBufferLike>` doesn't end up fighting itself when we do
	// Buffer.concat(). We cast at the Buffer.concat boundary.
	private buf: Buffer = Buffer.alloc(0);

	/** Handshake finishes once the client has sent 12 bytes of "RFB 003.xxx\n". */
	private handshakeBytesLeft = 12;
	private securityTypeSent = false;
	private clientInitSent = false;

	/** Feed a chunk; return the bytes that should be forwarded upstream. */
	feed(chunk: Buffer): Buffer {
		this.buf = (this.buf.length
			? Buffer.concat([this.buf, chunk])
			: chunk) as Buffer;
		const out: Buffer[] = [];
		// Handshake + init: forward as-is. The client sends:
		//   12 bytes: ProtocolVersion
		//   1  byte:  SecurityType pick
		//   1  byte:  ClientInit shared-flag
		if (this.handshakeBytesLeft > 0) {
			const take = Math.min(this.handshakeBytesLeft, this.buf.length);
			out.push(this.buf.subarray(0, take));
			this.handshakeBytesLeft -= take;
			this.buf = this.buf.subarray(take);
		}
		if (this.handshakeBytesLeft === 0 && !this.securityTypeSent && this.buf.length >= 1) {
			out.push(this.buf.subarray(0, 1));
			this.buf = this.buf.subarray(1);
			this.securityTypeSent = true;
		}
		if (this.securityTypeSent && !this.clientInitSent && this.buf.length >= 1) {
			out.push(this.buf.subarray(0, 1));
			this.buf = this.buf.subarray(1);
			this.clientInitSent = true;
		}

		// Post-init: framed messages.
		while (this.clientInitSent && this.buf.length >= 1) {
			const type = this.buf[0];
			const len = this.messageLen(type);
			if (len === null) return Buffer.concat(out); // unknown -> wait for more bytes (shouldn't happen on a well-formed stream)
			if (this.buf.length < len) break;
			const msg = this.buf.subarray(0, len);
			this.buf = this.buf.subarray(len);
			if (type === 0x00 || type === 0x02 || type === 0x03) {
				out.push(msg);
			}
			// 0x04 KeyEvent, 0x05 PointerEvent, 0x06 ClientCutText: dropped.
		}
		return Buffer.concat(out);
	}

	/** RFB 3.8 client-to-server message sizes. `null` if we need to peek
	 * more bytes to determine the length (variable-length messages). */
	private messageLen(type: number): number | null {
		if (type === 0x00) return 20; // SetPixelFormat
		if (type === 0x02) {
			// SetEncodings: 4-byte header + 4*num
			if (this.buf.length < 4) return null;
			const num = this.buf.readUInt16BE(2);
			return 4 + 4 * num;
		}
		if (type === 0x03) return 10; // FramebufferUpdateRequest
		if (type === 0x04) return 8; // KeyEvent
		if (type === 0x05) return 6; // PointerEvent
		if (type === 0x06) {
			// ClientCutText: 8-byte header + length
			if (this.buf.length < 8) return null;
			const len = this.buf.readUInt32BE(4);
			return 8 + len;
		}
		// Unknown client-to-server type — be conservative and drop one byte
		// so we don't wedge. Extension messages (QEMU, tight, etc.) shouldn't
		// reach us because we wouldn't advertise them.
		return 1;
	}
}

export async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const match = url.pathname.match(VNC_PATH_RE);
	if (!match) return false;

	const sessionId = decodeURIComponent(match[1]);
	const viewOnly = url.searchParams.get('viewOnly') !== '0'; // default on
	const session = await authenticate(req);
	if (!session) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return true;
	}
	const slug = await resolveAgentSlug(sessionId, session.projectId);
	if (!slug) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
		socket.destroy();
		return true;
	}
	const podIP = await getAgentRuntimePodIP(slug);
	if (!podIP) {
		socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
		socket.destroy();
		return true;
	}

	wss.handleUpgrade(req, socket, head, (browserWs) => {
		const tcp = net.createConnection({ host: podIP, port: 5901 });
		const filter = viewOnly ? new RFBViewOnlyFilter() : null;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const bumpIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				try {
					browserWs.close(1000, 'idle timeout');
				} catch {
					/* noop */
				}
				try {
					tcp.destroy();
				} catch {
					/* noop */
				}
			}, IDLE_MS);
		};
		bumpIdle();

		browserWs.on('message', (data, isBinary) => {
			bumpIdle();
			if (!isBinary) return; // RFB is binary; ignore text
			// `ws` gives us Buffer|ArrayBuffer|Buffer[]; normalize to Buffer.
			let buf: Buffer;
			if (Buffer.isBuffer(data)) buf = data;
			else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
			else buf = Buffer.concat(data as Buffer[]);
			const forwarded = filter ? filter.feed(buf) : buf;
			if (forwarded.length && !tcp.destroyed) tcp.write(forwarded);
		});

		tcp.on('data', (data) => {
			bumpIdle();
			if (browserWs.readyState === WebSocket.OPEN) {
				browserWs.send(data, { binary: true });
			}
		});

		const closeBoth = (code = 1006, reason = 'closed') => {
			if (idleTimer) clearTimeout(idleTimer);
			try {
				if (browserWs.readyState === WebSocket.OPEN) browserWs.close(code, reason.slice(0, 123));
			} catch {
				/* noop */
			}
			try {
				if (!tcp.destroyed) tcp.destroy();
			} catch {
				/* noop */
			}
		};

		tcp.on('close', () => closeBoth(1000, 'upstream closed'));
		tcp.on('error', () => closeBoth(1011, 'upstream error'));
		browserWs.on('close', () => closeBoth());
		browserWs.on('error', () => closeBoth(1011, 'client error'));
	});

	return true;
}
