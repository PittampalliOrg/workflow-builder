ALTER TABLE "workflow_code_checkpoints"
ADD COLUMN "remote_url" text,
ADD COLUMN "remote_ref" text,
ADD COLUMN "remote_status" text,
ADD COLUMN "remote_error" text,
ADD COLUMN "remote_pushed_at" timestamp;

CREATE INDEX "idx_workflow_code_checkpoints_remote_ref"
ON "workflow_code_checkpoints" ("remote_ref");
