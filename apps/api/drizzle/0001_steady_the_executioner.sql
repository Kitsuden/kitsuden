DO $$ BEGIN CREATE TYPE "public"."block_type" AS ENUM('hero', 'text', 'image', 'video', 'grid', 'cards', 'quote', 'cta', 'embed', 'divider', 'spacer', 'custom'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."page_status" AS ENUM('draft', 'published', 'archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE "block_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"category" varchar(100) NOT NULL,
	"type" "block_type" NOT NULL,
	"content" jsonb NOT NULL,
	"css_class" varchar(200),
	"background_color" varchar(50),
	"text_color" varchar(50),
	"padding" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"type" "block_type" NOT NULL,
	"name" varchar(200),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"column_span" integer DEFAULT 12 NOT NULL,
	"content" jsonb NOT NULL,
	"css_class" varchar(200),
	"background_color" varchar(50),
	"text_color" varchar(50),
	"padding" varchar(50),
	"is_visible" boolean DEFAULT true NOT NULL,
	"visible_from" timestamp with time zone,
	"visible_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(500) NOT NULL,
	"slug" varchar(500) NOT NULL,
	"description" text,
	"status" "page_status" DEFAULT 'draft' NOT NULL,
	"meta_title" varchar(500),
	"meta_description" text,
	"og_image_id" uuid,
	"layout" varchar(50) DEFAULT 'default' NOT NULL,
	"css_class" varchar(200),
	"custom_css" text,
	"published_at" timestamp with time zone,
	"author_id" uuid,
	"is_homepage" boolean DEFAULT false NOT NULL,
	"require_auth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_category_idx" ON "block_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "templates_type_idx" ON "block_templates" USING btree ("type");--> statement-breakpoint
CREATE INDEX "templates_active_idx" ON "block_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "blocks_page_idx" ON "blocks" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "blocks_type_idx" ON "blocks" USING btree ("type");--> statement-breakpoint
CREATE INDEX "blocks_order_idx" ON "blocks" USING btree ("page_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_idx" ON "pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pages_status_idx" ON "pages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pages_homepage_idx" ON "pages" USING btree ("is_homepage");--> statement-breakpoint
CREATE INDEX "pages_published_idx" ON "pages" USING btree ("published_at");