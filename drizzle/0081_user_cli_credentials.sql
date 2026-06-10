CREATE TABLE IF NOT EXISTS "user_cli_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp,
	"last_validated_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_cli_credentials_user_provider" UNIQUE("user_id","provider")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_cli_credentials" ADD CONSTRAINT "user_cli_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_cli_credentials_user" ON "user_cli_credentials" ("user_id");
