@backend @security @hub-owned-scope
Feature: Hub-owned resources are reachable only under /hubs/:hubId (#2395)
  A global role that is not super-admin grants nothing inside any hub. The
  notes, reports, contacts and audit routers used to be mounted unscoped as
  well, where such a role's permissions applied and the services dropped their
  hub filter: the role read every hub at once. These routers now refuse any
  request outside a hub, and the clients address them through the hub path.

  Background:
    Given hub "A" holds a note, a report, a contact and audit entries
    And "Gloria" holds only a global hub-admin role and belongs to no hub

  Scenario Outline: The unscoped <path> route is gone and leaks nothing of hub "A"
    When "Gloria" requests the unscoped "<path>"
    Then the response status should be 404
    And the response names nothing of hub "A"

    Examples:
      | path                            |
      | /api/notes                      |
      | /api/reports                    |
      | /api/reports/{reportId}         |
      | /api/reports/{reportId}/messages |
      | /api/contacts                   |
      | /api/contacts/{contactHash}     |
      | /api/audit                      |
      | /api/audit/verify               |

  Scenario: The admin of hub "A" still reads the note a volunteer filed there
    When the admin of hub "A" lists the hub's notes
    Then the response status should be 200
    And the volunteer's note of hub "A" is in the list

  Scenario: The platform audit chain is its own route and permission
    When the super-admin requests "/api/admin/audit"
    Then the response status should be 200
    And no audit entry in the response belongs to hub "A"
    When "Gloria" requests the unscoped "/api/admin/audit"
    Then the response status should be 403
