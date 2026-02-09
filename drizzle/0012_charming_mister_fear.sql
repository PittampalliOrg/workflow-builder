ALTER TABLE "app_connection" DROP CONSTRAINT "app_connection_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app_connection" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;