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

const getWorkflowContext_createServerFn_handler = createServerRpc({
  id: "fa80303f6b06a0281717b22d3d88760d9c1359d9352484d0471ef3847d095e60",
  name: "getWorkflowContext",
  filename: "src/server-functions/get-workflow-context.ts"
}, (opts) => getWorkflowContext.__executeServer(opts));
const getWorkflowContext = createServerFn({
  method: "GET"
}).handler(getWorkflowContext_createServerFn_handler, async () => {
  return eventBus.getWorkflowContext();
});

export { getWorkflowContext_createServerFn_handler };
//# sourceMappingURL=get-workflow-context-MYEm6bMd.mjs.map
