CREATE TABLE "production"."delisted_products" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"delisted_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production"."production_plan_items" (
	"production_plan_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"planned_amount" numeric(12, 3) NOT NULL,
	"planned_unit" text NOT NULL,
	"basis" text NOT NULL,
	CONSTRAINT "production_plan_items_production_plan_id_product_id_pk" PRIMARY KEY("production_plan_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "production"."production_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production"."production_run_consumptions" (
	"production_run_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"consumed_amount" numeric(12, 3) NOT NULL,
	"consumed_unit" text NOT NULL,
	CONSTRAINT "production_run_consumptions_production_run_id_ingredient_id_pk" PRIMARY KEY("production_run_id","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "production"."production_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_plan_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"planned_amount" numeric(12, 3) NOT NULL,
	"produced_amount" numeric(12, 3) NOT NULL,
	"quantity_unit" text NOT NULL,
	"lot_code" text NOT NULL,
	"best_before" date NOT NULL,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production"."recipe_lines" (
	"recipe_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"line_amount" numeric(12, 3) NOT NULL,
	"line_unit" text NOT NULL,
	CONSTRAINT "recipe_lines_recipe_id_ingredient_id_pk" PRIMARY KEY("recipe_id","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "production"."recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"yield_amount" numeric(12, 3) NOT NULL,
	"yield_unit" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production"."sales_results" (
	"business_date" date NOT NULL,
	"product_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"sold_amount" numeric(12, 3) NOT NULL,
	"quantity_unit" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_results_business_date_product_id_channel_pk" PRIMARY KEY("business_date","product_id","channel")
);
--> statement-breakpoint
ALTER TABLE "production"."production_plan_items" ADD CONSTRAINT "production_plan_items_production_plan_id_production_plans_id_fk" FOREIGN KEY ("production_plan_id") REFERENCES "production"."production_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_plan_items" ADD CONSTRAINT "production_plan_items_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "production"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_run_consumptions" ADD CONSTRAINT "production_run_consumptions_production_run_id_production_runs_id_fk" FOREIGN KEY ("production_run_id") REFERENCES "production"."production_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_runs" ADD CONSTRAINT "production_runs_production_plan_id_production_plans_id_fk" FOREIGN KEY ("production_plan_id") REFERENCES "production"."production_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_runs" ADD CONSTRAINT "production_runs_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "production"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "production"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_plans_business_date_uq" ON "production"."production_plans" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "production_runs_product_idx" ON "production"."production_runs" USING btree ("product_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_product_version_uq" ON "production"."recipes" USING btree ("product_id","version");--> statement-breakpoint
CREATE INDEX "recipes_product_idx" ON "production"."recipes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_results_product_idx" ON "production"."sales_results" USING btree ("product_id","business_date");