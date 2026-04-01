/**
 * CNCF Serverless Workflow 1.0 Type Definitions
 *
 * Based on the official specification:
 * https://github.com/serverlessworkflow/specification/tree/main/dsl-reference
 *
 * These types can be replaced with @serverlessworkflow/sdk when it's published to npm.
 */

// ---------------------------------------------------------------------------
// Core document types
// ---------------------------------------------------------------------------

export const SW_DSL_VERSION = "1.0.0" as const;

export interface WorkflowDocument {
  dsl: typeof SW_DSL_VERSION;
  namespace: string;
  name: string;
  version: string;
  title?: string;
  summary?: string;
  tags?: Record<string, string>;
}

export interface Workflow {
  document: WorkflowDocument;
  input?: InputDefinition;
  output?: OutputDefinition;
  use?: UseDefinition;
  do: TaskItem[];
  timeout?: WorkflowTimeout;
  schedule?: Schedule;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

export interface InputDefinition {
  schema?: SchemaDefinition;
  from?: string | Record<string, unknown>;
}

export interface OutputDefinition {
  schema?: SchemaDefinition;
  as?: string | Record<string, unknown>;
}

export interface SchemaDefinition {
  format?: string;
  document?: unknown;
}

// ---------------------------------------------------------------------------
// Use (reusable components)
// ---------------------------------------------------------------------------

export interface UseDefinition {
  authentications?: Record<string, AuthenticationDefinition>;
  errors?: Record<string, ErrorDefinition>;
  extensions?: ExtensionItem[];
  functions?: Record<string, FunctionDefinition>;
  retries?: Record<string, RetryDefinition>;
  secrets?: string[];
  timeouts?: Record<string, TimeoutDefinition>;
  catalogs?: Record<string, CatalogDefinition>;
}

export interface AuthenticationDefinition {
  [key: string]: unknown;
}

export interface ErrorDefinition {
  type: string;
  status: number;
  title?: string;
  detail?: string;
  instance?: string;
}

export type ExtensionItem = Record<string, ExtensionDefinition>;

export interface ExtensionDefinition {
  extend: string;
  when?: string;
  before?: TaskItem[];
  after?: TaskItem[];
}

export interface FunctionDefinition {
  call: string;
  with?: Record<string, unknown>;
}

export interface RetryDefinition {
  when?: string;
  exceptWhen?: string;
  delay?: Duration;
  backoff?: BackoffDefinition;
  limit?: RetryLimit;
  jitter?: JitterDefinition;
}

export interface BackoffDefinition {
  constant?: Record<string, unknown>;
  exponential?: Record<string, unknown>;
  linear?: Record<string, unknown>;
}

export interface RetryLimit {
  attempt?: CountLimit;
  duration?: Duration;
}

export interface CountLimit {
  count: number;
}

export interface JitterDefinition {
  from?: Duration;
  to?: Duration;
}

export interface TimeoutDefinition {
  after: Duration;
}

export interface CatalogDefinition {
  endpoint: EndpointDefinition;
}

export interface EndpointDefinition {
  uri: string;
  authentication?: string | AuthenticationDefinition;
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

export type Duration =
  | string
  | {
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
      milliseconds?: number;
    };

// ---------------------------------------------------------------------------
// Timeout / Schedule
// ---------------------------------------------------------------------------

export interface WorkflowTimeout {
  after: Duration;
}

export interface Schedule {
  every?: Duration;
  cron?: string;
  after?: Duration;
  on?: EventConsumptionStrategy;
}

// ---------------------------------------------------------------------------
// Task types (the 12 unified tasks of SW 1.0)
// ---------------------------------------------------------------------------

export type TaskItem = Record<string, Task>;

export type Task =
  | CallTask
  | DoTask
  | ForkTask
  | EmitTask
  | ForTask
  | ListenTask
  | RaiseTask
  | RunTask
  | SetTask
  | SwitchTask
  | TryTask
  | WaitTask;

/** Fields shared by all tasks */
export interface TaskBase {
  if?: string;
  input?: InputDefinition;
  output?: OutputDefinition;
  export?: ExportDefinition;
  timeout?: TaskTimeout;
  then?: FlowDirective;
  metadata?: Record<string, unknown>;
}

export interface ExportDefinition {
  schema?: SchemaDefinition;
  as?: string | Record<string, unknown>;
}

export interface TaskTimeout {
  after: Duration;
}

export type FlowDirective = "continue" | "exit" | "end" | string;

// ---------------------------------------------------------------------------
// Call tasks
// ---------------------------------------------------------------------------

export type CallTask =
  | CallHTTPTask
  | CallGRPCTask
  | CallOpenAPITask
  | CallAsyncAPITask
  | CallFunctionTask;

export interface CallHTTPTask extends TaskBase {
  call: "http";
  with: HTTPArguments;
}

export interface HTTPArguments {
  method: string;
  endpoint: EndpointDefinition | string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
  output?: "raw" | "content" | "response";
}

export interface CallGRPCTask extends TaskBase {
  call: "grpc";
  with: GRPCArguments;
}

export interface GRPCArguments {
  proto: string;
  service: { name: string; host: string; port?: number };
  method: string;
  arguments?: Record<string, unknown>;
}

export interface CallOpenAPITask extends TaskBase {
  call: "openapi";
  with: OpenAPIArguments;
}

export interface OpenAPIArguments {
  document: string;
  operationId: string;
  parameters?: Record<string, unknown>;
  authentication?: string | AuthenticationDefinition;
  output?: "raw" | "content" | "response";
}

export interface CallAsyncAPITask extends TaskBase {
  call: "asyncapi";
  with: AsyncAPIArguments;
}

export interface AsyncAPIArguments {
  document: string;
  operationRef: string;
  server?: string;
  message?: unknown;
  binding?: unknown;
}

export interface CallFunctionTask extends TaskBase {
  call: string;
  with?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Do task (sequential sub-tasks)
// ---------------------------------------------------------------------------

export interface DoTask extends TaskBase {
  do: TaskItem[];
}

// ---------------------------------------------------------------------------
// Fork task (parallel execution)
// ---------------------------------------------------------------------------

export interface ForkTask extends TaskBase {
  fork: ForkDefinition;
}

export interface ForkDefinition {
  branches: TaskItem[];
  compete?: boolean;
}

// ---------------------------------------------------------------------------
// Emit task
// ---------------------------------------------------------------------------

export interface EmitTask extends TaskBase {
  emit: EmitDefinition;
}

export interface EmitDefinition {
  event: EventDefinition;
}

export interface EventDefinition {
  with: {
    id?: string;
    source?: string | Record<string, unknown>;
    type: string;
    time?: string;
    subject?: string;
    datacontenttype?: string;
    dataschema?: string;
    data?: unknown;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// For task (iteration)
// ---------------------------------------------------------------------------

export interface ForTask extends TaskBase {
  for: ForDefinition;
  while?: string;
  do: TaskItem[];
}

export interface ForDefinition {
  each?: string;
  in?: string;
  at?: string;
}

// ---------------------------------------------------------------------------
// Listen task (wait for events)
// ---------------------------------------------------------------------------

export interface ListenTask extends TaskBase {
  listen: ListenDefinition;
}

export interface ListenDefinition {
  to: EventConsumptionStrategy;
}

export interface EventConsumptionStrategy {
  all?: EventFilter[];
  any?: EventFilter[];
  one?: EventFilter;
}

export interface EventFilter {
  with: {
    id?: string;
    source?: string;
    type?: string;
    subject?: string;
    time?: string;
    datacontenttype?: string;
    dataschema?: string;
    data?: unknown;
    [key: string]: unknown;
  };
  correlate?: Record<string, CorrelationFilter>;
}

export interface CorrelationFilter {
  from: string;
  expect?: string;
}

// ---------------------------------------------------------------------------
// Raise task (error)
// ---------------------------------------------------------------------------

export interface RaiseTask extends TaskBase {
  raise: RaiseDefinition;
}

export interface RaiseDefinition {
  error:
    | ErrorDefinition
    | { refName: string };
}

// ---------------------------------------------------------------------------
// Run task (shell, script, container, workflow)
// ---------------------------------------------------------------------------

export interface RunTask extends TaskBase {
  run: RunDefinition;
}

export type RunDefinition =
  | RunContainerDefinition
  | RunScriptDefinition
  | RunShellDefinition
  | RunWorkflowDefinition;

export interface RunContainerDefinition {
  container: {
    image: string;
    command?: string;
    ports?: Record<string, number>;
    volumes?: Record<string, string>;
    environment?: Record<string, string>;
  };
}

export interface RunScriptDefinition {
  script: {
    language: string;
    code?: string;
    source?: { endpoint: EndpointDefinition };
    arguments?: Record<string, unknown>;
    environment?: Record<string, string>;
  };
}

export interface RunShellDefinition {
  shell: {
    command: string;
    arguments?: Record<string, unknown>;
    environment?: Record<string, string>;
  };
}

export interface RunWorkflowDefinition {
  workflow: {
    namespace: string;
    name: string;
    version: string;
    input?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Set task (variable assignment)
// ---------------------------------------------------------------------------

export interface SetTask extends TaskBase {
  set: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Switch task (conditional branching)
// ---------------------------------------------------------------------------

export interface SwitchTask extends TaskBase {
  switch: SwitchCase[];
}

export interface SwitchCase {
  [caseName: string]: SwitchCaseDefinition;
}

export interface SwitchCaseDefinition {
  when?: string;
  then?: FlowDirective;
}

// ---------------------------------------------------------------------------
// Try task (error handling)
// ---------------------------------------------------------------------------

export interface TryTask extends TaskBase {
  try: TaskItem[];
  catch: CatchDefinition;
}

export interface CatchDefinition {
  errors?: CatchErrors;
  as?: string;
  when?: string;
  exceptWhen?: string;
  retry?: string | RetryDefinition;
  do?: TaskItem[];
}

export interface CatchErrors {
  with?: {
    type?: string;
    status?: number;
    title?: string;
    detail?: string;
    instance?: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Wait task (delay)
// ---------------------------------------------------------------------------

export interface WaitTask extends TaskBase {
  wait: Duration;
}

// ---------------------------------------------------------------------------
// Task type discriminator helpers
// ---------------------------------------------------------------------------

export type TaskType =
  | "call"
  | "do"
  | "emit"
  | "for"
  | "fork"
  | "listen"
  | "raise"
  | "run"
  | "set"
  | "switch"
  | "try"
  | "wait";

/** Determine the task type from a task object */
export function getTaskType(task: Task): TaskType {
  if ("call" in task) return "call";
  if ("fork" in task) return "fork";
  if ("emit" in task) return "emit";
  if ("for" in task) return "for";
  if ("listen" in task) return "listen";
  if ("raise" in task) return "raise";
  if ("run" in task) return "run";
  if ("set" in task) return "set";
  if ("switch" in task) return "switch";
  if ("try" in task) return "try";
  if ("wait" in task) return "wait";
  if ("do" in task) return "do";
  throw new Error(`Unknown task type: ${JSON.stringify(Object.keys(task))}`);
}

/** Get the call protocol from a call task */
export function getCallProtocol(
  task: CallTask,
): "http" | "grpc" | "openapi" | "asyncapi" | "function" {
  if (task.call === "http") return "http";
  if (task.call === "grpc") return "grpc";
  if (task.call === "openapi") return "openapi";
  if (task.call === "asyncapi") return "asyncapi";
  return "function";
}

/** Extract the task name and definition from a TaskItem */
export function unwrapTaskItem(item: TaskItem): [string, Task] {
  const entries = Object.entries(item);
  if (entries.length !== 1) {
    throw new Error(
      `TaskItem must have exactly one key, got ${entries.length}`,
    );
  }
  return entries[0] as [string, Task];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateWorkflow(workflow: unknown): workflow is Workflow {
  if (typeof workflow !== "object" || workflow === null) return false;
  const w = workflow as Record<string, unknown>;
  if (typeof w.document !== "object" || w.document === null) return false;
  const doc = w.document as Record<string, unknown>;
  if (doc.dsl !== SW_DSL_VERSION) return false;
  if (typeof doc.namespace !== "string") return false;
  if (typeof doc.name !== "string") return false;
  if (typeof doc.version !== "string") return false;
  if (!Array.isArray(w.do) || w.do.length === 0) return false;
  return true;
}
