CREATE TABLE "binding_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "telegram_chat_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "binding_codes" ADD CONSTRAINT "binding_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "binding_codes_user_id_idx" ON "binding_codes" USING btree ("user_id");