CREATE TYPE "sales"."reservation_status" AS ENUM('placed', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "sales"."sale_channel" AS ENUM('storefront', 'reservation');--> statement-breakpoint
CREATE TABLE "sales"."product_sellability" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"sellable" boolean NOT NULL,
	"delisted_at" timestamp with time zone,
	"delist_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales"."reservation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_pieces" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales"."reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_name" text NOT NULL,
	"pickup_date" date NOT NULL,
	"status" "sales"."reservation_status" DEFAULT 'placed' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"sale_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sales"."sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"quantity_pieces" integer NOT NULL,
	"unit_price_jpy" integer NOT NULL,
	"subtotal_jpy" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales"."sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" "sales"."sale_channel" NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"total_jpy" integer NOT NULL,
	"reservation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales"."reservation_lines" ADD CONSTRAINT "reservation_lines_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "sales"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "sales"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."sales" ADD CONSTRAINT "sales_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "sales"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_lines_reservation_idx" ON "sales"."reservation_lines" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservations_pickup_date_idx" ON "sales"."reservations" USING btree ("pickup_date");--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sales"."sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "sales"."sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_business_date_idx" ON "sales"."sales" USING btree ("business_date");