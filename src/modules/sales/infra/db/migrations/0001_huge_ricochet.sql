CREATE TABLE "sales"."inbox" (
	"event_id" uuid NOT NULL,
	"handler" text NOT NULL,
	"event_name" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_event_id_handler_pk" PRIMARY KEY("event_id","handler")
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "sales"."outbox" USING btree ("published_at","occurred_at");