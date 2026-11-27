# Hub numbers: how an inbound call finds its hub

An inbound call names the number it was dialled to (`calledNumber`). The server
resolves that number to a hub and refuses the call when no active hub answers on
it (#2460). This page is the contract for that lookup.

## One store: `hub_numbers`

Every number a hotline answers on is a row in `hub_numbers`:

| Column | Meaning |
|--------|---------|
| `hub_id` | The hub that answers on the number. Rows go with the hub. |
| `number` | E.164 (`+15551234567`), unique across the deployment: one dialled number routes to at most one hub. |
| `source` | `declared`: an operator told us (a self-hosted PBX, where the carrier delivers DIDs and no API lists them). `provisioned`: bought through a hosted provider's number API. |
| `scope` | Who vouched for the number: `platform` (instance authority, `system:manage-hubs`) or `hub` (the hub's own provider administrator). See "Who may route a number". |
| `provider_config_id` | The provider config a `provisioned` number was bought through. Set to null if that config is removed; the hub keeps answering on the number. |

`HubService.getHubByPhone` reads this table and nothing else. Nothing in
`provider_configs` or `hubs` is consulted. (`hubs.phone_number`,
`hub_settings.phone_number` and `provider_configs.phone_numbers` are no longer
declared by the schema; the columns are dropped one release later, per
`docs/runbooks/migrations.md`.)

Writers, all into the same table:

- **Operator declares numbers** (self-hosted PBX, or any provider): `PUT /api/provider-setup/numbers`
  `{ hubId, numbers: [...] }` replaces the hub's declared set; `POST /api/provider-setup/configure`
  accepts `phoneNumbers` (the whole declared set) or `phoneNumber` (the hotline number, replacing the primary).
  The hub create/edit forms' `phoneNumber` / `phoneNumbers` fields write the same rows.
- **Hosted provider provisioning**: `POST /api/provider-setup/phone-numbers/provision` records the bought number as `provisioned`.
- Read them with `GET /api/provider-setup/numbers?hubId=` (primary first) or `Hub.phoneNumbers`.

A number another hub already answers on is refused with `409`. Replacing the declared
set never removes a `provisioned` number: editing a DID list does not release a number someone paid for.

A hosted provider's `listNumbers` is a read of the provider account. It no longer writes anything
to the hub: every number on an account is not that hub's hotline.

## Who may route a number

A call reaches the server through a provider account: the hub's own (its webhook URL names
`?hub=<id>`) or the platform's (no `?hub=`). A number a hub administrator declares must not let
that hub capture calls the platform account carries for someone else, so the lookup is scoped:

| Declared by | `scope` | Routes a call delivered by |
|-------------|---------|----------------------------|
| instance authority: hub create/edit (`PATCH /hubs/:id`), setup, or a caller holding `system:manage-hubs` | `platform` | any account |
| a hub's provider administrator (`telephony:manage-providers` inside the hub), or a number the hub bought | `hub` | that hub's own account only |

Instance authority outranks a hub's declaration: it takes a number over from another hub's
`hub`-scope claim (so a hub cannot squat an instance's DID), and a `hub`-scope writer cannot remove or
replace a number instance authority set. A `provisioned` number is never taken.

## One boundary: E.164

Carriers disagree on what they put in the dialled number. A SIP trunk's Request-URI
user part (what Asterisk calls the dialplan extension) may be `+15551234567`,
`15551234567`, `0015551234567`, or a national `(555) 123-4567`. The lookup is an
exact match, so the number is normalised once, in `getHubByPhone`, with
`lib/phone-number.ts` (`libphonenumber-js`). The same function normalises every
declared number on the way in, so the two sides always meet in E.164.

| Input | Reads as |
|-------|----------|
| leading `+` | E.164 as given (separators dropped) |
| leading `00` | the international call prefix, `+` follows |
| anything else | a national number in `DEFAULT_PHONE_COUNTRY`, or one that already starts with its country code |

`DEFAULT_PHONE_COUNTRY` is an ISO 3166-1 alpha-2 code (`US`, `GB`, …). Unset, only numbers that
carry their own country code (`+`, `00`) can be read; a national-format declaration is refused with a
`400` that says so, rather than stored as something that would never match. A number is accepted
when it is *possible*, not only when it is *valid* in the public numbering plan: private PBXs
legitimately use reserved ranges.

`extensions.conf`'s `[from-trunk]` accepts both `_X.` and `_+X.`; nothing in the dialplan needs to
change for this.

## Why the number is plaintext

The routing lookup runs on a webhook, with no hub key and no user, so the number cannot be sealed
under the hub key without losing the lookup. The number identifies the hotline, but it is also on
the carrier's records and on the hotline's own public materials; sealing it would not hide it from
the party that matters (the carrier). Recorded here as a decision, not an oversight: if the threat
model moves, the alternative is a keyed hash of the number for the lookup and a hub-sealed copy for
display, which `hub_numbers` can grow into without changing any caller.
