import Foundation
import Testing
@testable import Llamenos

final class MockRolesAPIService: RolesAPIServiceProtocol {
    var listRolesResult: Result<RoleListResponse, Error> = .success(RoleListResponse(roles: []))
    var catalogResult: Result<PermissionsCatalogResponse, Error> = .success(
        PermissionsCatalogResponse(byDomain: [:], permissions: [:])
    )
    var effectivePermissionsResult: Result<EffectivePermissionsWire, Error> = .success(
        EffectivePermissionsWire(userId: "", permissions: [])
    )

    var listedHubIds: [String?] = []

    func listRoles(hubId: String?) async throws -> RoleListResponse {
        listedHubIds.append(hubId)
        switch listRolesResult {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }

    func getPermissionsCatalog() async throws -> PermissionsCatalogResponse {
        switch catalogResult {
        case .success(let catalog): return catalog
        case .failure(let error): throw error
        }
    }

    func getEffectivePermissions(userId: String, hubId: String?) async throws -> EffectivePermissionsWire {
        switch effectivePermissionsResult {
        case .success(let wire): return wire
        case .failure(let error): throw error
        }
    }
}

@MainActor
struct RolesViewModelTests {

    private func makeSystemRole(
        id: String = "role-1",
        slug: String = "admin",
        name: String = "Admin",
        permissions: [String] = ["*"],
        isSystem: Bool = true,
        isDefault: Bool = false,
        assignedUserCount: Double? = nil
    ) -> RoleResponse {
        RoleResponse(
            assignedUserCount: assignedUserCount,
            createdAt: "2026-01-01T00:00:00Z",
            description: "System administrator role",
            encryptedDescription: nil,
            encryptedName: nil,
            envelopes: nil,
            hubID: nil,
            id: id,
            isDefault: isDefault,
            isSystem: isSystem,
            name: name,
            permissions: permissions,
            slug: slug,
            updatedAt: "2026-01-01T00:00:00Z"
        )
    }

    @Test func loadRolesPopulatesSortedList() async {
        let mock = MockRolesAPIService()
        mock.listRolesResult = .success(RoleListResponse(roles: [
            makeSystemRole(id: "r1", slug: "viewer", name: "Viewer", isSystem: false),
            makeSystemRole(id: "r2", slug: "volunteer", name: "Volunteer", isSystem: false, isDefault: true),
            makeSystemRole(id: "r3", slug: "admin", name: "Admin"),
            makeSystemRole(id: "r4", slug: "auditor", name: "Auditor", isSystem: false),
        ]))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.roles.count == 4)
        #expect(vm.isLoading == false)
        // System roles first, then the default role, then alphabetical by name
        #expect(vm.roles.map(\.slug) == ["admin", "volunteer", "auditor", "viewer"])
    }

