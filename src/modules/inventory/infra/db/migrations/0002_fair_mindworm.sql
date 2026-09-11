CREATE TABLE "inventory"."ingredient_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"best_before" date NOT NULL,
	"received_amount" numeric(14, 3) NOT NULL,
	"remaining_amount" numeric(14, 3) NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"on_hand_amount" numeric(14, 3) DEFAULT '0' NOT NULL,
	"reorder_point_amount" numeric(14, 3) NOT NULL,
	"below_reorder_point" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."product_lots" (
	"lot_code" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"on_hand_amount" numeric(14, 3) DEFAULT '0' NOT NULL,
	"best_before" date NOT NULL,
	"produced_at" timestamp with time zone NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."stocktake_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stocktake_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"ingredient_id" uuid,
	"lot_code" text,
	"book_amount" numeric(14, 3) NOT NULL,
	"counted_amount" numeric(14, 3) NOT NULL,
	"diff_amount" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory"."stocktakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory"."ingredient_lots" ADD CONSTRAINT "ingredient_lots_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "inventory"."ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktake_id_stocktakes_id_fk" FOREIGN KEY ("stocktake_id") REFERENCES "inventory"."stocktakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingredient_lots_fefo_idx" ON "inventory"."ingredient_lots" USING btree ("ingredient_id","best_before","received_at") WHERE "inventory"."ingredient_lots"."remaining_amount" <> 0;--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_name_idx" ON "inventory"."ingredients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "product_lots_product_idx" ON "inventory"."product_lots" USING btree ("product_id","best_before");--> statement-breakpoint
CREATE INDEX "stocktake_lines_stocktake_idx" ON "inventory"."stocktake_lines" USING btree ("stocktake_id");--> statement-breakpoint
CREATE INDEX "stocktake_lines_ingredient_idx" ON "inventory"."stocktake_lines" USING btree ("ingredient_id");