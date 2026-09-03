ALTER TABLE "deliveries" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_dedup_key_key" ON "deliveries" USING btree ("dedup_key");