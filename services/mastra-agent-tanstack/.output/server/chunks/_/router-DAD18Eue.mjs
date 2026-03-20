import { createRouter as createRouter$1, createRootRoute, HeadContent, Outlet, Scripts, createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { jsxs, jsx } from 'react/jsx-runtime';
import { c as createServerFn, T as TSS_SERVER_FUNCTION, g as getServerFnById } from '../virtual/entry.mjs';
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
import '@tanstack/react-router/ssr/server';

const Route$1 = createRootRoute({
  component: RootComponent,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Mastra Agent \u2014 TanStack Start" }
    ],
    links: [
      {
        rel: "icon",
        href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F916}</text></svg>"
      }
    ]
  })
});
function RootComponent() {
  return /* @__PURE__ */ jsxs("html", { lang: "en", children: [
    /* @__PURE__ */ jsx("head", { children: /* @__PURE__ */ jsx(HeadContent, {}) }),
    /* @__PURE__ */ jsxs("body", { children: [
      /* @__PURE__ */ jsx(Outlet, {}),
      /* @__PURE__ */ jsx(Scripts, {})
    ] })
  ] });
}
const createSsrRpc = (functionId, importer) => {
  const url = "/_serverFn/" + functionId;
  const serverFnMeta = { id: functionId };
  const fn = async (...args) => {
    const serverFn = await getServerFnById(functionId);
    return serverFn(...args);
  };
  return Object.assign(fn, {
    url,
    serverFnMeta,
    [TSS_SERVER_FUNCTION]: true
  });
};
const getAgentStatus = createServerFn({
  method: "GET"
}).handler(createSsrRpc("c2190f694674deb252b7214facce7decd815b3f40ec90880bdf451b295395816"));
const getEventHistory = createServerFn({
  method: "GET"
}).handler(createSsrRpc("430fbd91a27f75fcbbd67ff6fa09d374f4e28b04698356d7a083b92661518d0d"));
const getWorkflowContext = createServerFn({
  method: "GET"
}).handler(createSsrRpc("fa80303f6b06a0281717b22d3d88760d9c1359d9352484d0471ef3847d095e60"));
const $$splitComponentImporter = () => import('./index-s1L02IHO.mjs');
const Route = createFileRoute("/")({
  loader: async () => {
    try {
      const [state, events, workflow] = await Promise.all([getAgentStatus(), getEventHistory(), getWorkflowContext()]);
      return {
        state,
        events,
        workflow
      };
    } catch (err) {
      console.error("[mastra-tanstack] Loader error:", err);
      return {
        state: null,
        events: null,
        workflow: null
      };
    }
  },
  component: lazyRouteComponent($$splitComponentImporter, "component")
});
const IndexRoute = Route.update({
  id: "/",
  path: "/",
  getParentRoute: () => Route$1
});
const rootRouteChildren = {
  IndexRoute
};
const routeTree = Route$1._addFileChildren(rootRouteChildren)._addFileTypes();
function createRouter() {
  const router2 = createRouter$1({
    routeTree,
    scrollRestoration: true
  });
  return router2;
}
const getRouter = createRouter;
const router = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  createRouter,
  getRouter
}, Symbol.toStringTag, { value: "Module" }));

export { Route as R, getEventHistory as a, getWorkflowContext as b, getAgentStatus as g, router as r };
//# sourceMappingURL=router-DAD18Eue.mjs.map
