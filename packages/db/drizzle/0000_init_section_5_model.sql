CREATE TYPE "public"."calendar_item_kind" AS ENUM('subscription', 'deadline');--> statement-breakpoint
CREATE TYPE "public"."calendar_item_status" AS ENUM('active', 'done');--> statement-breakpoint
CREATE TYPE "public"."fetch_tier" AS ENUM('http', 'browser', 'stealth');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('telegram');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."site_connection_status" AS ENUM('connected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_event_type" AS ENUM('step', 'ask_user', 'user_reply', 'transition');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('cancel', 'book_slot', 'custom');--> statement-breakpoint
CREATE TYPE "public"."task_mode" AS ENUM('playbook', 'agentic');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'waiting_user', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tier_policy" AS ENUM('auto', 'http', 'browser', 'stealth');--> statement-breakpoint
CREATE TYPE "public"."watch_kind" AS ENUM('price', 'slot', 'change');--> statement-breakpoint
CREATE TYPE "public"."watch_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "calendar_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "calendar_item_kind" NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer,
	"renew_on" date,
	"cancel_by" date,
	"action" jsonb,
	"status" "calendar_item_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel" "message_channel" NOT NULL,
	"text" text NOT NULL,
	"task_id" uuid,
	"watch_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier_used" "fetch_tier" NOT NULL,
	"value" jsonb,
	"triggered" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "site_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"site_domain" text NOT NULL,
	"solari_profile_id" text NOT NULL,
	"status" "site_connection_status" DEFAULT 'connected' NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "task_event_type" NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "task_kind" NOT NULL,
	"input" jsonb NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"mode" "task_mode" NOT NULL,
	"playbook_id" text,
	"solari_session_id" text,
	"recording_url" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"email" text,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "watch_kind" NOT NULL,
	"url" text NOT NULL,
	"extractor" jsonb NOT NULL,
	"condition" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"tier_policy" "tier_policy" DEFAULT 'auto' NOT NULL,
	"status" "watch_status" DEFAULT 'active' NOT NULL,
	"last_value" jsonb,
	"last_checked_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_items" ADD CONSTRAINT "calendar_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_connections" ADD CONSTRAINT "site_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_items_user_id_idx" ON "calendar_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_user_id_ts_idx" ON "messages" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "observations_watch_id_checked_at_idx" ON "observations" USING btree ("watch_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_connections_user_domain_key" ON "site_connections" USING btree ("user_id","site_domain");--> statement-breakpoint
CREATE INDEX "task_events_task_id_ts_idx" ON "task_events" USING btree ("task_id","ts");--> statement-breakpoint
CREATE INDEX "tasks_user_id_created_at_idx" ON "tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "watches_user_id_idx" ON "watches" USING btree ("user_id");