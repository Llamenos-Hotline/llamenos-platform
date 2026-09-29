@desktop @ios @android
Feature: Messaging Flow
  As the messaging system
  I want conversations to be routed, assigned, and managed correctly
  So that text contacts (SMS, WhatsApp, Signal) are handled reliably

  # ── Backend: Conversation Routing ─────────────────────────────────

  @backend
  Scenario: Inbound SMS creates new conversation
    Given a new phone number sends an SMS
    When the webhook is received
    Then a new conversation should be created

  @backend
  Scenario: Inbound message to existing conversation appends
    Given an existing conversation with a phone number
    When a new message arrives from the same number
    Then the message should be appended to the existing thread

  @backend
  Scenario: Conversation is assigned to available volunteer
    Given a new conversation arrives
    And volunteers are available
    Then the conversation should be assigned to a volunteer

  @backend
  Scenario: Auto-assign balances load across volunteers
    Given 3 volunteers with 2, 5, and 1 active conversations
    When a new conversation arrives
    Then it should be assigned to the volunteer with 1 conversation

  @backend
  Scenario: Channel badge reflects message source
    Given messages from SMS and WhatsApp channels
    Then each conversation should have the correct channel type

  @backend
  Scenario: Closed conversation can be reopened
    Given a conversation with status "closed"
    When a new inbound message arrives
    Then the conversation status should change to "waiting"

  # ── Desktop/Mobile: Conversation List ─────────────────────────────

  @desktop @ios @android @smoke
  Scenario: Navigate to conversations tab
    Given I am authenticated and on the main screen
    When I tap the "Conversations" tab
    Then I should see the conversations screen
    And the filter chips should be visible

  @desktop @ios @android @smoke
  Scenario: Filter chips are displayed
    Given I am authenticated and on the main screen
    When I tap the "Conversations" tab
    Then I should see the "Active" filter chip
    And I should see the "Closed" filter chip
    And I should see the "All" filter chip

  @desktop @ios @android @smoke
  Scenario: Default filter is Active
    Given I am authenticated and on the main screen
    When I tap the "Conversations" tab
    Then the "Active" filter should be selected

  # ── Desktop/Mobile: Conversation Filters ──────────────────────────

  @desktop @ios @android @regression
  Scenario: Switch to Closed filter
    Given I am authenticated and on the conversations screen
    When I tap the "Closed" filter chip
    Then the "Closed" filter should be selected
    And the conversation list should update

  @desktop @ios @android @regression
  Scenario: Switch to All filter
    Given I am authenticated and on the conversations screen
    When I tap the "All" filter chip
    Then the "All" filter should be selected

  @desktop @ios @android @regression
  Scenario: Switch back to Active filter
    Given I am authenticated and on the conversations screen
    And I have selected the "Closed" filter
    When I tap the "Active" filter chip
    Then the "Active" filter should be selected

  @desktop @ios @android @regression
  Scenario: Conversations show empty or list state
    Given I am authenticated and on the conversations screen
    Then I should see either the conversations list, empty state, or loading indicator

  # ── Desktop/Mobile: Conversation Assignment ───────────────────────

  @desktop @ios @android @regression
  Scenario: Assign button is visible on conversation detail
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    Then I should see the assign conversation button

  @desktop @ios @android @regression
  Scenario: Assign dialog opens with volunteer list
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    When I tap the assign conversation button
    Then I should see the assign dialog

  # ── Desktop/Mobile: Conversation E2EE ─────────────────────────────

  @desktop @ios @android @regression
  Scenario: E2EE indicator is visible on conversation detail
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    Then I should see the E2EE encryption indicator

  @desktop @ios @android @regression
  Scenario: E2EE indicator shows lock icon and text
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    Then I should see the E2EE encryption indicator
    And the indicator should display "End-to-end encrypted"

  # ── Desktop/Mobile: Conversation Notes ────────────────────────────

  @desktop @ios @android @regression
  Scenario: Add Note button is visible on conversation detail
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    Then I should see the add note button

  @desktop @ios @android @regression
  Scenario: Tapping Add Note navigates to note creation
    Given I am authenticated and on the main screen
    And I navigate to the conversations tab
    And I open a conversation
    When I tap the add note button
    Then I should see the note creation screen

  # ── Desktop: Full Conversation Flow ───────────────────────────────

  @desktop @ios @android
  Scenario: View conversation thread
    Given I am logged in as an admin
    And a conversation exists
    When I navigate to the "Conversations" page
    And I click on a conversation
    Then I should see the conversation thread
    And I should see message timestamps

  @desktop @ios @android
  Scenario: Send a message in conversation
    Given I am logged in as an admin
    And I have an open conversation
    When I type a message in the reply field
    And I click "Send"
    Then the message should appear in the thread

  @desktop @ios @android
  Scenario: Conversation shows channel badge
    Given I am logged in as an admin
    And conversations from different channels exist
    When I navigate to the "Conversations" page
    Then each conversation should show its channel badge

  @desktop @ios @android
  Scenario: Assign conversation to volunteer
    Given I am logged in as an admin
    And a conversation exists
    When I assign the conversation to a volunteer
    Then the conversation should show the assigned volunteer

  @desktop @ios @android
  Scenario: Close a conversation
    Given I am logged in as an admin
    And an open conversation exists
    When I close the conversation
    Then the conversation status should change to "Closed"

  @desktop @ios @android
  Scenario: Reopen a closed conversation
    Given I am logged in as an admin
    And a closed conversation exists
    When I reopen the conversation
    Then the conversation status should change to "Open"

  @desktop @ios @android
  Scenario: Conversation search
    Given I am logged in as an admin
    And conversations exist
    When I search for a phone number
    Then matching conversations should be displayed

  @desktop @ios @android
  Scenario: Messaging admin settings section displays
    Given I am logged in as an admin
    And I am on the admin settings page
    Then I should see the messaging configuration section

  @desktop @ios @android
  Scenario: Configure SMS channel settings
    Given I am logged in as an admin
    And I am on the messaging settings
    When I configure SMS channel with Twilio credentials
    Then the SMS channel should be enabled

  @desktop @ios @android
  Scenario: Configure WhatsApp channel settings
    Given I am logged in as an admin
    And I am on the messaging settings
    When I configure WhatsApp channel
    Then the WhatsApp channel should be enabled

  @desktop @ios @android
  Scenario: Send outbound message in conversation
    Given I am logged in as an admin
    And I have an active conversation
    When I type a message and click send
    Then the message should appear in the thread

  @desktop @ios @android
  Scenario: Message delivery status updates
    Given I am logged in as an admin
    And I sent a message in a conversation
    Then I should see the delivery status indicator

  @desktop @ios @android
  Scenario: Close and reopen a conversation
    Given I am logged in as an admin
    And I have an active conversation
    When I close the conversation
    Then the conversation status should be "closed"
    When I reopen the conversation
    Then the conversation status should be "active"

  @desktop @ios @android
  Scenario: Conversation assignment to volunteer
    Given I am logged in as an admin
    And I have an unassigned conversation
    When I assign it to a volunteer
    Then the volunteer name should appear on the conversation

  @desktop @ios @android
  Scenario: Auto-assign balances load across volunteers via UI
    Given I am logged in as an admin
    And multiple volunteers are available
    When a new conversation arrives
    Then it should be assigned to the volunteer with lowest load

  @desktop @ios @android
  Scenario: Filter conversations by channel type
    Given I am logged in as an admin
    And conversations exist across SMS and WhatsApp
    When I filter by SMS channel
    Then I should only see SMS conversations

  # ── Backend: Outbound Message Encryption ─────────────────────────

  @backend @security
  Scenario: Outbound message stores encrypted content, not plaintext
    Given a conversation exists for an SMS contact
    And the admin has registered a device encryption key
    When a volunteer sends an outbound message with plaintext "Help is on the way"
    Then the stored message encryptedContent should not contain "Help is on the way"
    And the stored message should have reader envelopes with HPKE fields
    And the stored message should have an envelope for the admin decryption pubkey