    @Test func systemRoleUsesPlaintextName() async {
        let mock = MockRolesAPIService()
        mock.listRolesResult = .success(RoleListResponse(roles: [
            makeSystemRole(name: "System Admin"),
        ]))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.roles[0].name == "System Admin")
    }

    @Test func customRoleFallsBackToSlugWhenNoEnvelope() async {
        let mock = MockRolesAPIService()
        let role = RoleResponse(
            assignedUserCount: nil,
            createdAt: "2026-01-01T00:00:00Z",
            description: "",
            encryptedDescription: "enc",
            encryptedName: "enc",
            envelopes: nil,
            hubID: nil,
            id: "r1",
            isDefault: false,
            isSystem: false,
            name: nil,
            permissions: ["notes:read"],
            slug: "custom-role",
            updatedAt: "2026-01-01T00:00:00Z"
        )
        mock.listRolesResult = .success(RoleListResponse(roles: [role]))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.roles[0].name == "custom-role")
    }

    @Test func activeHubScopesTheListing() async {
        let mock = MockRolesAPIService()
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { "hub-1" })
        await vm.loadRoles(includeCatalog: false)
        #expect(mock.listedHubIds == ["hub-1"])
    }

    @Test func noActiveHubListsDeploymentWideRolesOnly() async {
        let mock = MockRolesAPIService()
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(mock.listedHubIds == [nil])
    }

    /// A hub role this device cannot open (no hub key here) must show its id —
    /// never the sealed ciphertext and never an empty name.
    @Test func hubRoleThatCannotBeOpenedShowsItsIdNotCiphertext() async {
        let sealed = String(repeating: "ab", count: 40)
        let mock = MockRolesAPIService()
        mock.listRolesResult = .success(RoleListResponse(roles: [
            RoleResponse(
                assignedUserCount: nil,
                createdAt: "2026-01-01T00:00:00Z",
                description: "",
                encryptedDescription: sealed,
                encryptedName: sealed,
                envelopes: nil,
                hubID: "hub-1",
                id: "role-0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
                isDefault: false,
                isSystem: false,
                name: nil,
                permissions: ["notes:read"],
                slug: "role-0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
                updatedAt: "2026-01-01T00:00:00Z"
            ),
        ]))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { "hub-1" })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.roles[0].name == "role-0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f")
        #expect(vm.roles[0].name != sealed)
        #expect(vm.roles[0].roleDescription.isEmpty)
    }

    @Test func permissionsByDomainGroupsCorrectly() {
        let role = DecryptedRole(
            id: "r1", slug: "test", name: "Test",
            roleDescription: "",
            permissions: ["calls:answer", "calls:read", "notes:create", "*"],
            isSystem: false, isDefault: false, assignedUserCount: nil
        )
        let groups = role.permissionsByDomain
        #expect(groups.count == 3)
        let domains = groups.map(\.domain)
        #expect(domains.contains("calls"))
        #expect(domains.contains("notes"))
        #expect(domains.contains("system"))
        let callsGroup = groups.first { $0.domain == "calls" }
        #expect(callsGroup?.keys == ["calls:answer", "calls:read"])
    }

    @Test func loadRolesSetsErrorOnFailure() async {
        let mock = MockRolesAPIService()
        mock.listRolesResult = .failure(URLError(.notConnectedToInternet))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.errorMessage != nil)
        #expect(vm.roles.isEmpty)
    }

    @Test func assignedUserCountMappedFromDouble() async {
        let mock = MockRolesAPIService()
        mock.listRolesResult = .success(RoleListResponse(roles: [
            makeSystemRole(assignedUserCount: 5.0),
        ]))
        let vm = RolesViewModel(rolesAPI: mock, cryptoService: CryptoService(), hubIdProvider: { nil })
        await vm.loadRoles(includeCatalog: false)
        #expect(vm.roles[0].assignedUserCount == 5)
    }
}

@MainActor
struct EffectivePermissionsViewModelTests {

    @Test func loadPopulatesSortedPermissions() async {
        let mock = MockRolesAPIService()
        mock.effectivePermissionsResult = .success(
            EffectivePermissionsWire(userId: "user-1", permissions: ["notes:read", "calls:answer", "calls:read"])
        )
        let vm = EffectivePermissionsViewModel(rolesAPI: mock, userId: "user-1")
        await vm.load(hubId: "hub-1")
        #expect(vm.permissions == ["calls:answer", "calls:read", "notes:read"])
        #expect(vm.isLoading == false)
    }

    @Test func permissionsByDomainGroupsCorrectly() {
        let mock = MockRolesAPIService()
        let vm = EffectivePermissionsViewModel(rolesAPI: mock, userId: "user-1")
        vm.permissions = ["calls:answer", "notes:create", "calls:read"]
        let groups = vm.permissionsByDomain
        #expect(groups.count == 2)
        #expect(groups[0].domain == "calls")
        #expect(groups[0].keys == ["calls:answer", "calls:read"])
        #expect(groups[1].domain == "notes")
    }

    @Test func loadSetsErrorOnFailure() async {
        let mock = MockRolesAPIService()
        mock.effectivePermissionsResult = .failure(URLError(.notConnectedToInternet))
        let vm = EffectivePermissionsViewModel(rolesAPI: mock, userId: "user-1")
        await vm.load(hubId: nil)
        #expect(vm.errorMessage != nil)
        #expect(vm.permissions.isEmpty)
    }
}
