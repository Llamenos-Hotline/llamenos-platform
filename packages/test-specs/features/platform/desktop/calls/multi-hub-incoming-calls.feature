@desktop @calls @multi-hub
Feature: Incoming calls ring on every member hub
  A user can be a member of several hubs at once. Which hub is active in the UI only
  controls what they are browsing — a call to any hub they belong to must still ring,
  and answering it must act on the call's own hub, not the active one.

  # The volunteer belongs to the worker hub (active) and a second hub. The call is
  # created on the second hub through the real simulation API and answered through the UI.

  Scenario: A call on a non-active member hub rings and can be answered
    Given a volunteer assigned to multiple hubs
    When a call comes in on the volunteer's second hub while the first hub is active
    Then the volunteer should see that call ringing
    When the volunteer answers that call
    Then the volunteer should be on an active call
    And that call should be answered on the second hub

  # A note about a call belongs to the call's hub, wherever in the UI it is written.
  # Filing it to the active hub instead would show it to the wrong hub's admins and
  # hide it from the right ones — and nothing would report an error.

  Scenario: A note written on the active call panel is filed to the call's hub
    Given a volunteer assigned to multiple hubs
    When a call comes in on the volunteer's second hub while the first hub is active
    Then the volunteer should see that call ringing
    When the volunteer answers that call
    Then the volunteer should be on an active call
    When the volunteer writes a note on the active call panel
    Then that note should be filed under the second hub and not the first

  Scenario: A note written through the note sheet is filed to the call's hub
    Given a volunteer assigned to multiple hubs
    When a call comes in on the volunteer's second hub while the first hub is active
    Then the volunteer should see that call ringing
    When the volunteer answers that call
    Then the volunteer should be on an active call
    When the volunteer writes a note about that call through the note sheet
    Then that note should be filed under the second hub and not the first

