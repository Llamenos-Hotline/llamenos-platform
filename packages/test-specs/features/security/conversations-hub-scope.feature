@backend @security
Feature: Conversations are served only inside a hub, bounded by the caller's permissions there
  A conversation belongs to one hub. The list, the counts and every single
  conversation are read through /api/hubs/:hubId/conversations, where the
  caller's authority is what their roles grant in that hub.

  Regression coverage for #2381: the conversations router was also mounted
  unscoped at /api/conversations, where no hub filter applied and permissions
  resolved from global roles — so a user whose roles were all hub-level held
  none, and the waiting-queue channel filter, applied only when the claimable
  set was non-empty, did not apply at all. Any authenticated user was served
  every hub's waiting conversations.

  Background:
    Given conversation hubs "A" and "B" exist
    And hub "A" has a waiting "sms" conversation
    And hub "B" has a waiting "sms" conversation
    And "Nadia" is a member of hub "B" with no conversation permission
    And "Vic" is a volunteer of hub "A" only

  Scenario: A member of another hub with no permission gets nothing from the unscoped routes
    When "Nadia" requests "/conversations"
    Then the response carries no conversation of hub "A" or hub "B"
    When "Nadia" requests "/conversations/stats"
    Then the response carries no conversation counts
    When "Nadia" requests hub "A"'s conversation by its unscoped id
    Then the response carries no conversation of hub "A" or hub "B"

  Scenario: A volunteer of one hub gets nothing from the unscoped list either
    When "Vic" requests "/conversations"
    Then the response carries no conversation of hub "A" or hub "B"

  Scenario: No claimable channel means no waiting queue, not an unfiltered one
    When "Nadia" lists the conversations of hub "B"
    Then the response status should be 200
    And the listed conversations are exactly none

  Scenario: A volunteer lists their own hub's waiting conversations and only those
    When "Vic" lists the conversations of hub "A"
    Then the response status should be 200
    And the listed conversations are exactly hub "A"'s waiting "sms" conversation

  Scenario: A volunteer opens their own hub's waiting conversation through the hub path
    When "Vic" fetches hub "A"'s waiting conversation through hub "A"
    Then the response status should be 200
    When "Vic" fetches hub "B"'s waiting conversation through hub "A"
    Then the response status should be 404

  Scenario: Hub conversation counts cover that hub alone
    When the admin reads the conversation counts of hub "B"
    Then the response status should be 200
    And the counts are 1 waiting of 1 in total
