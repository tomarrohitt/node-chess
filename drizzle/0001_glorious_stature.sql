CREATE INDEX "games_white_id_idx" ON "games" USING btree ("white_id");--> statement-breakpoint
CREATE INDEX "games_black_id_idx" ON "games" USING btree ("black_id");--> statement-breakpoint
CREATE INDEX "games_created_at_idx" ON "games" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "games_winner_id_idx" ON "games" USING btree ("winner_id");