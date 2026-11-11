@backend @security
Feature: Certificate pin list
  GET /api/config/pins serves the TLS pins every shipped client holds the
  backend's chain to. The Android client hard-fails on any chain that does not
  lead to ISRG Root X1/X2 (apps/android/.../network_security_config.xml), so a
  wrong served pin bricks every Android client while the web looks healthy —
  and until #1698 no scenario read this endpoint, which is how #1608 landed
  into it unmeasured. (The commit's pins were right; the point is that only a
  hand-check could say so.)

  The expected hashes are DERIVED AT RUNTIME from the published Let's Encrypt
  root certificates committed under tests/fixtures/isrg/ — NOT from any
  constant the server source carries. Comparing the served pins against a value
  added by the same commit would be circular and would pass on a wrong pin;
  deriving them from the genuine roots (whose own SHA-256 fingerprints the steps
  pin to Let's Encrypt's published values) is what lets the scenario fail when a
  pin IS wrong.

  All four roots (X1, X2, Gen-Y YR and YE) are accepted on purpose. A pin covers
  the public key, so a set trimmed to the root in use today would still match
  today's cross-signed chain and only brick clients later. A served pin that is
  none of the four fails the first scenario — which also makes a CERT_PIN_HASHES
  override on the target fail on purpose: changing client trust anchors is a
  sign-off-gated change and must never ride along unnoticed.

  TLS terminates on the origin host with Caddy's Let's Encrypt certificate and
  there is no fallback issuer, so there is no scenario here that a CDN or proxy
  in front of the origin could satisfy.

  Scenario: Served pins are genuine ISRG root SPKI hashes
    When an anonymous caller fetches the certificate pin list
    Then the response status should be 200
    And every served pin is the SPKI hash of a published Let's Encrypt root
    And the served pins include the ISRG Root X1 and X2 SPKI hashes

  Scenario: The pin list is signed by the server key and time-bounded
    When an anonymous caller fetches the certificate pin list
    Then the response status should be 200
    And the pin list signature verifies under the server's public key
    And the pin list validity window brackets now
