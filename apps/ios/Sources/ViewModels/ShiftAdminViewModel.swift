import Foundation
import UIKit

// MARK: - ShiftAdminViewModel

/// View model backing the shift admin surfaces (ring groups, fallback group,
/// overrides, join/leave requests). Mirrors the desktop admin sections
/// (`admin-sections/ring-groups-section.tsx`, `shift-overrides-section.tsx` and
/// the requests/availability tabs of `src/client/routes/shifts.tsx`).
///
/// Every read/write is scoped to the active hub via `apiService.hp` — an admin
/// manages the hub they are looking at, consistent with the browsing-data rule
/// in ShiftsViewModel. Routing picks up changes server-side immediately; these
/// methods always re-read from the server after a mutation rather than trusting
/// the mutation response.
@Observable
final class ShiftAdminViewModel {
    private let apiService: APIService
    private let hubContext: HubContext

    // MARK: - Public State

    /// Ring groups of the active hub (list payload carries member counts).
    var ringGroups: [RingGroup] = []

    /// The ring group whose detail sheet is open, including its members.
    var ringGroupDetail: RingGroupDetailResponse?

    /// Overrides inside the currently selected date range.
    var overrides: [Override] = []

    /// Pending join/leave requests awaiting review.
    var requests: [Request] = []

    /// Pubkeys in the fallback ring group (who is rung when no shift matches).
    var fallbackPubkeys: [String] = []

    /// Active members of the active hub, for member pickers.
    var users: [UserListResponseUser] = []

    /// Shifts of the active hub (override scope picker, request shift names).
    var shifts: [Shift] = []

    /// Inclusive date range filtering the overrides list. Defaults to the next
    /// 60 days, matching the desktop panel's "today through end of next month".
    var overrideFrom: Date = Date()
    var overrideTo: Date = Calendar(identifier: .gregorian).date(byAdding: .day, value: 60, to: Date()) ?? Date()

    /// Whether a load is in progress (any section).
    var isLoading: Bool = false

    /// Whether a mutation is in progress (disables buttons while saving).
    var isSaving: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Success message after an action.
    var successMessage: String?

    // MARK: - Initialization

    init(apiService: APIService, hubContext: HubContext) {
        self.apiService = apiService
        self.hubContext = hubContext
    }

    // MARK: - Users (member pickers)

