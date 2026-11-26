-- Device public keys are bound to ONE user (#2496; spec
-- 2026-11-25-v2-device-linking-and-recovery §6, L5).
--
-- Before this, nothing stopped a member registering another user's X25519 key as
-- their own device key (`devices.x25519_pubkey`) and so matching envelopes sealed
-- to its real owner. `device_key_claims` is the UNIQUE-across-all-users
-- constraint on signing keys and on encryption keys. The app claims every key a
-- sigchain link or a device registration names, in the same transaction, and
-- refuses one another user already holds.
--
-- Keys already stored. A key held by two users is a finding about real data, not
-- something to resolve by picking a winner, so the check below refuses the whole
-- file BEFORE anything is created, naming each colliding key with the users and
-- device rows that hold it. The previous release keeps serving until an operator
-- has looked at them. The runner retries a failed file from its first statement,
-- and the check is the first statement, so a re-run after the rows are fixed
-- simply proceeds.
DO LANGUAGE plpgsql $$
DECLARE
  collisions text;
BEGIN
  WITH named AS (
    SELECT lower("pubkey") AS key, "pubkey" AS user_pubkey, 'users.pubkey' AS src FROM "users"
    UNION ALL
    SELECT lower("ed25519_pubkey"), "pubkey", 'devices.ed25519_pubkey ' || "id" FROM "devices" WHERE coalesce("ed25519_pubkey", '') <> ''
    UNION ALL
    SELECT lower("x25519_pubkey"), "pubkey", 'devices.x25519_pubkey ' || "id" FROM "devices" WHERE coalesce("x25519_pubkey", '') <> ''
    UNION ALL
    SELECT lower(k.v), l."user_pubkey", 'sigchain_links.' || k.f || ' ' || l."id"
    FROM "sigchain_links" l
    CROSS JOIN LATERAL (VALUES
      ('signerPubkey', l."signer_pubkey"),
      ('devicePubkey', l."payload"->>'devicePubkey'),
      ('deviceEncryptionPubkey', l."payload"->>'deviceEncryptionPubkey'),
      ('encryptionPubkey', l."payload"->>'encryptionPubkey')
    ) AS k(f, v)
    WHERE coalesce(k.v, '') <> ''
  )
  SELECT string_agg(key || ' held by ' || holders, '; ') INTO collisions FROM (
    SELECT key, string_agg(DISTINCT user_pubkey || ' (' || src || ')', ', ') AS holders
    FROM named GROUP BY key HAVING count(DISTINCT user_pubkey) > 1
  ) AS dup;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'device keys held by more than one user (#2496): %. Each is a device registered with a key it may not own; investigate and remove the wrong rows, then restart', collisions;
  END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "device_key_claims" (
	"key" text PRIMARY KEY NOT NULL,
	"user_pubkey" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Claim every key already stored for the user that holds it. The check above
-- proved no key has two holders, so ON CONFLICT only folds a user's own repeats.
INSERT INTO "device_key_claims" ("key", "user_pubkey", "kind")
SELECT DISTINCT ON (key) key, user_pubkey, kind FROM (
  SELECT lower("pubkey") AS key, "pubkey" AS user_pubkey, 'signing' AS kind FROM "users"
  UNION ALL
  SELECT lower("ed25519_pubkey"), "pubkey", 'signing' FROM "devices" WHERE coalesce("ed25519_pubkey", '') <> ''
  UNION ALL
  SELECT lower("x25519_pubkey"), "pubkey", 'encryption' FROM "devices" WHERE coalesce("x25519_pubkey", '') <> ''
  UNION ALL
  SELECT lower(k.v), l."user_pubkey", k.kind
  FROM "sigchain_links" l
  CROSS JOIN LATERAL (VALUES
    ('signing', l."signer_pubkey"),
    ('signing', l."payload"->>'devicePubkey'),
    ('encryption', l."payload"->>'deviceEncryptionPubkey'),
    ('encryption', l."payload"->>'encryptionPubkey')
  ) AS k(kind, v)
  WHERE coalesce(k.v, '') <> ''
) AS named
ORDER BY key
ON CONFLICT ("key") DO NOTHING;
