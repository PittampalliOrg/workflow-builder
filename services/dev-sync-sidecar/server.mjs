import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * dev-sync-sidecar — a language-agnostic live-sync receiver.
 *
 * Generalizes workflow-builder's in-process Vite `/__sync` plugin so ANY
 * microservice dev image works unchanged: this runs as a SIDECAR container next
 * to the service's hot-reload dev server (vite / `uvicorn --reload` / `tsx
 * watch`), sharing an `emptyDir` mounted at the service workdir. An agent POSTs a
 * tar.gz of edited source here; we untar it into the shared workdir on the pod's
 * LOCAL disk → the dev server's inotify watcher fires → hot-reload in seconds.
 * (inotify works on emptyDir; it does NOT on the JuiceFS shared workspace, which
 * is why edits travel as an HTTP push, never a network-FS mount — same rationale
 * as the P2 Vite plugin.)
 *
 * Env:
 *   DEV_SYNC_PORT   (default 8001)   — listen port
 *   DEV_SYNC_DEST   (default /app)   — untar destination (the service workdir)
 *   DEV_SYNC_TOKEN  (optional)       — if set, require matching `x-sync-token`
 *
 * Endpoints: POST /__sync (tar.gz body) · GET /healthz
 */

const PORT = Number(process.env.DEV_SYNC_PORT || 8001);
const DEST = process.env.DEV_SYNC_DEST || '/app';
const TOKEN = process.env.DEV_SYNC_TOKEN || '';
const MAX = 256 * 1024 * 1024; // 256 MiB ceiling

function reply(res, code, body) {
	try {
		res.statusCode = code;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(body));
	} catch {
		/* socket already gone */
	}
}

const server = http.createServer((req, res) => {
	const url = (req.url || '').split('?')[0];

	if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
		return reply(res, 200, { ok: true, service: 'dev-sync-sidecar', dest: DEST });
	}
	if (url !== '/__sync') return reply(res, 404, { ok: false, error: 'not found' });
	if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
	if (TOKEN && req.headers['x-sync-token'] !== TOKEN)
		return reply(res, 401, { ok: false, error: 'unauthorized' });

	// Buffer the whole body first (do NOT pipe straight into tar.stdin — a tar
	// that dies on a partial gzip raises an unhandled EPIPE; swallow request
	// errors so a dropped upload can never crash the sidecar). Same shape as the
	// proven Vite plugin.
	const chunks = [];
	let total = 0;
	let aborted = false;
	req.on('error', () => {
		aborted = true;
	});
	req.on('aborted', () => {
		aborted = true;
	});
	req.on('data', (c) => {
		total += c.length;
		if (total > MAX) {
			aborted = true;
			req.destroy();
			return;
		}
		chunks.push(c);
	});
	req.on('end', () => {
		if (aborted) return reply(res, 400, { ok: false, error: 'aborted or too large' });
		const tmp = path.join(os.tmpdir(), `dev-sync-${process.pid}-${total}.tgz`);
		let buf;
		try {
			buf = Buffer.concat(chunks);
			fs.writeFileSync(tmp, buf);
			fs.mkdirSync(DEST, { recursive: true });
		} catch (e) {
			return reply(res, 500, { ok: false, error: `buffer/write: ${e.message}` });
		}
		const cleanup = () => {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		};
		// busybox tar (alpine): `-o` = don't restore user:group; busybox strips a
		// leading '/' itself. The producer archives relative paths.
		const tar = spawn('tar', ['-xzf', tmp, '-C', DEST, '-o'], {
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let errout = '';
		tar.stderr.on('data', (d) => (errout += String(d)));
		tar.on('error', (e) => {
			cleanup();
			reply(res, 500, { ok: false, error: `tar spawn: ${e.message}` });
		});
		tar.on('close', (code) => {
			cleanup();
			if (code === 0) {
				console.log(`[dev-sync-sidecar] applied sync (${buf.length}B) → ${DEST}`);
				reply(res, 200, { ok: true, bytes: buf.length, dest: DEST });
			} else {
				reply(res, 500, { ok: false, error: errout.slice(0, 500) || `tar exit ${code}` });
			}
		});
	});
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`[dev-sync-sidecar] listening on :${PORT} → ${DEST}`);
});
