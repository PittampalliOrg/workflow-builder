import "server-only";

import { readFileSync } from "node:fs";
import https from "node:https";

export const NAMESPACE =
	process.env.K8S_NAMESPACE ?? process.env.POD_NAMESPACE ?? "workflow-builder";

const SA_TOKEN_PATH =
	"/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH =
	"/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const K8S_API_HOST =
	process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
const K8S_API_PORT = Number(process.env.KUBERNETES_SERVICE_PORT ?? "443");

let cachedToken: string | null = null;
let cachedCa: string | undefined;
let caLoaded = false;

function getServiceAccountToken(): string {
	if (!cachedToken) {
		cachedToken = readFileSync(SA_TOKEN_PATH, "utf-8").trim();
	}
	return cachedToken;
}

function getCaCert(): string | undefined {
	if (!caLoaded) {
		try {
			cachedCa = readFileSync(SA_CA_PATH, "utf-8");
		} catch {
			cachedCa = undefined;
		}
		caLoaded = true;
	}
	return cachedCa;
}

export type K8sResponse<T = unknown> = {
	ok: boolean;
	status: number;
	data: T;
};

/**
 * Make an authenticated request to the K8s API server.
 * Uses in-cluster service account auth and trusts the K8s CA cert
 * via node:https (not fetch, which doesn't support custom CA).
 */
export function k8sRequest<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
): Promise<K8sResponse<T>> {
	const token = getServiceAccountToken();
	const ca = getCaCert();

	const bodyStr = body ? JSON.stringify(body) : undefined;

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: K8S_API_HOST,
				port: K8S_API_PORT,
				path,
				method,
				ca,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...(bodyStr
						? {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(bodyStr),
							}
						: {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let data: T;
					try {
						data = JSON.parse(raw) as T;
					} catch {
						data = {} as T;
					}
					resolve({
						ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
						status: res.statusCode ?? 500,
						data,
					});
				});
			},
		);

		req.on("error", reject);

		if (bodyStr) {
			req.write(bodyStr);
		}
		req.end();
	});
}
