CREATE TABLE "playground_spend_days" (
	"day" date PRIMARY KEY NOT NULL,
	"reserved_total_micro_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playground_spend_reservations" (
	"reservation_id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text,
	"reserved_micro_usd" bigint NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"terminal_status" text,
	"observed_input_tokens" integer,
	"observed_output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "playground_spend_reservations_day_idx" ON "playground_spend_reservations" USING btree ("day");--> statement-breakpoint
CREATE INDEX "playground_spend_reservations_status_idx" ON "playground_spend_reservations" USING btree ("status");