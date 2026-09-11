CREATE TABLE "catalog"."product_prices" (
	"product_id" uuid NOT NULL,
	"price_jpy" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	CONSTRAINT "product_prices_product_id_effective_from_pk" PRIMARY KEY("product_id","effective_from"),
	CONSTRAINT "product_prices_positive" CHECK ("catalog"."product_prices"."price_jpy" > 0)
);
--> statement-breakpoint
CREATE TABLE "catalog"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"allergens" text[] NOT NULL,
	"sellable" boolean DEFAULT true NOT NULL,
	"delisted_at" timestamp with time zone,
	"delist_reason" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_name_not_blank" CHECK (length(btrim("catalog"."products"."name")) > 0),
	CONSTRAINT "products_allergens_known" CHECK ("catalog"."products"."allergens" <@ ARRAY['wheat', 'egg', 'milk', 'soba', 'peanut', 'shrimp', 'crab', 'walnut']::text[]),
	CONSTRAINT "products_delist_consistent" CHECK (("catalog"."products"."sellable" AND "catalog"."products"."delisted_at" IS NULL AND "catalog"."products"."delist_reason" IS NULL)
          OR (NOT "catalog"."products"."sellable" AND "catalog"."products"."delisted_at" IS NOT NULL AND "catalog"."products"."delist_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "catalog"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_sellable_idx" ON "catalog"."products" USING btree ("sellable");