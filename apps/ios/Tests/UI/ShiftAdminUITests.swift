import CryptoKit
import XCTest

/// XCUITest suite for the iOS shift admin surfaces (#752): ring groups, the
/// fallback ring group, shift overrides, join/leave request review, and
/// availability blocks.
///
/// Every mutation test drives the UI and then asserts the SERVER state via
/// TestAdminAPI re-reads — a volunteer added to the fallback group must be in
/// it when re-read, an approved join request must have changed the shift
/// roster. Element-existence assertions alone would pass against a client that
/// only pretended to save.
final class ShiftAdminUITests: BaseUITest {

    // MARK: - Server State Helpers

    /// The pubkey the app registered for this launch ("iOS UI Test Admin" or
    /// "iOS UI Test Volunteer" — registerTestIdentity in AppState).
    private func appUserPubkey(named name: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        guard let data = TestAdminAPI.send("GET", "/api/hubs/\(testHubId)/users", baseURL: testHubURL, file: file, line: line),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let users = json["users"] as? [[String: Any]] else {
            XCTFail("Could not read hub members", file: file, line: line)
            return ""
        }
        guard let match = users.first(where: { $0["name"] as? String == name }),
              let pubkey = match["pubkey"] as? String else {
            XCTFail("App user '\(name)' not found in hub members", file: file, line: line)
            return ""
        }
        return pubkey
    }

    /// Poll a server-state predicate until it holds or the deadline passes.
    /// UI mutations complete asynchronously, so a single immediate read races
    /// the write; polling bounds the wait without a fixed sleep.
    private func waitForServerState(
        timeout: TimeInterval = 15,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ predicate: () -> Bool
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(predicate(), "Server state did not reach the expected value within \(timeout)s", file: file, line: line)
    }

