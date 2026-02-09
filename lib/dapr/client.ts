/**
 * Dapr Client for Workflow Builder
 * Provides configuration, secrets, and service invocation via Dapr HTTP API
 */

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";

function daprUrl(path: string): string {
  return `http://${DAPR_HOST}:${DAPR_HTTP_PORT}${path}`;
}

// ============================================================================
// Health & Metadata
// ============================================================================

/**
 * Check if Dapr sidecar is available
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const response = await fetch(daprUrl("/v1.0/healthz"), {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get Dapr sidecar metadata
 */
export async function getMetadata(): Promise<{
  id: string;
  runtimeVersion: string;
  components: Array<{ name: string; type: string }>;
} | null> {
  try {
    const response = await fetch(daprUrl("/v1.0/metadata"), {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  }
}

// ============================================================================
// Configuration API
// ============================================================================

export type ConfigurationItem = {
  value: string;
  version?: string;
  metadata?: Record<string, string>;
};

export type ConfigurationOptions = {
  label?: string;
  metadata?: Record<string, string>;
};

/**
 * Get configuration values from a Dapr configuration store
 */
export async function getConfiguration(
  storeName: string,
  keys: string[],
  options?: ConfigurationOptions
): Promise<Record<string, ConfigurationItem>> {
  try {
    const url = new URL(daprUrl(`/v1.0/configuration/${storeName}`));

    for (const k of keys) {
      url.searchParams.append("key", k);
    }

    if (options?.label) {
      url.searchParams.set("metadata.label", options.label);
    }

    if (options?.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        url.searchParams.set(`metadata.${key}`, value);
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Configuration get failed: ${response.status}`);
    }

    return (await response.json()) as Record<string, ConfigurationItem>;
  } catch (error) {
    console.error(
      `[Dapr] Failed to get configuration from ${storeName}:`,
      error
    );
    throw error;
  }
}

// ============================================================================
// Secrets API
// ============================================================================

/**
 * Get a single secret from a Dapr secrets store
 */
export async function getSecret(
  storeName: string,
  secretName: string
): Promise<string> {
  try {
    const response = await fetch(
      daprUrl(`/v1.0/secrets/${storeName}/${encodeURIComponent(secretName)}`),
      {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      throw new Error(`Secret get failed: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, string>;
    // Dapr returns a map of key -> value for the requested secret.
    // Secret stores like Azure Key Vault typically return a single entry keyed by secretName.
    // Kubernetes secrets may return multiple keys and require callers to choose the key.
    if (secretName in data) {
      return data[secretName] ?? "";
    }
    const values = Object.values(data);
    if (values.length === 1) {
      return values[0] ?? "";
    }
    throw new Error(
      `Secret '${secretName}' contains multiple keys; use getSecretMap() to select the desired key`
    );
  } catch (error) {
    console.error(
      `[Dapr] Failed to get secret ${secretName} from ${storeName}:`,
      error
    );
    throw error;
  }
}

/**
 * Get the full key/value map for a secret from a Dapr secrets store.
 * Useful for Kubernetes secrets that contain multiple keys.
 */
export async function getSecretMap(
  storeName: string,
  secretName: string
): Promise<Record<string, string>> {
  const response = await fetch(
    daprUrl(`/v1.0/secrets/${storeName}/${encodeURIComponent(secretName)}`),
    {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    }
  );

  if (!response.ok) {
    throw new Error(`Secret get failed: ${response.status}`);
  }

  return (await response.json()) as Record<string, string>;
}

/**
 * Get all secrets from a Dapr secrets store (bulk operation)
 */
export async function getBulkSecrets(
  storeName: string
): Promise<Record<string, string>> {
  try {
    const response = await fetch(daprUrl(`/v1.0/secrets/${storeName}/bulk`), {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Bulk secrets get failed: ${response.status}`);
    }

    const data = (await response.json()) as Record<
      string,
      Record<string, string>
    >;

    // Flatten { secretName: { secretName: value } } to { secretName: value }
    const flattened: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      flattened[key] = Object.values(value)[0] ?? "";
    }

    return flattened;
  } catch (error) {
    console.error(
      `[Dapr] Failed to get bulk secrets from ${storeName}:`,
      error
    );
    throw error;
  }
}

// ============================================================================
// Service Invocation API
// ============================================================================

export type ServiceInvokeOptions = {
  appId: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
};

export type ServiceInvokeResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  data: T | null;
};

/**
 * Invoke a Dapr service using the dapr-app-id header pattern
 */
export async function invokeService<T = unknown>(
  options: ServiceInvokeOptions
): Promise<ServiceInvokeResponse<T>> {
  const {
    appId,
    method = "GET",
    path,
    body,
    headers = {},
    timeout = 30_000,
  } = options;

  const requestHeaders: Record<string, string> = {
    "dapr-app-id": appId,
    "Content-Type": "application/json",
    ...headers,
  };

  try {
    const response = await fetch(daprUrl(path), {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });

    let data: T | null = null;
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      try {
        data = (await response.json()) as T;
      } catch {
        data = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
    };
  } catch (error) {
    console.error(
      `[Dapr] Service invocation failed for ${appId}${path}:`,
      error
    );

    const isTimeout =
      error instanceof DOMException && error.name === "TimeoutError";
    return {
      ok: false,
      status: isTimeout ? 504 : 500,
      statusText: isTimeout ? "Gateway Timeout" : "Internal Server Error",
      data: null,
    };
  }
}
