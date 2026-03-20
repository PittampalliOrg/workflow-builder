import { c as createServerRpc } from './createServerRpc-Bd3B-Ah9.mjs';
import { c as createServerFn, e as eventBus } from '../virtual/entry.mjs';
import '@opentelemetry/auto-instrumentations-node';
import '@opentelemetry/exporter-metrics-otlp-http';
import '@opentelemetry/exporter-trace-otlp-http';
import '@opentelemetry/resources';
import '@opentelemetry/sdk-metrics';
import '@opentelemetry/sdk-node';
import 'node:events';
import 'nanoid';
import '@mastra/core/agent';
import '@mastra/core/workspace';
import '@ai-sdk/openai';
import 'node:https';
import 'node:fs';
import 'node:path';
import '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import '@modelcontextprotocol/sdk/types.js';
import '@modelcontextprotocol/sdk/server/mcp.js';
import '@modelcontextprotocol/ext-apps/server';
import '@tanstack/history';
import '@tanstack/router-core/ssr/client';
import '@tanstack/router-core';
import 'node:async_hooks';
import '@tanstack/router-core/ssr/server';
import 'rou3';
import 'srvx';
import 'tiny-invariant';
import 'seroval';
import 'react/jsx-runtime';
import '@tanstack/react-router/ssr/server';
import '@tanstack/react-router';

const getAgentStatus_createServerFn_handler = createServerRpc({
  id: "c2190f694674deb252b7214facce7decd815b3f40ec90880bdf451b295395816",
  name: "getAgentStatus",
  filename: "src/server-functions/get-agent-status.ts"
}, (opts) => getAgentStatus.__executeServer(opts));
const getAgentStatus = createServerFn({
  method: "GET"
}).handler(getAgentStatus_createServerFn_handler, async () => {
  return eventBus.getState();
});

export { getAgentStatus_createServerFn_handler };
//# sourceMappingURL=get-agent-status-Co1cEXS2.mjs.map
