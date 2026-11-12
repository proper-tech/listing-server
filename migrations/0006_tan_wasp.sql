CREATE TABLE `post_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_images_post_idx` ON `post_images` (`post_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`deal_type` text NOT NULL,
	`category` text NOT NULL,
	`district` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`price` integer NOT NULL,
	`area` real NOT NULL,
	`rooms` integer,
	`floor` integer,
	`total_floors` integer,
	`contact_phone` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `posts_browse_idx` ON `posts` (`status`,`deal_type`,`category`);--> statement-breakpoint
CREATE INDEX `posts_district_idx` ON `posts` (`district`);--> statement-breakpoint
CREATE INDEX `posts_price_idx` ON `posts` (`price`);--> statement-breakpoint
CREATE INDEX `posts_agent_idx` ON `posts` (`agent_id`);--> statement-breakpoint
CREATE INDEX `posts_created_idx` ON `posts` (`created_at`);