CREATE TABLE `mock_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`role` text DEFAULT 'agent' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mock_agents_email_unique` ON `mock_agents` (`email`);--> statement-breakpoint
CREATE TABLE `mock_listing_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`r2_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `mock_listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mock_listing_images_listing_idx` ON `mock_listing_images` (`listing_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `mock_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`deal_type` text NOT NULL,
	`category` text NOT NULL,
	`district` text NOT NULL,
	`price` integer NOT NULL,
	`area` real NOT NULL,
	`rooms` integer,
	`floor` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `mock_agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mock_listings_browse_idx` ON `mock_listings` (`status`,`deal_type`,`category`);--> statement-breakpoint
CREATE INDEX `mock_listings_district_idx` ON `mock_listings` (`district`);--> statement-breakpoint
CREATE INDEX `mock_listings_price_idx` ON `mock_listings` (`price`);--> statement-breakpoint
CREATE INDEX `mock_listings_agent_idx` ON `mock_listings` (`agent_id`);