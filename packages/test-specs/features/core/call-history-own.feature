@backend @calls @call-history-own
Feature: A volunteer's own call history
  A volunteer who answered a call may read it back as a system of record
  (#1342, operator decision D3). They see only the calls THEY answered, in the
  hub they answered them in, and only inside the hub's access window (default
  7 days) — the window narrows what they are served and deletes nothing: past
  it the call is still the admin's record. The response always says which part
  of the history it was drawn from, so a short list never reads as lost data.

  Scenario: A volunteer reads back the call they answered, sealed to their own device
    Given 2 volunteers are on shift
    And volunteer 0 has registered a device encryption key
    And a call from a known caller is ringing for the hub
    And volunteer 0 answers the ringing call on their phone
    And the call ends
    When volunteer 0 reads their call history
    Then the response status should be 200
    And the call history lists the call that ended
    And the call history is volunteer 0's own calls inside a 7-day window
    And volunteer 0 opens the call record's metadata with their own device key

  Scenario: A volunteer never sees a call another volunteer answered
    Given 2 volunteers are on shift
    And a call from a known caller is ringing for the hub
    And volunteer 0 answers the ringing call on their phone
    And the call ends
    When volunteer 1 reads their call history
    Then the response status should be 200
    And the call history does not list the call that ended
    And volunteer 1 cannot fetch the call that ended by id

  Scenario: Past the access window the call is withheld from the volunteer, visibly, and kept for the admin
    Given 1 volunteers are on shift
    And a call from a known caller is ringing for the hub
    And volunteer 0 answers the ringing call on their phone
    And the call ends
    And the call that ended was answered 3 days ago
    When the admin sets the hub's volunteer call-history access window to 2 days
    Then the response status should be 200
    And the hub audit log records the access window changing from 7 to 2 days
    When volunteer 0 reads their call history
    Then the call history does not list the call that ended
    And the call history is volunteer 0's own calls inside a 2-day window
    And volunteer 0 cannot fetch the call that ended by id
    And the admin's call history still lists the call that ended, and it opens for the admin

  Scenario: Widening the window serves the older call again — nothing was deleted
    Given 1 volunteers are on shift
    And a call from a known caller is ringing for the hub
    And volunteer 0 answers the ringing call on their phone
    And the call ends
    And the call that ended was answered 3 days ago
    And the admin sets the hub's volunteer call-history access window to 2 days
    When the admin sets the hub's volunteer call-history access window to 5 days
    And volunteer 0 reads their call history
    Then the call history lists the call that ended
    And the call history is volunteer 0's own calls inside a 5-day window

  Scenario: A settings PATCH that does not name the window leaves it alone
    When the admin sets the hub's volunteer call-history access window to 30 days
    And the admin sends an empty PATCH to the hub's call-history access settings
    And the admin changes the hub's queue timeout to 60 seconds
    Then the hub's volunteer call-history access window is 30 days

  Scenario: The window is bounded, and only a call-settings manager may change it
    When the admin sets the hub's volunteer call-history access window to 0 days
    Then the response status should be 400
    When a volunteer of the hub tries to set the volunteer call-history access window to 30 days
    Then the response status should be 403
