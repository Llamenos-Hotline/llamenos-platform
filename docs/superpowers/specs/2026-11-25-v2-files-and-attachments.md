# v2 files and attachments, under reader groups

**Date:** 2026-11-25 · **Base:** `origin/main` @ `d2bf23b38` · **Epic:** #2974, stage 3 (first consumers)
**Builds on:** the v2 wire format (PR #2996, signed off 2026-11-24) and the reader groups in #2961
**Status:** SIGNED OFF by the operator on 2026-11-25. F1–F8 are accepted as recommended (#2974, "Stage 3: files sign-off").

This spec moves every file the platform stores onto the v2 model. That covers evidence, entity
`file` fields, report and conversation attachments, inbound message media, and call recordings.
It replaces the per-file recipient lists, the one-shot label-only AEAD and the plaintext
side-tables with one shape: **a file is a sealed document whose content is a segmented, bound,
streamable ciphertext, readable by exactly the readers of the thing it is attached to.** It also
answers #1145 (the chunked layout, evidence metadata, real integrity checks).

The M1 fixes are separate and are not blocked by this spec: #3003 (the files no client can open),
#3004 (upload route correctness) and #3005 (deletion). This spec is what those fixes converge on.

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| F1 | Who can read a file | **Inherit from the parent.** A file has one parent tier, and its headers go to that tier's declared groups. There are no per-file recipient lists and no `/share` | 2 |
| F2 | Content format | **Segmented AEAD** (the STREAM construction): 1 MiB segments, each bound to `(format, hub, file, index, last)` | 3 |
| F3 | Length hiding | **Padmé** padding of the total plaintext length, not D6's powers of two | 3.4 |
| F4 | Upload protocol | Client-chosen `file_id`, idempotent segment PUTs, and a compare-and-set complete guarded by the v2 header check | 4 |
| F5 | Quotas | A per-hub byte quota as hub policy, plus a per-file maximum (default 100 MB) | 4.4 |
| F6 | Integrity and chain of custody | A ciphertext Merkle root the server can check, a plaintext commitment in the sealed metadata, and an uploader device signature over both | 5 |
| F7 | Storage and deletion | One bucket with hub-prefixed keys and delete-by-prefix. Deleting a file deletes its headers **and** its blobs | 6 |
| F8 | Server-sealed files | The server streams provider media and recordings through the crate's file sealer to the parent's readers, and never persists plaintext | 7 |

---

## 1. Today, measured (summary)

Surveyed against `origin/main` @ `d2bf23b38`. The full table and line references are in the issues
named here.

- **Report and conversation attachments are sealed to the uploader alone** (`src/client/routes/reports.tsx:447`). Evidence and entity fields use the record's readers. iOS uses a single admin key (`TypedReportCreateView.swift:830`). Android has no uploads. Each sealer chooses its own recipients.
- **Content is one AES-256-GCM pass over the whole file**, with AAD set to the label alone (`file-crypto.ts:108-112`). Nothing binds a ciphertext to its file, hub or owner, so blobs can be swapped. The upload is split into chunks, but only for transport: the server reassembles the whole file in memory, and every download buffers it in full.
- **Desktop seals the hex text of a file; mobile seals raw bytes** (#3003).
- **Plaintext metadata:** evidence stores `filename` and `mime_type` in the clear (#1145). File rows expose the size, the uploader and the parent.
- **Integrity checks compare a stored hash with itself** (#1145).
- **Content is never deleted.** The shred removes envelopes only. Abandoned uploads are never collected. Per-hub buckets are dead code (#3005).
- **Inbound message media is dropped and stays with the provider** (#3006). **Call recordings are sealed with the server's KEK** (#2959).
- **Update, from #3009 (the #3003 fix):**
  - Desktop couldn't open *any* stored file. `unwrapFileKey` and `decryptFileMetadata` threw "removed in v3", and the webview's open-key allow-list refused the file labels.
  - #3009 restores format-1 file reads on desktop.
  - It makes `FileFieldValue` `{fileId, uploadedAt}` (`packages/protocol/schemas/entity-schema.ts`), so the name, type and key now come from the file's own sealed metadata. **That is F1's shape already: an entity field references a file by id and holds no key material.**
  - It deduplicates the uploader's envelope when the uploader is also an admin.
  - It adds the first cross-platform file vector (`file-content-vectors.json`), run through the mobile FFI entry point. That vector is not run on device, and neither is anything else yet. On-device runs are part of this spec's gate on every client (§9).

---

## 2. F1: a file is a sealed document, and its readers come from its parent — OPERATOR DECISION

A file is a document of the system type `file` in the generic sealed store (#2961), with
`doc_id = file_id`. It has two tiers:

| Tier | Holds |
|---|---|
| `summary` | The sealed metadata: `{name, mime, plaintext_size, plaintext_sha256, segment_size, segments, uploader_device, caption?}` |
| `file` (**new tier number 7**, appended to the crate's closed tier enum; spec #2996 §2.1) | The content DEK. The content itself lives in blob storage (§3), not in a row |

**Parent.** Every file names exactly one parent, `(parent_type_ref, parent_doc_id, parent_tier)`:

- an evidence item → the case record's evidence tier;
- an entity `file` field → the tier that field is declared in;
- a report or conversation attachment, or inbound media → the conversation's **thread key**
  (`rk = 2`, spec #2996 §2.7);
- a call recording → the call record's declared recording tier.

**Readers.** The file's headers, for both tiers, are sealed to the groups that the parent tier
declares, at their current epochs, or to the parent thread key's current generation. The server's
write guard is the v2 guard (spec #2996 §2.7, "the server write guard"): for each declared group,
a header must exist at that group's current epoch. It replaces `assertAdminCanRead` for files.
The defect class where a file is sealed to the uploader alone can no longer occur.

**Re-wrap.** When the parent's readers change (a revocation, a definition change, a thread claim),
the same client job that re-wraps the parent's headers re-wraps the headers of its attached files.
Only headers are re-sealed, never content (#2961 A4).

**No sharing.** `POST /files/:id/share` and `rewrapFileKey` have no callers today. They are
**deleted**. To show a file to someone outside the parent's readers, attach a **copy** to a
document they can read. A copy is a new `file` document whose content is re-sealed with a new DEK,
so every reader is visible in the chain-governed grants.

**Alternative:** files as independent documents, each with its own declared readers. That's more
flexible, but it brings back per-file reader decisions on every client, which is the exact source
of the orphaned-attachment defects. **Not recommended.**

---

## 3. F2: the content format — OPERATOR DECISION

### 3.1 Layout

The content is a sequence of segments in blob storage, stored at
`hubs/<hub_id>/files/<file_id>/seg-<i:06>`:

```
segment_key = HKDF-SHA256(ikm = DEK, salt = utf8(L_V2_FILE_SEGMENT_KEY), info = lp(utf8(hub_id)) ‖ lp(utf8(file_id)), 32)
prefix      = random(7)                                        // per file; stored in the sealed metadata and in a clear column
nonce_i     = prefix ‖ u32be(i) ‖ u8(last)                    // 12 bytes; last = 1 only on the final segment
aad_i       = lp(utf8(L_V2_FILE_SEGMENT)) ‖ u16be(crypto_format) ‖ lp(utf8(hub_id)) ‖ lp(utf8(file_id)) ‖ u32be(i) ‖ u8(last) ‖ u32be(segments)
seg_i       = AES-256-GCM(segment_key, nonce_i, plaintext_i, aad_i)       // plaintext_i is ≤ 1 MiB; ciphertext adds 16 bytes
```

### 3.2 Properties

- **Bound.** A segment opens only as segment `i` of this file in this hub, under this format. A
  blob swapped between files fails. So does a segment that's reordered, duplicated or moved
  across hubs.
- **Truncation and extension are detected** by the `last` flag and the `segments` count, both in
  every AAD. A stream that ends without a valid `last = 1` segment is refused.
- **Streaming and range reads.** Clients seal and open one segment at a time, in constant memory.
  A viewer that only needs a range fetches only the segments that cover it. Uploads and downloads
  can resume at segment granularity.
- **One implementation.** It lives in the crate (`file_seal_stream` / `file_open_stream`). Desktop
  streams through the Rust shell rather than JS memory, and iOS and Android use UniFFI segment
  iterators. No host composes a key, a nonce or an AAD.

### 3.3 Segment size

**Recommended: 1 MiB.** That keeps mobile memory bounded and keeps per-segment overhead under
0.002%. A 100 MB file is 100 segments.

The alternative is 64 KiB, which is better for seeking in audio but means 1,600 objects for a
100 MB file. If small seeks are needed later, sub-ranges can be read inside a segment.

### 3.4 F3: length hiding — OPERATOR DECISION

D6 (powers of two, minimum 512 B) is right for small tiers but would make a 33 MB file take up
64 MB.

**Recommended: Padmé** on the total plaintext length. Padmé leaks O(log log L) bits of the length
and costs at most about 12% in overhead. The padding is appended as zero bytes inside the final
segment(s) and covered by their AEAD. The true length is only in the sealed metadata.

The alternatives are D6 (simple, but up to 2× storage) and no padding (the status quo, which
leaks the exact size).

---

## 4. F4: the upload protocol — OPERATOR DECISION

### 4.1 Steps

1. **Init:** `POST /api/hubs/:hubId/files`, with body
   `{file_id, parent, crypto_format: 2, segments, padded_size, prefix, headers[], summary_blob}`.
   - **The client chooses `file_id`** (16 random bytes, hex) so the AAD can bind it before any
     byte is sent. The server refuses a duplicate.
   - The server runs the v2 write guard over `headers` against the parent's declared groups (F1),
     checks the quota (F5), and stores the row as `pending`.
2. **Segments:** `PUT /api/hubs/:hubId/files/:fileId/segments/:i`, with the raw body (spec #2996
   D2).
   - `bodyLimit` is 1 MiB + 16, applied **before** buffering.
   - An index outside `[0, segments)` is refused.
   - **Idempotent:** the server stores the SHA-256 of each segment's ciphertext. Re-sending the
     same bytes is a no-op success; different bytes at the same index are a 409. Received indices
     are a set, never a counter (#3004).
3. **Complete:** `POST .../complete`, a compare-and-set on `status = pending` (#2491). It succeeds
   only when every index in `[0, segments)` is present. The server computes the ciphertext Merkle
   root (F6), verifies the uploader's signature over it, and sets `status = complete`. Nothing is
   reassembled.
4. **Download:** `GET .../segments/:i` returns raw bytes. The caller's access is checked against
   the parent's readers, not against envelope membership. `GET /api/hubs/:hubId/files/:fileId`
   returns the clear row plus the caller's own headers only (#3004).

### 4.2 What the server sees

`hub_id`, `file_id`, the parent reference, `crypto_format`, `segments`, `padded_size`, `prefix`,
the per-segment ciphertext hashes, the Merkle root, the uploader device and the timestamps. It
never sees the name, the type or the true size.

### 4.3 Evidence

The `evidence` row keeps only what case workflow needs: `classification` and the file reference.
`filename`, `mime_type` and `size_bytes` are **removed** and live in the file's sealed metadata
(#1145).

### 4.4 F5: quotas — OPERATOR DECISION

- **Per-hub byte quota:** a `policy` setting, enforced at init against the sum of `padded_size`
  over pending and complete files.
- **Per-file maximum:** a hub setting, default 100 MB.
- Both are refused with 413 and a clear message, never by truncating.

---

## 5. F6: integrity and chain of custody — OPERATOR DECISION

| Layer | What | Who can check it |
|---|---|---|
| Ciphertext Merkle root | The root of a binary SHA-256 Merkle tree over the segment ciphertexts, computed and stored at complete | **The server, without keys:** storage rot and tampering. A scheduled scrub re-hashes the segments |
| Plaintext commitment | `plaintext_sha256` inside the sealed metadata | Readers, after decrypting |
| Uploader signature | `Ed25519(uploader_device, utf8(L_V2_FILE_SIG) ‖ 0x00 ‖ lp(utf8(hub_id)) ‖ lp(utf8(file_id)) ‖ merkle_root ‖ H(summary plaintext))`, stored with the row | Any reader. The device must be active in the uploader's user sigchain at upload time |

**Verifying evidence**, which replaces today's comparison of a stored hash with itself (#1145):

1. download the segments;
2. recompute the Merkle root and check it equals the stored root;
3. verify the signature;
4. AEAD-open every segment;
5. compare the plaintext SHA-256 with the commitment.

The UI says "verified" only when all five pass, and names the step that failed otherwise.

---

## 6. F7: storage and deletion — OPERATOR DECISION

- **Recommended:** one bucket, and every key under `hubs/<hub_id>/`.
  - Hub erasure deletes the prefix, and the deployment verifies it by listing the bucket.
  - The dead per-hub `STORAGE_MANAGER` path is deleted (#3005).
  - Per-hub credentials would add little while one server process holds all of them.
  - Alternative: wire per-hub buckets. That's stronger isolation if hubs are ever served by
    different processes.
- **Deleting a file** deletes its headers, its row **and its segment blobs** in one job. Blobs go
  first, and the row is marked `deleting` until the listing confirms they're gone. Deleting a
  parent deletes its attached files the same way. Retention (#2186) and erasure (#2188) call this
  one path.
- **Abandoned uploads:** a scheduled job deletes `pending` files older than 24 hours, blobs
  included.

---

## 7. F8: files the server seals — OPERATOR DECISION

- **Inbound message media** (#3006): the adapter streams the provider media through
  `ffi_server`'s file sealer. It's a `file` document attached to the message, sealed to the
  conversation's thread key at its current generation. Afterwards the adapter deletes the provider
  copy, following #2386. The server sees the plaintext in transit, as it already does for inbound
  text. It never writes plaintext to disk or to the bucket.
- **Call recordings** (#2959): the recording is sealed to the call record's declared recording
  tier instead of `SERVER_KEK`. Playback is client-side and streamed by segment, and readers
  include the answering volunteer by declaration rather than by `activeCall` (#2959).
- **Server-sealed files carry no uploader signature.** The row records `uploader = server`, and
  chain-of-custody verification reports that honestly, rather than as "verified by a device".

---

## 8. Migration from format 1

Format-1 files (one-shot GCM, label-only AAD, per-file envelopes) are rows of the same
re-encryption job as spec #2996 §3.3. An admin client:

1. downloads the file;
2. opens it with the format-1 reader;
3. re-seals it as a format-2 `file` document under its parent's groups;
4. calls `migrate` with a compare-and-set on `crypto_format = 1`;
5. deletes the format-1 blob and envelopes.

The volume is small before the pilot. A file that no current admin or escrow can open is
**reported** with its id, its parent and the reason, and is never silently dropped.

---

## 9. Contract surface and gates

- **Crate:** `file_seal_stream(dek, hub, file_id, segments) → SegmentSealer`,
  `file_open_stream(dek, hub, file_id, segments, prefix) → SegmentOpener`, `merkle_root(segments)`,
  plus the signature builder and verifier.
- **Labels, appended:** `LABEL_V2_FILE_SEGMENT_KEY`, `LABEL_V2_FILE_SEGMENT`, `LABEL_V2_FILE_SIG`.
- **Tier 7:** `file`.
- **Vectors:** in `packages/crypto/tests/fixtures/v2/file.json`.
  - A three-segment file, with keys, nonces, AADs, ciphertexts, the root and the signature.
  - Negative cases, each with a named code:
    - a segment swapped between files;
    - a reordered segment;
    - a dropped final segment;
    - an extra segment after the last one;
    - `last` set early;
    - a segment moved across hubs;
    - a root or signature mismatch.
- **Gate:**
  1. A file sealed on each client opens on the other two, through each client's production reader.
  2. Every negative vector fails with its named code.
  3. Deleting a file, its parent or its hub leaves nothing under its prefix, checked by listing
     the bucket.
  4. A tampered blob makes evidence verification fail at the step that names it.
- **Sequencing:** after #2974 stage 2 (reader groups), as a stage 3 consumer alongside #2947. The
  M1 fixes (#3003, #3004, #3005) are independent of this spec and land first.

## 10. Sign-off

The operator signed off F1–F8 on #2974. The work ships as **one full-stack PR**: the crate,
`packages/protocol`, the worker, the vectors, the bindings **and all three clients**, including the
download paths iOS and Android lack today. A contract bug found while adopting is fixed in that PR.
Server-sealed files (F8) and the format-1 migration follow as their own PRs, because they have their
own dependencies.

*Revised 2026-11-25 by operator decision.* The original text said "followed by one adoption PR per
client". F1–F8 are unchanged.
