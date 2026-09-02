CREATE TYPE "public"."calendar_annotation" AS ENUM('late', 'needs_attention', 'declined', 'handled');--> statement-breakpoint
CREATE TYPE "public"."calendar_auto_cancel_state" AS ENUM('enqueued', 'unlinked');--> statement-breakpoint
CREATE TYPE "public"."calendar_reminder_state" AS ENUM('pending', 'delivered', 'late', 'failed', 'skipped_unbound');--> statement-breakpoint
CREATE TABLE "calendar_auto_cancels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"renew_on" date NOT NULL,
	"state" "calendar_auto_cancel_state" NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"state" "calendar_reminder_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "reminder_lead_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "auto_cancel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "auto_cancel_lead_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "annotation" "calendar_annotation";--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "annotation_note" text;--> statement-breakpoint
ALTER TABLE "calendar_items" ADD COLUMN "annotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_auto_cancels" ADD CONSTRAINT "calendar_auto_cancels_item_id_calendar_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."calendar_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_auto_cancels" ADD CONSTRAINT "calendar_auto_cancels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_item_id_calendar_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."calendar_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_auto_cancels_item_id_renew_on_key" ON "calendar_auto_cancels" USING btree ("item_id","renew_on");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_reminders_item_id_due_on_key" ON "calendar_reminders" USING btree ("item_id","due_on");