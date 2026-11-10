CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_key_at_idx` ON `login_attempts` (`key`,`at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `token_version` integer DEFAULT 0 NOT NULL;