ALTER TABLE "workflow_executions" ADD COLUMN "execution_ir_version" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "execution_ir" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "spec_version" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "spec" jsonb;