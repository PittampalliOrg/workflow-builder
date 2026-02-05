/**
 * External Event Route
 *
 * Persists external event records (approval requests, responses, timeouts)
 * to the workflow_external_events table for audit trail purposes.
 *
 * Called by workflow-orchestrator via Dapr service invocation.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSql } from "../core/db.js";

// External event types
const ExternalEventTypeSchema = z.enum([
  "approval_request",
  "approval_response",
  "timeout",
]);

// Request body schema
const ExternalEventRequestSchema = z.object({
  execution_id: z.string().min(1),
  node_id: z.string().min(1),
  event_name: z.string().min(1),
  event_type: ExternalEventTypeSchema,
  timeout_seconds: z.number().optional(),
  approved: z.boolean().optional(),
  reason: z.string().optional(),
  responded_by: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

type ExternalEventRequest = z.infer<typeof ExternalEventRequestSchema>;

interface ExternalEventResponse {
  success: boolean;
  event_id?: string;
  error?: string;
}

/**
 * Generate a random ID for event records
 */
function generateEventId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function externalEventRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /external-event - Log an external event for audit trail
   */
  app.post<{ Body: ExternalEventRequest }>(
    "/external-event",
    async (request, reply) => {
      // Validate request body
      const parseResult = ExternalEventRequestSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: "Validation failed",
          details: parseResult.error.issues,
        } as ExternalEventResponse);
      }

      const body = parseResult.data;
      const sql = getSql();
      const eventId = generateEventId();
      const now = new Date();

      console.log(
        `[External Event Route] Logging ${body.event_type} for event: ${body.event_name}`
      );

      try {
        // Calculate expiration for approval requests
        let expiresAt: Date | null = null;
        if (body.event_type === "approval_request" && body.timeout_seconds) {
          expiresAt = new Date(now.getTime() + body.timeout_seconds * 1000);
        }

        // Determine timestamps based on event type
        const requestedAt =
          body.event_type === "approval_request" ? now : null;
        const respondedAt =
          body.event_type === "approval_response" ||
          body.event_type === "timeout"
            ? now
            : null;

        await sql`
          INSERT INTO workflow_external_events (
            id, execution_id, node_id, event_name, event_type,
            requested_at, timeout_seconds, expires_at,
            responded_at, approved, reason, responded_by,
            payload, created_at
          ) VALUES (
            ${eventId},
            ${body.execution_id},
            ${body.node_id},
            ${body.event_name},
            ${body.event_type},
            ${requestedAt?.toISOString() ?? null},
            ${body.timeout_seconds ?? null},
            ${expiresAt?.toISOString() ?? null},
            ${respondedAt?.toISOString() ?? null},
            ${body.approved ?? null},
            ${body.reason ?? null},
            ${body.responded_by ?? null},
            ${body.payload ? JSON.stringify(body.payload) : null},
            ${now.toISOString()}
          )
        `;

        console.log(
          `[External Event Route] Successfully logged event: ${eventId}`
        );

        return reply.status(200).send({
          success: true,
          event_id: eventId,
        } as ExternalEventResponse);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        console.error(
          `[External Event Route] Failed to log event:`,
          error
        );

        return reply.status(500).send({
          success: false,
          error: `Failed to log external event: ${errorMessage}`,
        } as ExternalEventResponse);
      }
    }
  );

  /**
   * GET /external-events/:executionId - Get all external events for an execution
   */
  app.get<{ Params: { executionId: string } }>(
    "/external-events/:executionId",
    async (request, reply) => {
      const { executionId } = request.params;
      const sql = getSql();

      try {
        const events = await sql`
          SELECT *
          FROM workflow_external_events
          WHERE execution_id = ${executionId}
          ORDER BY created_at ASC
        `;

        return reply.status(200).send({
          success: true,
          events,
          count: events.length,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        console.error(
          `[External Event Route] Failed to fetch events:`,
          error
        );

        return reply.status(500).send({
          success: false,
          error: `Failed to fetch external events: ${errorMessage}`,
        });
      }
    }
  );
}
