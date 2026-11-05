@backend @security @hub-row-binding
Feature: Calls, records, events, evidence, shifts and ring groups exist only inside a hub (#2461)
  These routers used to be mounted unscoped as well. Their handlers fell back to
  hub id '' — which was not "no hub" but a bucket they wrote rows into — and
  their /:id guards bound nothing without a hub in the path. So a global role
  read, edited and deleted any hub's row by id, and the change was audited to
  the platform chain, where the owning hub's admins never saw it. Now a request
  with no hub cannot address a hub's row, whatever the caller's permissions.

  Background:
    Given hub "A" holds a case record, an event, a shift, a ring group and a call
    And "Gloria" holds the global hub-admin role but no hub membership

  Scenario Outline: The unscoped <path> route is gone and leaks nothing of hub "A"
    When "Gloria" sends "GET" to the unscoped "<path>"
    Then the response status should be 404
    And the response names no row of hub "A"

    Examples:
      | path                              |
      | /api/records                      |
      | /api/records/{recordId}           |
      | /api/records/{recordId}/evidence  |
      | /api/events                       |
      | /api/events/{eventId}             |
      | /api/calls/history                |
      | /api/calls/{callId}               |
      | /api/shifts                       |
      | /api/ring-groups                  |
      | /api/ring-groups/{ringGroupId}    |

  Scenario: No permission reaches a hub's row without the hub, not even a super-admin's
    When the super-admin sends "GET" to the unscoped "/api/records/{recordId}"
    Then the response status should be 404
    And the response names no row of hub "A"

  Scenario: Hub "A"'s record cannot be edited or deleted through the unscoped mount
    When "Gloria" sends "PATCH" to the unscoped "/api/records/{recordId}"
    Then the response status should be 404
    When "Gloria" sends "DELETE" to the unscoped "/api/records/{recordId}"
    Then the response status should be 404
    And the admin of hub "A" still reads the record unchanged

  Scenario: A record cannot be created in no hub
    When the super-admin creates a record at the unscoped "/api/records"
    Then the response status should be 404
    And no record was created outside hub "A"

  Scenario: A change to hub "A"'s record is audited in hub "A", not the platform chain
    When the admin of hub "A" updates the record
    Then the response status should be 200
    And hub "A"'s audit log records the update of the record
    And the platform audit chain does not record the update of the record
