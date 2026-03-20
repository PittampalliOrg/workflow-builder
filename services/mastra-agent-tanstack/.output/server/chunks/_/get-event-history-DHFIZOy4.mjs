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

const getEventHistory_createServerFn_handler = createServerRpc({
  id: "430fbd91a27f75fcbbd67ff6fa09d374f4e28b04698356d7a083b92661518d0d",
  name: "getEventHistory",
  filename: "src/server-functions/get-event-history.ts"
}, (opts) => getEventHistory.__executeServer(opts));
const getEventHistory = createServerFn({
  method: "GET"
}).handler(getEventHistory_createServerFn_handler, async () => {
  return eventBus.getRecentEvents(100);
});

export { getEventHistory_createServerFn_handler };
//# sourceMappingURL=get-event-history-DHFIZOy4.mjs.map
