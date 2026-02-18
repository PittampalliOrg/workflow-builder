CREATE TABLE "workspace_change_artifact_files" (
  "id" text NOT NULL,
  "change_set_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "path" text NOT NULL,
  "old_path" text NULL,
  "status" text NOT NULL,
  "is_binary" boolean NOT NULL DEFAULT false,
  "language" text NULL,
  "old_storage_ref" text NULL,
  "new_storage_ref" text NULL,
  "old_compressed" boolean NOT NULL DEFAULT false,
  "new_compressed" boolean NOT NULL DEFAULT false,
  "old_bytes" integer NOT NULL DEFAULT 0,
  "new_bytes" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE INDEX "idx_workspace_change_artifact_files_change_set" ON "workspace_change_artifact_files" ("change_set_id");
CREATE INDEX "idx_workspace_change_artifact_files_path_sequence" ON "workspace_change_artifact_files" ("path", "sequence");
CREATE INDEX "idx_workspace_change_artifact_files_change_set_path_sequence" ON "workspace_change_artifact_files" ("change_set_id", "path", "sequence");
