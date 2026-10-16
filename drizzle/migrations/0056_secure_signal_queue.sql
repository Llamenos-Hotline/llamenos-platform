-- The retry queue has no enqueue callers yet, so any existing rows are
-- unprocessed legacy plaintext. Discard them rather than carrying plaintext
-- into columns whose contract is ciphertext/hash-only.
TRUNCATE TABLE signal_message_queue;
--> statement-breakpoint
DROP INDEX IF EXISTS signal_queue_recipient_status_idx;
--> statement-breakpoint
ALTER TABLE signal_message_queue
  DROP COLUMN recipient_identifier,
  DROP COLUMN body,
  ADD COLUMN recipient_identifier_hash text NOT NULL,
  ADD COLUMN recipient_identifier_ciphertext text NOT NULL,
  ADD COLUMN encrypted_body text NOT NULL;
--> statement-breakpoint
CREATE INDEX signal_queue_recipient_status_idx
  ON signal_message_queue USING btree (recipient_identifier_hash, status, updated_at);