/**
 * Send email via Resend step
 */
import type { ResendCredentials } from "../types.js";

const RESEND_API_URL = "https://api.resend.com";

type ResendEmailResponse = {
  id: string;
};

type ResendErrorResponse = {
  statusCode: number;
  message: string;
  name: string;
};

export type SendEmailInput = {
  emailFrom?: string;
  emailTo: string;
  emailSubject: string;
  emailBody: string;
  emailCc?: string;
  emailBcc?: string;
  emailReplyTo?: string;
  emailScheduledAt?: string;
  idempotencyKey?: string;
};

export type SendEmailResult =
  | { success: true; id: string }
  | { success: false; error: string };

export async function sendEmailStep(
  input: SendEmailInput,
  credentials: ResendCredentials
): Promise<SendEmailResult> {
  const apiKey = credentials.RESEND_API_KEY;
  const fromEmail = credentials.RESEND_FROM_EMAIL;

  if (!apiKey) {
    return {
      success: false,
      error:
        "RESEND_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  const senderEmail = input.emailFrom || fromEmail;

  if (!senderEmail) {
    return {
      success: false,
      error:
        "No sender is configured. Please add it in the action or in Project Integrations.",
    };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    const response = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: senderEmail,
        to: input.emailTo,
        subject: input.emailSubject,
        text: input.emailBody,
        ...(input.emailCc && { cc: input.emailCc }),
        ...(input.emailBcc && { bcc: input.emailBcc }),
        ...(input.emailReplyTo && { reply_to: input.emailReplyTo }),
        ...(input.emailScheduledAt && { scheduled_at: input.emailScheduledAt }),
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as ResendErrorResponse;
      return {
        success: false,
        error:
          errorData.message || `HTTP ${response.status}: Failed to send email`,
      };
    }

    const data = (await response.json()) as ResendEmailResponse;
    return { success: true, id: data.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to send email: ${errorMessage}`,
    };
  }
}
