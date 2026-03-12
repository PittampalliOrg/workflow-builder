ALTER TABLE "workflow_executions" ADD COLUMN "error_stack_trace" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "rerun_of_execution_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "rerun_source_instance_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "rerun_from_event_id" integer;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_rerun_of_execution_id_workflow_executions_id_fk" FOREIGN KEY ("rerun_of_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE set null ON UPDATE no action;