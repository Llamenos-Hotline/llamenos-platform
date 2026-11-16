@backend
Feature: A hub's role vocabulary is never stored in the clear
  As an organisation defining its own roles
  I want role names and descriptions sealed under my hub's key
  So that the server, its database and its backups cannot read what my people do

  # A role vocabulary ("Jail support coordinator", "Legal observer") describes
  # what an organisation does and who does it (#2780). These scenarios assert
  # the STORED row, not what a client shows: a round trip through the client
  # would pass even if the server kept the plaintext.

  @backend
  Scenario: A hub role's name and description are stored only as ciphertext
    When the admin creates a hub role named "Jail support coordinator" described as "Answers the jail line", sealed under the hub key
    Then the response status should be 201
    And the stored role has no plaintext name, description or name-derived slug
    And the stored role's sealed name opens to "Jail support coordinator" only with the hub key

  @backend
  Scenario: A role named in the clear is refused at both scopes
    When the admin creates a hub role with the plaintext name "Legal observer"
    Then the response status should be 400
    When the admin creates a platform role with the plaintext name "Legal observer"
    Then the response status should be 400

  @backend
  Scenario: A hub's role is neither listed nor grantable outside that hub
    Given the admin has created a sealed hub role
    And another hub the role does not belong to exists
    Then the role is not listed by the second hub or by the deployment
    When the admin grants the role to a member of the second hub
    Then the response status should be 400
    When the admin grants the role to a user as a global role
    Then the response status should be 400

  @backend
  Scenario: A hub role cannot carry instance-level authority
    When the admin creates a sealed hub role granting "system:manage-roles"
    Then the response status should be 400

  @backend
  Scenario: The server no longer creates a template's roles itself
    When the admin asks the server to create roles from a template
    Then the response status should be 404
