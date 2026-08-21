CREATE TABLE `secrets` (
	`auth_tag` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`nonce` text NOT NULL,
	`secret_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer NOT NULL
);
