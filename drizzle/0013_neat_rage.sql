CREATE TABLE "oauth_app" (
	"id" text PRIMARY KEY NOT NULL,
	"piece_name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" jsonb NOT NULL,
	"extra_params" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_app_piece_name" ON "oauth_app" USING btree ("piece_name");