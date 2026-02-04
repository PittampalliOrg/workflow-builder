/**
 * ActivePieces Client
 *
 * HTTP client for interacting with ActivePieces API.
 * Supports piece discovery, metadata fetching, and action execution.
 */

import type {
  PieceMetadata,
  PieceSummary,
  PieceExecutionRequest,
  PieceExecutionResponse,
} from "./types.js";

/**
 * Configuration for ActivePieces client
 */
export interface ActivePiecesClientConfig {
  /** Base URL of ActivePieces instance */
  baseUrl: string;
  /** API key for authentication (if required) */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Partial<ActivePiecesClientConfig> = {
  baseUrl:
    process.env.ACTIVEPIECES_URL ||
    "https://activepieces.cnoe.localtest.me:8443",
  timeout: 30000,
};

/**
 * ActivePieces API client
 */
export class ActivePiecesClient {
  private config: Required<ActivePiecesClientConfig>;

  constructor(config?: Partial<ActivePiecesClientConfig>) {
    this.config = {
      baseUrl: config?.baseUrl || DEFAULT_CONFIG.baseUrl!,
      apiKey: config?.apiKey || process.env.ACTIVEPIECES_API_KEY || "",
      timeout: config?.timeout || DEFAULT_CONFIG.timeout!,
    };
  }

  /**
   * Build headers for API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Make an HTTP request with timeout
   */
  private async fetch<T>(
    path: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...(options?.headers || {}),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `ActivePieces API error: ${response.status} ${response.statusText} - ${errorBody}`
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `ActivePieces API timeout after ${this.config.timeout}ms`
        );
      }
      throw error;
    }
  }

  /**
   * List all available pieces
   * Note: AP returns pieces with full package names like "@activepieces/piece-slack"
   */
  async listPieces(): Promise<PieceSummary[]> {
    // ActivePieces API returns an array directly (not wrapped in { data: ... })
    const pieces = await this.fetch<
      Array<{
        name: string;
        displayName: string;
        description: string;
        logoUrl: string;
        version: string;
        categories?: string[];
        actions?: number | Record<string, unknown>;
        triggers?: number | Record<string, unknown>;
      }>
    >("/api/v1/pieces");

    return pieces.map((piece) => ({
      name: piece.name, // Full package name: @activepieces/piece-slack
      displayName: piece.displayName,
      description: piece.description,
      logoUrl: piece.logoUrl,
      version: piece.version,
      categories: piece.categories,
      // Actions/triggers can be a number (count) or an object (full details)
      actionCount: typeof piece.actions === "number" ? piece.actions : Object.keys(piece.actions || {}).length,
      triggerCount: typeof piece.triggers === "number" ? piece.triggers : Object.keys(piece.triggers || {}).length,
    }));
  }

  /**
   * Extract short name from full package name
   * e.g., "@activepieces/piece-slack" -> "slack"
   */
  static extractShortName(fullName: string): string {
    const match = fullName.match(/@activepieces\/piece-(.+)/);
    return match ? match[1] : fullName;
  }

  /**
   * Convert short name to full package name
   * e.g., "slack" -> "@activepieces/piece-slack"
   */
  static toFullName(shortName: string): string {
    if (shortName.startsWith("@activepieces/")) {
      return shortName;
    }
    return `@activepieces/piece-${shortName}`;
  }

  /**
   * Get detailed metadata for a specific piece
   * @param pieceName - Can be short name ("slack") or full name ("@activepieces/piece-slack")
   */
  async getPieceMetadata(pieceName: string): Promise<PieceMetadata> {
    // Convert to full name if needed
    const fullName = ActivePiecesClient.toFullName(pieceName);
    // URL encode the @ symbol and slashes
    const encodedName = encodeURIComponent(fullName);
    return this.fetch<PieceMetadata>(`/api/v1/pieces/${encodedName}`);
  }

  /**
   * Execute a piece action
   *
   * This calls the ActivePieces execution endpoint.
   * Note: This requires an adapter endpoint in ActivePieces or a proxy service.
   */
  async executeAction(
    request: PieceExecutionRequest
  ): Promise<PieceExecutionResponse> {
    const startTime = Date.now();

    try {
      const response = await this.fetch<{
        success?: boolean;
        output?: unknown;
        error?: { message: string; code?: string; details?: unknown };
      }>(`/api/v1/pieces/${request.pieceName}/actions/${request.actionName}/execute`, {
        method: "POST",
        body: JSON.stringify({
          pieceVersion: request.pieceVersion,
          input: request.input,
          auth: request.auth,
          serverUrl: request.serverUrl,
        }),
      });

      return {
        success: response.success !== false,
        output: response.output,
        error: response.error,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "EXECUTION_FAILED",
        },
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if ActivePieces is reachable
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.fetch<{ status: string }>("/api/v1/health");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get piece logo URL
   */
  getPieceLogoUrl(pieceName: string): string {
    return `${this.config.baseUrl}/api/v1/pieces/${pieceName}/logo`;
  }
}

/**
 * Singleton client instance
 */
let clientInstance: ActivePiecesClient | null = null;

/**
 * Get or create the ActivePieces client
 */
export function getActivePiecesClient(
  config?: Partial<ActivePiecesClientConfig>
): ActivePiecesClient {
  if (!clientInstance || config) {
    clientInstance = new ActivePiecesClient(config);
  }
  return clientInstance;
}

/**
 * Generate the webhook URL for calling an ActivePieces action
 * This URL is stored in the functions table for HTTP execution
 * @param baseUrl - ActivePieces base URL
 * @param pieceName - Short name ("slack") or full name ("@activepieces/piece-slack")
 * @param actionName - Action name (e.g., "send_channel_message")
 */
export function generatePieceWebhookUrl(
  baseUrl: string,
  pieceName: string,
  actionName: string
): string {
  const fullName = ActivePiecesClient.toFullName(pieceName);
  const encodedName = encodeURIComponent(fullName);
  return `${baseUrl}/api/v1/pieces/${encodedName}/actions/${actionName}/execute`;
}
