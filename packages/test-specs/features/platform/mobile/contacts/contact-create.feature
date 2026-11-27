@ios
Feature: Contact Create (Mobile)
  An admin saves a directory contact from the contact form. The summary
  (display name, tags) and the PII (phone, email, notes) are sealed on the
  device to the hub's admin readers before they leave it; the server stores
  ciphertext and one envelope per reader, and nothing derived from the
  contact's data. Saving a contact needs no hub key: the hub key lives in
  Rust and never enters Swift, and the crate exports no blind index yet (#2779).

  Background:
    Given the app is launched and authenticated as admin

  @ios @regression
  Scenario: Admin creates a contact that is stored sealed for the hub admin reader
    When I open the create contact form
    And I fill in a display name, a phone number and an email address
    And I save the contact
    Then the form should close
    And the server should hold one new contact whose summary and PII are sealed
    And the stored contact should carry an envelope for the hub's admin reader
    And the stored contact should carry nothing derived from its data
