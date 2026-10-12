@backend
Feature: Permission Matrix
  Verify that each API endpoint enforces its required permissions correctly.
  5 default roles are tested: super-admin, hub-admin, reviewer, volunteer, reporter.
  Each Scenario Outline row asserts the expected HTTP status for each role.

  Background:
    And test users exist for all default roles

  # ─── Volunteers Domain ─────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to list volunteers
    When the "<role>" user sends "GET" to "/api/users"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to create volunteer
    When the "<role>" user sends "POST" to "/api/users" with valid volunteer body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update volunteer
    Given a test volunteer exists
    When the "<role>" user sends "PATCH" to the test volunteer endpoint with update body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to delete volunteer
    Given a deletable test volunteer exists
    When the "<role>" user sends "DELETE" to the deletable volunteer endpoint
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Shifts Domain ────────────────────────────────────────────────

  # Seeing the schedule is not seeing the roster. A volunteer needs to know
  # that shifts exist and when they run — otherwise the shift screen 403s and
  # they cannot find a shift to ask to join (#1342) — but personal
  # information is admin-only in this product, so `shifts:read-own` returns
  # the same schedule with every roster narrowed to the caller. Only
  # `shifts:read` sees who else is on each shift. The scenario below is the
  # assertion that replaces the blanket 403 these rows used to carry: the
  # status may now be 200, and the roster must still be empty of other
  # people. `reporter` holds neither permission and is still refused outright.
  Scenario Outline: <role> <expected> access to list shifts
    When the "<role>" user sends "GET" to "/api/shifts"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | has       | 200    |
      | volunteer    | has       | 200    |
      | reporter     | denied    | 403    |

  Scenario: volunteer sees the schedule without learning who else is on it
    Given a test shift rosters the volunteer alongside another user
    When the "volunteer" user lists the hub schedule
    Then the response status should be 200
    And the schedule shows that shift with only the volunteer on its roster

  Scenario Outline: <role> <expected> access to create shift
    When the "<role>" user sends "POST" to "/api/shifts" with valid shift body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update shift
    Given a test shift exists
    When the "<role>" user sends "PATCH" to the test shift endpoint with shift update body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to delete shift
    Given a deletable test shift exists
    When the "<role>" user sends "DELETE" to the deletable shift endpoint
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to get fallback group
    When the "<role>" user sends "GET" to "/api/shifts/fallback"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to set fallback group
    When the "<role>" user sends "PUT" to "/api/shifts/fallback" with fallback body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Bans Domain ──────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to create a ban
    # MED-W2: bans:create (admin-only) replaces bans:report — volunteers can no longer ban numbers directly
    When the "<role>" user sends "POST" to "/api/bans" with valid ban body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to list bans
    When the "<role>" user sends "GET" to "/api/bans"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to bulk create bans
    When the "<role>" user sends "POST" to "/api/bans/bulk" with valid bulk ban body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to delete ban
    Given a test ban exists
    When the "<role>" user sends "DELETE" to the test ban endpoint
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Notes Domain ─────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to list own notes
    When the "<role>" user sends "GET" to "/api/notes"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | has       | 200    |
      | volunteer    | has       | 200    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to create note
    When the "<role>" user sends "POST" to "/api/notes" with valid note body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | has       | 201    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to reply to note
    Given a test note exists
    When the "<role>" user sends "POST" to the test note reply endpoint with reply body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | has       | 201    |
      | volunteer    | has       | 201    |
      | reporter     | denied    | 403    |

  # ─── Calls Domain ─────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to active calls
    When the "<role>" user sends "GET" to "/api/calls/active"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | has       | 200    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to today call count
    When the "<role>" user sends "GET" to "/api/calls/today-count"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | has       | 200    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to call history
    When the "<role>" user sends "GET" to "/api/calls/history"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to volunteer presence
    When the "<role>" user sends "GET" to "/api/calls/presence"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Audit Domain ─────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to audit log
    When the "<role>" user sends "GET" to "/api/audit"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Metrics Domain ───────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to metrics
    When the "<role>" user sends "GET" to "/api/metrics"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Invites Domain ───────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to list invites
    When the "<role>" user sends "GET" to "/api/invites"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to create invite
    When the "<role>" user sends "POST" to "/api/invites" with valid invite body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to revoke invite
    Given a test invite exists
    When the "<role>" user sends "DELETE" to the test invite endpoint
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Spam ────────────────────────────────────────

  Scenario Outline: <role> <expected> access to get spam settings
    When the "<role>" user sends "GET" to "/api/settings/spam"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update spam settings
    When the "<role>" user sends "PATCH" to "/api/settings/spam" with spam settings body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Telephony ───────────────────────────────────

  Scenario Outline: <role> <expected> access to get telephony provider
    When the "<role>" user sends "GET" to "/api/settings/telephony-provider"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update telephony provider (deprecated)
    When the "<role>" user sends "PATCH" to "/api/settings/telephony-provider" with telephony body
    Then the response status should be <status>

    Examples:
      | role         | expected    | status |
      | super-admin  | deprecated  | 400    |
      | hub-admin    | deprecated  | 400    |
      | reviewer     | denied      | 403    |
      | volunteer    | denied      | 403    |
      | reporter     | denied      | 403    |

  # ─── Settings Domain: Messaging ───────────────────────────────────

  Scenario Outline: <role> <expected> access to get messaging config
    When the "<role>" user sends "GET" to "/api/settings/messaging"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update messaging config
    When the "<role>" user sends "PATCH" to "/api/settings/messaging" with messaging body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: IVR ─────────────────────────────────────────

  Scenario Outline: <role> <expected> access to get IVR languages
    When the "<role>" user sends "GET" to "/api/settings/ivr-languages"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update IVR languages
    When the "<role>" user sends "PATCH" to "/api/settings/ivr-languages" with IVR body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Transcription ───────────────────────────────

  Scenario Outline: <role> <expected> access to update transcription settings
    When the "<role>" user sends "PATCH" to "/api/settings/transcription" with transcription body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Custom Fields ───────────────────────────────

  Scenario Outline: <role> <expected> access to update custom fields
    When the "<role>" user sends "PUT" to "/api/settings/custom-fields" with custom fields body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Call Settings ───────────────────────────────

  Scenario Outline: <role> <expected> access to get call settings
    When the "<role>" user sends "GET" to "/api/settings/call"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update call settings
    When the "<role>" user sends "PATCH" to "/api/settings/call" with call settings body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: WebAuthn ────────────────────────────────────

  Scenario Outline: <role> <expected> access to get WebAuthn settings
    When the "<role>" user sends "GET" to "/api/settings/webauthn"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update WebAuthn settings
    When the "<role>" user sends "PATCH" to "/api/settings/webauthn" with webauthn body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: TTL ─────────────────────────────────────────

  Scenario Outline: <role> <expected> access to get TTL settings
    When the "<role>" user sends "GET" to "/api/settings/ttl"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to update TTL settings
    When the "<role>" user sends "PATCH" to "/api/settings/ttl" with TTL body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Setup ───────────────────────────────────────

  Scenario Outline: <role> <expected> access to get setup state
    When the "<role>" user sends "GET" to "/api/setup/state"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Report Types ────────────────────────────────

  Scenario Outline: <role> <expected> access to create report type
    When the "<role>" user sends "POST" to "/api/settings/report-types" with report type body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Settings Domain: Roles (system:manage-roles) ─────────────────

  Scenario Outline: <role> <expected> access to get permissions catalog
    When the "<role>" user sends "GET" to "/api/settings/permissions"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | denied    | 403    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  Scenario Outline: <role> <expected> access to create custom role
    When the "<role>" user sends "POST" to "/api/settings/roles" with valid role body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | denied    | 403    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Files Domain ─────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to share file
    When the "<role>" user sends "POST" to "/api/files/test-file-id/share" with share body
    Then the response status should not be 403

    Examples:
      | role         | expected  |
      | super-admin  | has       |
      | hub-admin    | has       |

  Scenario Outline: <role> denied access to share file
    When the "<role>" user sends "POST" to "/api/files/test-file-id/share" with share body
    Then the response status should be 403

    Examples:
      | role         |
      | reviewer     |
      | volunteer    |
      | reporter     |

  # ─── Contacts Domain ──────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to contacts
    When the "<role>" user sends "GET" to "/api/contacts"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | has       | 200    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── System Domain ────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to system health
    When the "<role>" user sends "GET" to "/api/system/health"
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 200    |
      | hub-admin    | denied    | 403    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Hubs Domain ──────────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to create hub
    When the "<role>" user sends "POST" to "/api/hubs" with valid hub body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | denied    | 403    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | denied    | 403    |

  # ─── Reports Domain ───────────────────────────────────────────────

  Scenario Outline: <role> <expected> access to create report
    When the "<role>" user sends "POST" to "/api/reports" with valid report body
    Then the response status should be <status>

    Examples:
      | role         | expected  | status |
      | super-admin  | has       | 201    |
      | hub-admin    | has       | 201    |
      | reviewer     | denied    | 403    |
      | volunteer    | denied    | 403    |
      | reporter     | has       | 201    |

  # ─── Unauthenticated Access ───────────────────────────────────────

  Scenario Outline: Unauthenticated <method> to <path> is rejected
    When an unauthenticated request is sent to "<method>" "<path>"
    Then the response status should be 401

    Examples:
      | method | path                               |
      | GET    | /api/users                    |
      | GET    | /api/shifts                        |
      | GET    | /api/bans                          |
      | GET    | /api/notes                         |
      | GET    | /api/calls/active                  |
      | GET    | /api/audit                         |
      | GET    | /api/settings/spam                 |
      | GET    | /api/invites                       |
      | GET    | /api/contacts                      |
      | GET    | /api/metrics                       |
      | GET    | /api/hubs                          |
      | GET    | /api/reports                       |
      | GET    | /api/conversations                 |
      | GET    | /api/system/health                 |
      | POST   | /api/users                    |
      | POST   | /api/bans                          |
      | POST   | /api/notes                         |
      | POST   | /api/shifts                        |
      | POST   | /api/invites                       |
      | POST   | /api/hubs                          |
      | POST   | /api/reports                       |
      | PATCH  | /api/settings/spam                 |
      | PATCH  | /api/settings/telephony-provider   |
      | DELETE | /api/users/fakepubkey          |