    /// Load active hub members for the ring group / fallback / substitute pickers.
    func loadUsers() async {
        do {
            let response: UserListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/users")
            )
            users = response.users.filter { $0.active }
        } catch {
            // A picker without the users:read permission stays empty rather than
            // masking the screen's own error with a secondary one.
            if errorMessage == nil { errorMessage = error.localizedDescription }
        }
    }

    /// Load shifts for the override scope picker and request shift-name lookup.
    func loadShifts() async {
        do {
            let response: ShiftsListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts")
            )
            shifts = response.shifts
        } catch {
            if errorMessage == nil { errorMessage = error.localizedDescription }
        }
    }

    /// Display name for a shift row referenced by id (request rows, override scope).
    func shiftName(for shiftId: String) -> String {
        guard let shift = shifts.first(where: { $0.id == shiftId }) else { return shiftId }
        return shift.encryptedName.isEmpty ? shift.timeRangeDisplay : shift.encryptedName
    }

    // MARK: - Ring Groups

    func loadRingGroups() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: RingGroupListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/ring-groups")
            )
            ringGroups = response.ringGroups
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Create a ring group. The client generates the UUID (AAD binding) exactly
    /// like desktop's `crypto.randomUUID()`.
    func createRingGroup(name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isSaving = true
        errorMessage = nil
        successMessage = nil
        do {
            let body = CreateRingGroupBody(encryptedName: trimmed, id: UUID().uuidString)
            let _: RingGroupDetailResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/ring-groups"),
                body: body
            )
            successMessage = NSLocalizedString("common_success", comment: "Success")
            await loadRingGroups()
            isSaving = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
            return false
        }
    }

    func renameRingGroup(id: String, name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isSaving = true
        errorMessage = nil
        do {
            let body = UpdateRingGroupBody(encryptedName: trimmed)
            let detail: RingGroupDetailResponse = try await apiService.request(
                method: "PUT",
                path: apiService.hp("/api/ring-groups/\(id)"),
                body: body
            )
            ringGroupDetail = detail
            successMessage = NSLocalizedString("common_success", comment: "Success")
            await loadRingGroups()
            isSaving = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
            return false
        }
    }

    /// The server restricts deletion of a group still referenced by a shift;
    /// that 409 surfaces in `errorMessage` verbatim.
    func deleteRingGroup(id: String) async {
        errorMessage = nil
        successMessage = nil
        do {
            let _: OkResponse = try await apiService.request(
                method: "DELETE",
                path: apiService.hp("/api/ring-groups/\(id)")
            )
            successMessage = NSLocalizedString("common_deleted", comment: "Deleted")
            await loadRingGroups()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadRingGroupDetail(id: String) async {
        errorMessage = nil
        do {
            let detail: RingGroupDetailResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/ring-groups/\(id)")
            )
            ringGroupDetail = detail
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func addRingGroupMembers(groupId: String, pubkeys: [String]) async {
        guard !pubkeys.isEmpty else { return }
        errorMessage = nil
        do {
            let body = RingGroupMembersBody(pubkeys: pubkeys)
            let detail: RingGroupDetailResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/ring-groups/\(groupId)/members"),
                body: body
            )
            ringGroupDetail = detail
            await loadRingGroups()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeRingGroupMember(groupId: String, pubkey: String) async {
        errorMessage = nil
        do {
            let body = RingGroupMembersBody(pubkeys: [pubkey])
            let detail: RingGroupDetailResponse = try await apiService.request(
                method: "DELETE",
                path: apiService.hp("/api/ring-groups/\(groupId)/members"),
                body: body
            )
            ringGroupDetail = detail
            await loadRingGroups()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Fallback Group

    /// Load the fallback ring group (the pubkeys rung when no schedule matches).
    func loadFallback() async {
        errorMessage = nil
        do {
            let response: FallbackGroup = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts/fallback")
            )
            fallbackPubkeys = response.userPubkeys
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The routing pipeline reads this set per incoming call (epic 370), so a
    /// write is live immediately; state is then re-read from the server.
    func setFallback(pubkeys: [String]) async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        do {
            let body = FallbackGroup(userPubkeys: pubkeys)
            let _: FallbackGroup = try await apiService.request(
                method: "PUT",
                path: apiService.hp("/api/shifts/fallback"),
                body: body
            )
            await loadFallback()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }

    // MARK: - Overrides

    func loadOverrides() async {
        isLoading = true
        errorMessage = nil
        do {
            let from = DateFormatting.wireDateString(from: overrideFrom)
            let to = DateFormatting.wireDateString(from: overrideTo)
            let response: ShiftOverrideListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts/overrides?from=\(from)&to=\(to)")
            )
            overrides = response.overrides.sorted { $0.date < $1.date }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Create an override. `shiftId == nil` means "all shifts on this date"
    /// (the desktop panel's only mode); a specific shift scopes it.
    func createOverride(
        shiftId: String?,
        date: Date,
        type: SharedCreateShiftOverrideBodyType,
        substitutePubkeys: [String]?,
        note: String?
    ) async -> Bool {
        isSaving = true
        errorMessage = nil
        successMessage = nil
        do {
            let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = CreateShiftOverrideBody(
                date: DateFormatting.wireDateString(from: date),
                encryptedNote: trimmedNote?.isEmpty == false ? trimmedNote : nil,
                id: UUID().uuidString,
                shiftID: shiftId,
                type: type,
                userPubkeys: type == .substitute ? substitutePubkeys : nil
            )
            let _: Override = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/shifts/overrides"),
                body: body
            )
            successMessage = NSLocalizedString("common_success", comment: "Success")
            await loadOverrides()
            isSaving = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
            return false
        }
    }

    func deleteOverride(id: String) async {
        errorMessage = nil
        successMessage = nil
        do {
            let _: OkResponse = try await apiService.request(
                method: "DELETE",
                path: apiService.hp("/api/shifts/overrides/\(id)")
            )
            successMessage = NSLocalizedString("common_deleted", comment: "Deleted")
            await loadOverrides()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Join/Leave Requests

    func loadRequests() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: ShiftJoinRequestListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts/requests")
            )
            requests = response.requests
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    /// Approve or deny a pending request. Approval mutates the shift roster (or
    /// ring group membership) server-side, so the shifts list is reloaded too.
    func reviewRequest(id: String, approve: Bool) async {
        errorMessage = nil
        successMessage = nil
        do {
            let body = ReviewShiftJoinRequestBody(status: approve ? .approved : .denied)
            let _: ShiftJoinRequestResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/shifts/requests/\(id)/\(approve ? "approve" : "reject")"),
                body: body
            )
            successMessage = NSLocalizedString("common_success", comment: "Success")
            await loadRequests()
            await loadShifts()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
