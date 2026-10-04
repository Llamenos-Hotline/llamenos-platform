@desktop @ios @android
Feature: Note Encryption & Management
  As a volunteer
  I want to create, view, edit, and search encrypted notes
  So that call documentation is secure and accessible

  # ── Backend: Note Encryption ──────────────────────────────────────

  @backend
  Scenario: Note envelope has per-note random key
    Given a new note is created
    Then the envelope should contain a unique random symmetric key

  @backend
  Scenario: Note key is HPKE-wrapped for volunteer
    Given a note created by a volunteer
    Then the envelope should contain the key wrapped for the volunteer's pubkey

  @backend
  Scenario: Note key is HPKE-wrapped for each admin
    Given a hub with 3 admins
    When a note is created
    Then the envelope should contain 3 admin key wraps

  @backend
  Scenario: Note content is encrypted with AES-256-GCM
    Given an encrypted note envelope
    Then the ciphertext should be decryptable with the correct symmetric key

  @backend
  Scenario: Forward secrecy through unique keys
    Given two notes created by the same volunteer
    Then each note should have a different symmetric key

  @backend
  Scenario: Envelope format matches protocol specification
    Given an encrypted note envelope
    Then it should contain version, nonce, ciphertext, and reader keys fields

  # ── Desktop/Mobile: Note List ─────────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Navigate to notes tab
    Given I am authenticated and on the main screen
    When I tap the "Notes" tab
    Then I should see the notes screen
    And the create note FAB should be visible

  @desktop @ios @android @smoke
  Scenario: Notes tab shows empty state or list
    Given I am authenticated and on the main screen
    When I tap the "Notes" tab
    Then I should see either the notes list, empty state, or loading indicator

  @desktop @ios @android @smoke
  Scenario: Create note FAB navigates to create screen
    Given I am authenticated and on the main screen
    When I tap the "Notes" tab
    And I tap the create note FAB
    Then I should see the note creation screen
    And the note text input should be visible
    And the save button should be visible
    And the back button should be visible

  # ── Desktop/Mobile: Note Creation ─────────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Note text input accepts text
    Given I am authenticated and on the note creation screen
    When I type "Test note content" in the note text field
    Then the text "Test note content" should be displayed

  @desktop @ios @android @smoke
  Scenario: Back navigation returns to notes list
    Given I am authenticated and on the note creation screen
    When I tap the back button
    Then I should return to the notes list
    And the create note FAB should be visible

  @desktop @ios @android @regression
  Scenario: Note creation with custom fields
    Given I am authenticated and on the note creation screen
    And custom fields are configured for notes
    When I type "Call note with fields" in the note text field
    Then I should see custom field inputs below the text field

  # ── Desktop/Mobile: Note Detail ───────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Note detail displays decrypted content
    Given I am authenticated
    And at least one note exists
    When I navigate to a note's detail view
    Then I should see the full note text
    And I should see the creation date
    And I should see the author pubkey

  # @fixme: desktop has no separate note detail view — #1313
  @ios @android @regression @fixme
  Scenario: Note detail back navigation
    Given I am authenticated
    And at least one note exists
    When I am on a note detail view
    And I tap the back button
    Then I should return to the notes list

  # @fixme: desktop has no separate note detail view — #1313
  @ios @android @regression @fixme
  Scenario: Note detail shows copy button
    Given I am authenticated
    And at least one note exists
    When I am on a note detail view
    Then a copy button should be visible in the top bar

  # ── Desktop/Mobile: Note Editing ──────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Edit button is visible on note detail
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    And I open a note
    Then I should see the note edit button

  @desktop @ios @android @regression
  Scenario: Tapping edit enters edit mode
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    And I open a note
    When I tap the note edit button
    Then I should see the note edit input

  @desktop @ios @android @regression
  Scenario: Canceling edit returns to read mode
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    And I open a note
    When I tap the note edit button
    And I cancel editing
    Then I should see the note detail text

  # ── Desktop/Mobile: Note Threads ──────────────────────────────────

  @desktop @ios @android
  Scenario: Thread section visible on note detail
    Given the app is launched
    And I tap the "Notes" tab
    And I am on the note detail screen
    Then I should see the thread replies section
    And I should see the reply input field

  @desktop @ios @android
  Scenario: Empty thread shows placeholder
    Given the app is launched
    And I tap the "Notes" tab
    And I am on the note detail screen
    And the note has no replies
    Then I should see the no replies message

  @desktop @ios @android
  Scenario: Reply count displayed in thread header
    Given the app is launched
    And I tap the "Notes" tab
    And I am on the note detail screen
    Then I should see the reply count in the thread header

  @desktop @ios @android
  Scenario: Reply input and send button present
    Given the app is launched
    And I tap the "Notes" tab
    And I am on the note detail screen
    Then I should see the reply input field
    And I should see the send reply button

  @desktop @ios @android
  Scenario: Reply count badge shown on note card
    Given the app is launched
    And I tap the "Notes" tab
    And I am on the notes list
    Then notes with replies should show a reply count badge

  # ── Desktop/Mobile: Notes Search ──────────────────────────────────

  @desktop @ios @android @regression
  Scenario: Search bar is visible on notes tab
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    Then I should see the notes search input

  @desktop @ios @android @regression
  Scenario: Search filters notes by content
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    When I type in the notes search input
    Then the notes list should update

  @desktop @ios @android @regression
  Scenario: Clearing search shows all notes
    Given I am authenticated and on the main screen
    And I navigate to the notes tab
    When I type in the notes search input
    And I clear the notes search
    Then I should see the full notes list

  # ── Desktop: Custom Fields in Notes ───────────────────────────────

  @desktop @ios @android
  Scenario: Custom fields appear in new note form
    Given I am logged in as an admin
    And a text custom field "Priority Level" exists
    When I navigate to the "Notes" page
    And I click "New Note"
    Then I should see a "Priority Level" input in the form

  @desktop @ios @android
  Scenario: Create note with custom field value shows badge
    Given I am logged in as an admin
    And a text custom field "Priority Level" exists
    When I create a note with "Priority Level" set to "High"
    Then I should see "Priority Level: High" as a badge

  @desktop @ios @android
  Scenario: Edit form shows custom fields pre-filled
    Given I am logged in as an admin
    And a text custom field "Priority Level" exists
    And a note exists with "Priority Level" set to "High"
    When I click edit on the note
    Then the "Priority Level" input should have value "High"

  @desktop @ios @android
  Scenario: Can update custom field value via edit
    Given I am logged in as an admin
    And a text custom field "Priority Level" exists
    And a note exists with "Priority Level" set to "High"
    When I click edit on the note
    And I change "Priority Level" to "Critical"
    And I click "Save"
    Then I should see "Priority Level: Critical"
    And I should not see "Priority Level: High"

  @desktop @ios @android
  Scenario: Edit preserves note text when changing field value
    Given I am logged in as an admin
    And a text custom field "Priority Level" exists
    And a note exists with text "Note text to preserve" and "Priority Level" set to "Medium"
    When I click edit on the note
    And I change "Priority Level" to "Low"
    And I click "Save"
    Then I should see "Note text to preserve"
    And I should see "Priority Level: Low"

  @desktop @ios @android
  Scenario: Note card shows call ID in header
    Given I am logged in as an admin
    When I create a note with a specific call ID
    Then the note card header should show a truncated call ID

  @desktop @ios @android
  Scenario: Notes grouped under same call share one header
    Given I am logged in as an admin
    When I create two notes with the same call ID
    Then both notes should appear under a single call header

  @desktop @ios @android
  Scenario: Edit saves updated text correctly
    Given I am logged in as an admin
    And a note exists
    When I click edit on the note
    And I change the note text to "Updated content"
    And I click "Save"
    Then I should see "Updated content"
    And I should not see the original text
