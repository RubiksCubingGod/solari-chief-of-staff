ALTER TYPE "public"."calendar_auto_cancel_state" ADD VALUE 'handled';--> statement-breakpoint
ALTER TYPE "public"."calendar_auto_cancel_state" ADD VALUE 'declined';--> statement-breakpoint
ALTER TYPE "public"."calendar_auto_cancel_state" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "calendar_auto_cancels" ADD COLUMN "settled_at" timestamp with time zone;