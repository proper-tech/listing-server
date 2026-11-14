CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer,
	`agent_id` integer,
	`amount` integer NOT NULL,
	`items` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text DEFAULT 'qpay' NOT NULL,
	`sender_invoice_no` text NOT NULL,
	`invoice_id` text,
	`provider_payment_id` text,
	`qr_text` text,
	`qr_image` text,
	`short_url` text,
	`links` text,
	`paid_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_sender_invoice_no_unique` ON `payments` (`sender_invoice_no`);--> statement-breakpoint
CREATE INDEX `payments_post_idx` ON `payments` (`post_id`,`status`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`,`paid_at`);--> statement-breakpoint
ALTER TABLE `posts` ADD `paid_at` integer;--> statement-breakpoint
-- existing listings were created before payments: treat them as paid (nobody is charged retroactively)
UPDATE `posts` SET `paid_at` = `created_at` WHERE `paid_at` IS NULL;
