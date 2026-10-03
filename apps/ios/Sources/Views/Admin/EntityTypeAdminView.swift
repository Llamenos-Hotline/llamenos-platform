import SwiftUI

struct EntityTypeAdminView: View {
    @Environment(AppState.self) private var appState

    @State private var entityTypes: [CaseEntityTypeDefinition] = []
    @State private var loading = true
    @State private var editingType: CaseEntityTypeDefinition?
    @State private var loadError: String?

    var body: some View {
        List {
            ForEach(entityTypes) { et in
                HStack {
                    VStack(alignment: .leading) {
                        Text(et.label).fontWeight(.medium)
                        Text(et.labelPlural).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
                .onTapGesture { editingType = et }
                .accessibilityIdentifier("entity-type-row-\(et.id)")
            }
        }
        .navigationTitle(NSLocalizedString("admin_entity_types_title", comment: "Entity Types"))
        .task { await loadTypes() }
        .sheet(item: $editingType) { et in
            EntityTypeEditorView(entityType: et) { updated in
                if let i = entityTypes.firstIndex(where: { $0.id == updated.id }) {
                    entityTypes[i] = updated
                }
            }
            .environment(appState)
        }
        .overlay {
            if loading {
                ProgressView()
            } else if let err = loadError, entityTypes.isEmpty {
                ContentUnavailableView(err, systemImage: "exclamationmark.triangle")
            }
        }
    }

    private func loadTypes() async {
        loading = true
        loadError = nil
        do {
            let response: EntityTypesResponse = try await appState.apiService.request(
                method: "GET", path: appState.apiService.hp("/api/settings/cms/entity-types")
            )
            entityTypes = response.entityTypes.filter { $0.isArchived != true }
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }
}
