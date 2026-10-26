@backend
Feature: Per-hub IVR language menu override
  As a hub admin
  I want my hub's caller-facing IVR language menu to be independently configurable
  So that callers to my hub only hear languages relevant to my community, regardless
  of what other hubs on the same instance offer

  # Each scenario runs against its own isolated hub (the workerHub fixture), so
  # setting a hub override or a hub telephony provider here never leaks into any
  # other scenario. Nothing here writes the instance-wide (global) IVR language
  # list — it is a shared singleton read by every concurrently-running scenario.

  @backend
  Scenario: A hub-specific override takes effect for that hub's IVR menu
    When the admin sets the hub's IVR languages to "fr,de"
    Then the response status should be 200
    When the admin gets the hub's IVR languages
    Then the response status should be 200
    And the hub's IVR languages should be exactly "fr,de"

  @backend
  Scenario: A hub with no override inherits the instance-wide IVR language list
    Given the admin gets the instance-wide IVR languages
    When the admin gets the hub's IVR languages
    Then the response status should be 200
    And the hub's IVR languages should equal the instance-wide IVR languages

  # The language here is chosen so the assertion can only pass via the HUB's
  # provider. Telnyx has no Vietnamese voice; Twilio and Vonage both do. If the
  # constraint ever resolves the instance-wide provider instead of this hub's
  # (as it silently did until #1260 — `getHubTelephonyProvider` returned null
  # for every hub), "vi" becomes speakable and this scenario goes green while
  # the hub-scoped constraint is dead. A language no provider speaks — the
  # previous "ht" — cannot tell those two worlds apart, which is exactly how
  # that bug stayed hidden.
  @backend
  Scenario: A hub override naming a language the hub's own provider cannot speak is rejected
    Given the hub's telephony provider is configured as "telnyx"
    When the admin sets the hub's IVR languages to "en,vi"
    Then the response status should be 400
    # Substring must be specific: a bare "vi" also matches the word "provider".
    And the error message contains "cannot speak: vi"
    And the error message contains "telnyx"

  # The keypad has ten digits (1-9, 0). An 11th language would get no digit and
  # be dropped from the menu the caller hears, so the API refuses it instead of
  # saving a list the menu cannot honour.
  @backend
  Scenario: A hub menu longer than the keypad is refused rather than truncated
    When the admin sets the hub's IVR languages to "es,en,zh,tl,vi,ar,fr,ht,ko,ru,hi"
    Then the response status should be 400
    And the error message contains "at most 10 languages"

  @backend
  Scenario: A hub menu that fills the keypad exactly is accepted in order
    When the admin sets the hub's IVR languages to "es,en,zh,tl,vi,ar,fr,ht,ko,ru"
    Then the response status should be 200
    And the hub's IVR languages should be exactly "es,en,zh,tl,vi,ar,fr,ht,ko,ru"

  # Coverage is a staffing aid, not a roster: the response carries how many
  # enabled languages nobody in the hub speaks, and never which languages or who.
  @backend
  Scenario: The IVR language settings report an uncovered-language count and nothing more
    When the admin sets the hub's IVR languages to "fr,de"
    And the admin gets the hub's IVR languages
    Then the response status should be 200
    And the IVR language settings should be the list plus a count of at most 2

