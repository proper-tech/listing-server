ALTER TABLE `post_images` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `post_images` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `khoroo` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `lat` real;--> statement-breakpoint
ALTER TABLE `posts` ADD `lng` real;--> statement-breakpoint
ALTER TABLE `posts` ADD `year_in_use` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `floor_material` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `balconies` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `window_type` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `window_count` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `door_type` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `garage` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `leasing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `payment_terms` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `tour` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `seller_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `seller_type` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `placement` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `placement_until` integer;