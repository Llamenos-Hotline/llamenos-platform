@ios
Feature: Tag Management (Mobile)
  Admins manage hub tags (E2EE labels encrypted with the hub key under
  LABEL_TAG_ENCRYPT, AES-256-GCM nonce||ciphertext||tag hex — the same wire
  format as the desktop encrypt_hub_field) and volunteers assign tags to
  directory contacts from the contact form. Mirrors the desktop tags-section,
  tag-input and tag-badge components.

  Background:
    Given the app is launched and authenticated as admin

  @ios @regression
  Scenario: Tags admin lists tags with decrypted labels
    Given a tag exists in the hub
    When I navigate to the Tags admin screen
    Then I should see the tag's decrypted label in the list
    And I should see the tag's color indicator

  @ios @regression
  Scenario: Admin creates a tag with label and color
    When I navigate to the Tags admin screen
    And I create a tag named "Urgent"
    Then the tag should appear in the list with its decrypted label

  @ios @regression
  Scenario: Admin deletes a tag
    Given a tag exists in the hub
    When I navigate to the Tags admin screen
    And I delete the tag
    Then the tag should no longer appear in the list

  @ios @regression
  Scenario: Tag picker in contact form shows selected tags as badges
    Given a tag exists in the hub
    When I open the create contact form
    And I select the tag in the tag picker
    Then the selected tag should appear as a badge in the form

  # "Contact form saves selected tags into the contact" is not specified here
  # yet: saving a contact needs the hub key in Swift (blind indexes), and no
  # client is ever given one (#1042). Add the scenario with that fix.

  @ios @regression
  Scenario: Tags admin is hidden without the tags view permission
    Given the app is launched and authenticated as volunteer
    When I open the main tab view
    Then the Tags admin screen should not be reachable