    private func jsonObject(_ data: Data?, _ key: String, file: StaticString = #filePath, line: UInt = #line) -> [[String: Any]] {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let array = json[key] as? [[String: Any]] else {
            XCTFail("Malformed response reading '\(key)'", file: file, line: line)
            return []
        }
        return array
    }

    private func tapElement(withIdentifierPrefix prefix: String, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        let element = scrollToMatch(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
        guard element.waitForExistence(timeout: timeout) else {
            XCTFail("Element with identifier prefix '\(prefix)' should exist", file: file, line: line)
            return
        }
        element.tap()
    }

    // MARK: - Permission Gating

    /// A volunteer holds none of the shift admin permissions, so the Manage
    /// entry point must not render — the admin surfaces are unreachable.
    func testVolunteerCannotReachShiftAdminSurfaces() {
        given("I am authenticated as a volunteer") {
            launchAsVolunteerWithAPI()
        }
        when("I navigate to the Shifts tab") {
            navigateToShifts()
        }
        then("the shift admin entry point is absent") {
            XCTAssertFalse(
                find("shifts-admin-link").waitForExistence(timeout: 5),
                "Volunteer must not see the shift admin (Manage) entry point"
            )
        }
        and("my volunteer self-service availability section is present") {
            XCTAssertTrue(
                find("availability-section").waitForExistence(timeout: 10),
                "Volunteers keep the availability self-service section (shifts:set-availability)"
            )
        }
    }

    /// An admin sees the Manage entry and, inside it, all four shift admin
    /// surfaces: ring groups, fallback group, overrides, requests.
    func testAdminSeesAllShiftAdminSurfaces() {
        given("I am authenticated as an admin") {
            launchAsAdminWithAPI()
        }
        when("I open shift management from the Shifts tab") {
            navigateToShifts()
            let manageLink = find("shifts-admin-link")
            XCTAssertTrue(manageLink.waitForExistence(timeout: 10), "Admin should see the Manage button")
            manageLink.tap()
        }
        then("all four shift admin surfaces are listed") {
            for identifier in [
                "shift-admin-ring-groups-link",
                "shift-admin-fallback-link",
                "shift-admin-overrides-link",
                "shift-admin-requests-link",
            ] {
                XCTAssertTrue(
                    find(identifier).waitForExistence(timeout: 10),
                    "\(identifier) should be listed in shift admin"
                )
            }
        }
    }

    // MARK: - Ring Groups

    /// Create a ring group through the UI, then prove it exists by re-reading
    /// the ring group list from the server.
    func testCreateRingGroupPersistedOnServer() {
        let groupName = "Night Owls \(Int(Date().timeIntervalSince1970))"

        given("I am an admin on the ring groups screen") {
            launchAsAdminWithAPI()
            navigateToShifts()
            find("shifts-admin-link").tap()
            find("shift-admin-ring-groups-link").tap()
        }
        when("I create a ring group") {
            XCTAssertTrue(find("ring-group-create-button").waitForExistence(timeout: 10))
            find("ring-group-create-button").tap()
            let nameInput = find("ring-group-name-input")
            XCTAssertTrue(nameInput.waitForExistence(timeout: 5))
            nameInput.tap()
            nameInput.typeText(groupName)
            find("ring-group-save-button").tap()
        }
        then("the group is listed by the server") {
            waitForServerState {
                let groups = self.jsonObject(
                    TestAdminAPI.send("GET", "/api/hubs/\(self.testHubId)/ring-groups", baseURL: self.testHubURL),
                    "ringGroups"
                )
                return groups.contains { $0["encryptedName"] as? String == groupName }
            }
        }
    }

    /// Add a member to a ring group through the UI; the member must be in the
    /// group's membership when re-read from the server (this is the set routing
    /// resolves for shifts that use the group).
    func testRingGroupMemberAddPersistedOnServer() {
        var groupId = ""
        var appPubkey = ""

        given("a ring group exists and I am an admin") {
            guard let data = TestAdminAPI.send(
                "POST", "/api/hubs/\(testHubId)/ring-groups",
                ["id": UUID().uuidString, "encryptedName": "On-call"],
                baseURL: testHubURL
            ), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let id = json["id"] as? String else {
                XCTFail("Could not create ring group via API")
                return
            }
            groupId = id
            launchAsAdminWithAPI()
            appPubkey = appUserPubkey(named: "iOS UI Test Admin")
        }
        when("I add myself to the group through the UI") {
            navigateToShifts()
            find("shifts-admin-link").tap()
            find("shift-admin-ring-groups-link").tap()
            let row = find("ring-group-row-\(groupId)")
            XCTAssertTrue(row.waitForExistence(timeout: 10), "Ring group row should be listed")
            row.tap()
            tapElement(withIdentifierPrefix: "ring-group-add-member-\(appPubkey)")
        }
        then("the server lists me as a member of the group") {
            waitForServerState {
                guard let data = TestAdminAPI.send(
                    "GET", "/api/hubs/\(self.testHubId)/ring-groups/\(groupId)",
                    baseURL: self.testHubURL
                ), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let members = json["members"] as? [[String: Any]] else {
                    return false
                }
                return members.contains { $0["pubkey"] as? String == appPubkey }
            }
        }
    }

    // MARK: - Fallback Group (routing effect)

    /// The fallback group is what catches calls when no schedule matches, so
    /// the assertion is about the server's routing state, not the UI: after
    /// toggling a volunteer in, a fresh GET of /shifts/fallback must contain
    /// their pubkey (epic 370 — changes take effect on routing immediately).
    func testFallbackGroupAssignmentPersistsOnServer() {
        var appPubkey = ""

        given("I am an admin with an empty fallback group") {
            launchAsAdminWithAPI()
            appPubkey = appUserPubkey(named: "iOS UI Test Admin")
        }
        when("I add myself to the fallback group through the UI") {
            navigateToShifts()
            find("shifts-admin-link").tap()
            find("shift-admin-fallback-link").tap()
            let row = scrollToFind("fallback-user-row-\(appPubkey)", maxSwipes: 8, timeout: 5)
            XCTAssertTrue(row.exists, "Own user row should exist in the fallback picker")
            row.tap()
        }
        then("a fresh server read of the fallback group contains me") {
            waitForServerState {
                guard let data = TestAdminAPI.send(
                    "GET", "/api/hubs/\(self.testHubId)/shifts/fallback",
                    baseURL: self.testHubURL
                ), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let pubkeys = json["userPubkeys"] as? [String] else {
                    return false
                }
                return pubkeys.contains(appPubkey)
            }
        }
    }

    // MARK: - Shift Overrides

    /// Create a cancel override for today through the UI, then verify the
    /// server lists it in today's range.
    func testCreateOverridePersistedOnServer() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())

        given("I am an admin on the overrides screen") {
            launchAsAdminWithAPI()
            navigateToShifts()
            find("shifts-admin-link").tap()
            find("shift-admin-overrides-link").tap()
        }
        when("I create a cancel override for today") {
            XCTAssertTrue(find("override-create-button").waitForExistence(timeout: 10))
            find("override-create-button").tap()
            // Defaults: today's date, "cancel" type, all shifts.
            let saveButton = find("override-save-button")
            XCTAssertTrue(saveButton.waitForExistence(timeout: 5))
            saveButton.tap()
        }
        then("the server lists a cancel override for today") {
            waitForServerState {
                let overrides = self.jsonObject(
                    TestAdminAPI.send(
                        "GET",
                        "/api/hubs/\(self.testHubId)/shifts/overrides?from=\(today)&to=\(today)",
                        baseURL: self.testHubURL
                    ),
                    "overrides"
                )
                return overrides.contains {
                    $0["date"] as? String == today && $0["type"] as? String == "cancel"
                }
            }
        }
    }

    // MARK: - Join/Leave Requests (routing effect)

    /// The full request loop on one device: the app's user requests to join a
    /// shift from the volunteer-facing schedule, the admin side approves it,
    /// and the shift roster read back from the server must now contain that
    /// user — approval is what changes who gets rung.
    func testApproveJoinRequestAddsVolunteerToShiftRoster() {
        var shiftId = ""
        var appPubkey = ""

        given("a shift exists and I am an admin") {
            guard let data = TestAdminAPI.send(
                "POST", "/api/hubs/\(testHubId)/shifts",
                [
                    "id": UUID().uuidString,
                    "encryptedName": "Coverage Gap",
                    "startTime": "00:00",
                    "endTime": "23:59",
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "userPubkeys": [],
                ],
                baseURL: testHubURL
            ), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let id = json["id"] as? String else {
                XCTFail("Could not create shift via API")
                return
            }
            shiftId = id
            launchAsAdminWithAPI()
            appPubkey = appUserPubkey(named: "iOS UI Test Admin")
        }
        when("I request to join the shift and approve the request as admin") {
            navigateToShifts()
            let signUp = scrollToFind("signup-shift-\(shiftId)", maxSwipes: 8, timeout: 10)
            XCTAssertTrue(signUp.exists, "Sign Up button should exist for the shift")
            signUp.tap()

            // The same admin now reviews the request they just submitted.
            find("shifts-admin-link").tap()
            find("shift-admin-requests-link").tap()
            tapElement(withIdentifierPrefix: "request-approve-")
        }
        then("the shift roster on the server now contains me") {
            waitForServerState {
                let shifts = self.jsonObject(
                    TestAdminAPI.send("GET", "/api/hubs/\(self.testHubId)/shifts", baseURL: self.testHubURL),
                    "shifts"
                )
                guard let shift = shifts.first(where: { $0["id"] as? String == shiftId }),
                      let roster = shift["userPubkeys"] as? [String] else {
                    return false
                }
                return roster.contains(appPubkey)
            }
        }
    }

    // MARK: - Availability Blocks

    /// Create an availability block through the volunteer self-service section,
    /// then verify the server's availability list contains a block for this
    /// user (routing excludes blocked volunteers).
    func testCreateAvailabilityBlockPersistedOnServer() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())
        var appPubkey = ""

        given("I am an admin on the Shifts tab") {
            launchAsAdminWithAPI()
            appPubkey = appUserPubkey(named: "iOS UI Test Admin")
            navigateToShifts()
        }
        when("I mark myself unavailable for today") {
            let addButton = scrollToFind("availability-add-button", maxSwipes: 8, timeout: 10)
            XCTAssertTrue(addButton.exists, "Add Availability Block button should exist")
            addButton.tap()
            // Defaults: today through today, no reason.
            let saveButton = find("availability-save-button")
            XCTAssertTrue(saveButton.waitForExistence(timeout: 5))
            saveButton.tap()
        }
        then("the server's availability list contains a block for me covering today") {
            waitForServerState {
                let blocks = self.jsonObject(
                    TestAdminAPI.send(
                        "GET",
                        "/api/hubs/\(self.testHubId)/shifts/availability?from=\(today)&to=\(today)",
                        baseURL: self.testHubURL
                    ),
                    "blocks"
                )
                return blocks.contains { block in
                    guard let start = block["startDate"] as? String,
                          let end = block["endDate"] as? String else { return false }
                    return block["userPubkey"] as? String == appPubkey && start <= today && end >= today
                }
            }
        }
    }
}
