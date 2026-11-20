@desktop
Feature: New Note requires a call reference
  As a volunteer
  I want to be told why a new note cannot be saved yet
  So that a Save button that does nothing never leaves me guessing

  Scenario: A note with text but no call reference explains what is missing
    Given I am authenticated and on the note creation screen
    When I type "Note without a call reference" in the note text field
    Then the note form should say a call reference is required
    And the note form save button should be disabled

  Scenario: Giving a call reference clears the message and enables Save
    Given I am authenticated and on the note creation screen
    When I type "Note with a call reference" in the note text field
    And I enter the call reference "audit-ref-1" in the note form
    Then the note form should not complain about the call reference
    And the note form save button should be enabled
