import http from "node:http";
import https from "node:https";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export function postBrowserLease({
	baseUrl,
	apiKey,
	body = "{}",
	signal,
	timeoutMs = 30_000,
}) {
	const url = new URL(`${baseUrl.replace(/\/$/, "")}/browsers`);
	const transport =
		url.protocol === "http:"
			? http
			: url.protocol === "https:"
				? https
				: null;
	if (!transport) {
		throw new Error(
			`unsupported BrowserStation lease URL protocol: ${url.protocol}`,
		);
	}

	const payload = Buffer.from(body);
	return new Promise((resolve, reject) => {
		let settled = false;
		let totalTimeout;
		const settle = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(totalTimeout);
			callback(value);
		};
		const fail = (error) => settle(reject, error);
		const request = transport.request(
			url,
			{
				method: "POST",
				agent: false,
				signal,
				headers: {
					"X-API-Key": apiKey,
					"Content-Type": "application/json",
					"Content-Length": payload.byteLength,
					Connection: "close",
				},
			},
			(response) => {
				const chunks = [];
				let received = 0;
				response.on("aborted", () => {
					fail(new Error("BrowserStation lease response was aborted"));
				});
				response.on("error", fail);
				response.on("data", (chunk) => {
					received += chunk.length;
					if (received > MAX_RESPONSE_BYTES) {
						const error = new Error(
							"BrowserStation lease response exceeded 1 MiB",
						);
						response.destroy(error);
						fail(error);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					const responseBody = Buffer.concat(chunks).toString("utf8");
					const status = response.statusCode || 0;
					settle(resolve, {
						ok: status >= 200 && status < 300,
						status,
						json: async () => JSON.parse(responseBody),
					});
				});
			},
		);
		request.on("error", fail);
		totalTimeout = setTimeout(() => {
			const error = new Error(
				`BrowserStation lease request exceeded ${timeoutMs}ms`,
			);
			request.destroy(error);
			fail(error);
		}, timeoutMs);
		totalTimeout.unref();
		request.end(payload);
	});
}
