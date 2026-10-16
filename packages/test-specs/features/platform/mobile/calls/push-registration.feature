@android
Feature: UnifiedPush registration (Android)
  After login the app registers with the current or default UnifiedPush
  distributor so the backend can wake it for incoming calls. Registration is
  per-device, not per-hub: one registration serves every member hub. With no
  distributor installed the app surfaces an explicit, localized state pointing
  at installing ntfy instead of failing silently.

  Background:
    Given the app is launched and authenticated as admin

  Scenario: Push registration completes after login
    Then the push registration state should be known

  Scenario: Dashboard push warning matches distributor availability
    Then the dashboard push warning visibility should match the installed distributor state
