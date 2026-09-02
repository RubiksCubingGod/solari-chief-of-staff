CREATE TYPE "public"."watch_health" AS ENUM('healthy', 'needs_extractor', 'blocked', 'degraded');--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "health" "watch_health" DEFAULT 'healthy' NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "tier_floor" "fetch_tier" DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "last_error" text;