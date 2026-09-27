@backend
Feature: CMS Advanced Operations (EP06-A4)
  As an admin
  I want to merge duplicate contacts and records, perform bulk operations,
  import contacts in batch, and query records across hubs
  So that I can maintain a clean and efficient case management system

  Background:
    Given case management is enabled
    And the "jail-support" template is applied

  # ---------------------------------------------------------------------------
  # Contact Merge
  # ---------------------------------------------------------------------------

  Scenario: Admin can merge two contacts
    Given two contacts exist in the directory
    When I merge the secondary contact into the primary contact with re-encrypted merged data
    Then the merge response includes the primary and secondary IDs and a mergedAt timestamp
    And the secondary contact is soft-deleted with a mergedIntoId
    And the primary contact has the merged encrypted summary

  Scenario: Merge fails when primary contact not found
    When I attempt to merge a non-existent primary contact
    Then the response status is 404

  Scenario: Merge fails when secondary contact not found
    Given a contact exists in the directory
    When I attempt to merge a non-existent secondary contact into the contact
    Then the response status is 404

  # ---------------------------------------------------------------------------
  # Entity (Record) Merge
  # ---------------------------------------------------------------------------

  Scenario: Admin can merge two records
    Given two records exist in the case management system
    When I merge the secondary record into the primary record
    Then the merge response includes primary and secondary IDs and a mergedAt timestamp
    And the secondary record is closed with a mergedIntoId
    And relinked contacts count is a non-negative integer

  Scenario: Record merge fails for non-existent record
    When I attempt to merge a non-existent record
    Then the response status is 404

  # ---------------------------------------------------------------------------
  # Bulk Contact Operations
  # ---------------------------------------------------------------------------

  # @fixme: bulk delete soft-deletes but the directory list never filters deletedAt — #1202
  @fixme
  Scenario: Admin can delete multiple contacts in bulk
    Given three contacts exist in the directory
    When I perform a bulk delete action on all three contacts
    Then the bulk action response shows 3 affected contacts
    And the deleted contacts are no longer returned in the contact list

  Scenario: Admin can add tags to multiple contacts in bulk
    Given two contacts exist in the directory
    When I perform a bulk add-tags action on both contacts with tag "urgent"
    Then the bulk action response shows 2 affected contacts

  Scenario: Bulk action fails with empty contactIds
    When I perform a bulk action with an empty contact list
    Then the response status is 400

  # ---------------------------------------------------------------------------
  # Batch Contact Import
  # ---------------------------------------------------------------------------

  Scenario: Admin can import a batch of contacts
    When I bulk-create 5 contacts with encrypted summaries
    Then the bulk create response shows 5 contacts created
    And 5 contact IDs are returned

  Scenario: Bulk import fails when batch exceeds 100
    When I attempt to bulk-create 101 contacts
    Then the response status is 400

  # ---------------------------------------------------------------------------
  # Cross-Hub Entity Queries
  # ---------------------------------------------------------------------------

  Scenario: Admin can query records across all their hubs
    Given the requesting user has records in multiple hubs
    When I list records with crossHub=true
    Then the response includes records from all hubs the user has access to

  Scenario: Cross-hub query respects cases:read-cross-hub permission
    Given the requesting user lacks cases:read-cross-hub permission
    When I list records with crossHub=true
    Then only records from the current hub are returned
