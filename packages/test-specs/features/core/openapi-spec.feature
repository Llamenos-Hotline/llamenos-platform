@backend
Feature: OpenAPI Specification & Documentation
  As a developer integrating with the Llamenos API
  I want accurate OpenAPI documentation
  So that I can discover and use all API endpoints

  @backend
  Scenario: OpenAPI spec is served at /api/openapi.json
    When I fetch the OpenAPI spec
    Then the OpenAPI spec should be valid
    And the spec info title should be "Llamenos API"

  @backend
  Scenario: Scalar docs UI is served at /api/docs
    When I fetch the Scalar docs page
    Then the Scalar docs page should be HTML

  @backend
  Scenario: OpenAPI spec includes all authenticated route tags
    When I fetch the OpenAPI spec
    Then the spec should include tags:
      | tag           |
      | Auth          |
      | Config        |
      | Volunteers    |
      | Shifts        |
      | Bans          |
      | Notes         |
      | Calls         |
      | Conversations |
      | Blasts        |
      | Reports       |
      | Settings      |
      | Uploads       |
      | Files         |
      | Devices       |
      | Invites       |
      | Hubs          |
      | Contacts      |
      | WebAuthn      |
      | WebRTC        |

  @backend
  Scenario: OpenAPI spec documents bearer auth security scheme
    When I fetch the OpenAPI spec
    Then the spec should define a "bearerAuth" security scheme of type "http"

  @backend
  Scenario: OpenAPI spec documents key CRUD endpoints
    When I fetch the OpenAPI spec
    Then the spec should document these paths:
      | method | path              |
      | get    | /config           |
      | post   | /auth/login       |
      | get    | /users            |
      | post   | /users            |
      | get    | /shifts           |
      | post   | /shifts           |
      | get    | /bans             |
      | post   | /bans             |
      | get    | /hubs/{hubId}/notes            |
      | post   | /hubs/{hubId}/notes            |
      | get    | /calls/active     |
      | get    | /conversations    |
      | get    | /blasts           |
      | post   | /blasts           |
