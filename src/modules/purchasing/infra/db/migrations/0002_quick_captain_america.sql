CREATE TABLE "purchasing"."goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"amount" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"lot_code" text NOT NULL,
	"best_before" date NOT NULL,
	"line_no" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchasing"."goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchasing"."purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"amount" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"line_no" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchasing"."purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchasing"."purchase_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"suggested_amount" numeric(14, 3) NOT NULL,
	"suggested_unit" text NOT NULL,
	"on_hand_amount" numeric(14, 3) NOT NULL,
	"on_hand_unit" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"purchase_order_id" uuid
);
--> statement-breakpoint
CREATE TABLE "purchasing"."suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"lead_time_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchasing"."goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "purchasing"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchasing"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchasing"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "purchasing"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing"."purchase_suggestions" ADD CONSTRAINT "purchase_suggestions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "purchasing"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_line_idx" ON "purchasing"."goods_receipt_lines" USING btree ("goods_receipt_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_receipt_ingredient_idx" ON "purchasing"."goods_receipt_lines" USING btree ("goods_receipt_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_order_idx" ON "purchasing"."goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_order_line_idx" ON "purchasing"."purchase_order_lines" USING btree ("purchase_order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_order_ingredient_idx" ON "purchasing"."purchase_order_lines" USING btree ("purchase_order_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchasing"."purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_suggestions_open_ingredient_idx" ON "purchasing"."purchase_suggestions" USING btree ("ingredient_id") WHERE "purchasing"."purchase_suggestions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "purchase_suggestions_status_idx" ON "purchasing"."purchase_suggestions" USING btree ("status","created_at");