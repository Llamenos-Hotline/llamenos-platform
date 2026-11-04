-- Per-hub escrow (recovery) key (operator decisions D1 and A7).
--
-- A hub's readers are the devices of the members holding a purpose's permissions
-- in that hub, plus this optional X25519 public key whose secret the hub's admins
-- hold offline. It replaces the instance-wide ADMIN_DECRYPTION_PUBKEY as the
-- escrow reader once clients seal to the hub reader set (PROTOCOL §2.4.2).
-- Nullable: a hub need not have one. No backfill: pre-production.
ALTER TABLE "hubs" ADD COLUMN "escrow_pubkey" text;
