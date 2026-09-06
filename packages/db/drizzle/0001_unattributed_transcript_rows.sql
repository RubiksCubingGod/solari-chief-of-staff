ALTER TABLE "messages" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "chat_id" text;--> statement-breakpoint
CREATE INDEX "messages_chat_id_ts_idx" ON "messages" USING btree ("chat_id","ts");