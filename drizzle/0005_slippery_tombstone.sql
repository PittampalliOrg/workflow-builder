ALTER TABLE "workflow_execution_logs" ADD COLUMN "activity_name" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "dapr_instance_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "progress" integer;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "engine_type" text DEFAULT 'dapr';--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "dapr_workflow_name" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "dapr_orchestrator_url" text;