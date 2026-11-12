CREATE TABLE `inquiries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text,
	`message` text NOT NULL,
	`read_at` integer,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inquiries_post_idx` ON `inquiries` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inquiries_ip_idx` ON `inquiries` (`ip`,`created_at`);