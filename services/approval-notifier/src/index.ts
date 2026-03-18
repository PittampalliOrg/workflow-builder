import { createServer } from "node:http";
import {
	deliverApprovalRequestedNotification,
	getServerConfig,
	parseJsonBody,
	parseReceivers,
} from "./service.js";

const config = getServerConfig();

function sendJson(
	response: import("node:http").ServerResponse,
	statusCode: number,
	body: unknown,
) {
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
	const method = request.method || "GET";
	const url = request.url || "/";

	if (method === "GET" && url === "/healthz") {
		return sendJson(response, 200, {
			status: "healthy",
			service: "approval-notifier",
		});
	}

	if (method === "GET" && url === "/readyz") {
		return sendJson(response, 200, {
			status: "ready",
			service: "approval-notifier",
		});
	}

	if (method === "GET" && url === "/dapr/subscribe") {
		return sendJson(response, 200, [
			{
				pubsubname: config.pubsubName,
				topic: config.topic,
				route: "/subscriptions/workflow-events",
				routes: {
					rules: [
						{
							match: 'event.type == "workflow.approval.requested"',
							path: "/subscriptions/workflow-events",
						},
					],
					default: "/subscriptions/workflow-events",
				},
			},
		]);
	}

	if (method === "POST" && url === "/subscriptions/workflow-events") {
		try {
			const body = await parseJsonBody(request);
			const event =
				body && typeof body === "object" && !Array.isArray(body) ? body : {};
			const result = await deliverApprovalRequestedNotification(event, {
				receivers: parseReceivers(config.receiversJson),
				workflowBuilderBaseUrl: config.workflowBuilderBaseUrl,
				stateStoreName: config.stateStoreName,
				daprHttpBaseUrl: config.daprHttpBaseUrl,
			});
			return sendJson(response, 200, { status: "SUCCESS", result });
		} catch (error) {
			return sendJson(response, 200, {
				status: "SUCCESS",
				error: error instanceof Error ? error.message : "notification failed",
			});
		}
	}

	return sendJson(response, 404, { error: "Not found" });
});

server.listen(config.port, config.host, () => {
	console.log(
		`approval-notifier listening on ${config.host}:${config.port} topic=${config.topic}`,
	);
});
