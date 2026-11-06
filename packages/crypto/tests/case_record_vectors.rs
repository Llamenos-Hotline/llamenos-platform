//! The crate opens the server-persisted case-record vectors (#2499).
//!
//! `tests/fixtures/case-record-vectors.json` holds a case summary, case fields
//! and a case comment exactly as the server persisted and returned them
//! (`scripts/gen-case-record-vectors.ts`). This is the Rust leg of the
//! four-platform pin: desktop (`apps/desktop/src/crypto.rs`), iOS
//! (`CaseRecordVectorTests.swift`), Android (`CaseRecordVectorTest.kt`) and the
//! server (`apps/worker/__tests__/unit/case-record-vectors.test.ts`) open the
//! same bytes through their own production readers.

use llamenos_core::case_record::{self, CasePurpose};
use llamenos_core::encryption::{open_record_for_reader, RecipientKeyEnvelope};
use llamenos_core::envelope_aad::{content_aad_hex, key_wrap_aad_hex};
use llamenos_core::labels::{
    LABEL_CASE_COMMENT, LABEL_CASE_FIELDS, LABEL_CASE_SUMMARY, LABEL_MESSAGE,
};
use serde::Deserialize;

const FIXTURE: &str = include_str!("fixtures/case-record-vectors.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    readers: Vec<Reader>,
    records: Vec<Record>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reader {
    name: String,
    x25519_secret_hex: String,
    x25519_pubkey_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    name: String,
    purpose: CasePurpose,
    label: String,
    aad_hex: Aad,
    plaintext: String,
    encrypted_content: String,
    reader_envelopes: Vec<RecipientKeyEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Aad {
    content: String,
    key_wrap: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("case-record-vectors.json does not parse")
}

#[test]
fn the_fixture_states_one_label_and_the_canonical_aad_per_purpose() {
    let f = fixture();
    let expected = [
        (CasePurpose::Summary, LABEL_CASE_SUMMARY),
        (CasePurpose::Fields, LABEL_CASE_FIELDS),
        (CasePurpose::Comment, LABEL_CASE_COMMENT),
    ];
    assert_eq!(f.records.len(), expected.len());
    for (purpose, label) in expected {
        let rec = f
            .records
            .iter()
            .find(|r| r.purpose == purpose)
            .unwrap_or_else(|| panic!("the fixture has no {purpose:?} record"));
        assert_eq!(rec.label, label, "{}", rec.name);
        assert_eq!(rec.aad_hex.content, content_aad_hex(label).unwrap());
        assert_eq!(rec.aad_hex.key_wrap, key_wrap_aad_hex(label).unwrap());
        let addresses: Vec<&str> = rec
            .reader_envelopes
            .iter()
            .map(|e| e.pubkey.as_str())
            .collect();
        let readers: Vec<&str> = f
            .readers
            .iter()
            .map(|r| r.x25519_pubkey_hex.as_str())
            .collect();
        assert_eq!(addresses, readers, "{}: envelopes address X25519 keys", rec.name);
    }
}

#[test]
fn every_reader_opens_every_persisted_case_ciphertext() {
    let f = fixture();
    for rec in &f.records {
        for reader in &f.readers {
            let opened = case_record::open(
                rec.purpose,
                &rec.encrypted_content,
                &rec.reader_envelopes,
                &reader.x25519_pubkey_hex,
                &reader.x25519_secret_hex,
            )
            .unwrap_or_else(|e| panic!("{} cannot open {}: {e}", reader.name, rec.name));
            assert_eq!(opened, rec.plaintext, "{} / {}", reader.name, rec.name);
        }
    }
}

/// The vector discriminates: the stored-message reader (`LABEL_MESSAGE`, no
/// AAD) — what desktop and Android used before #2499 — opens none of it, and no
/// ciphertext opens as another purpose.
#[test]
fn the_persisted_bytes_do_not_open_as_a_message_or_another_purpose() {
    let f = fixture();
    let reader = &f.readers[0];
    for rec in &f.records {
        assert!(
            open_record_for_reader(
                &rec.encrypted_content,
                &rec.reader_envelopes,
                &[&reader.x25519_pubkey_hex],
                &reader.x25519_secret_hex,
                LABEL_MESSAGE,
            )
            .is_err(),
            "{} opened as a stored message",
            rec.name
        );
        for other in CasePurpose::ALL.into_iter().filter(|p| *p != rec.purpose) {
            assert!(
                case_record::open(
                    other,
                    &rec.encrypted_content,
                    &rec.reader_envelopes,
                    &reader.x25519_pubkey_hex,
                    &reader.x25519_secret_hex,
                )
                .is_err(),
                "{} opened as {other:?}",
                rec.name
            );
        }
    }
}
