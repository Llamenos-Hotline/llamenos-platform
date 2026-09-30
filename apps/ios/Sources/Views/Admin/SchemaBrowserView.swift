import SwiftUI

// MARK: - SchemaBrowserView

/// Read-only list of entity types defined for the hub. Fetches from
/// GET /api/settings/cms/entity-types and displays each type with
/// icon, name, field count, and status count. Tap navigates to detail.
struct SchemaBrowserView: View {
    @Environment(AppState.self) private var appState

    @State private var entityTypes: [CaseEntityTypeDefinition] = []
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("schema-browser-loading")
            } else if let errorMessage {
                ContentUnavailableView {
                    Label(
                        NSLocalizedString("error_title", comment: "Error"),
                        systemImage: "exclamationmark.triangle"
                    )
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button(NSLocalizedString("action_retry", comment: "Retry")) {
                        Task { await loadEntityTypes() }
                    }
                }
                .accessibilityIdentifier("schema-browser-error")
            } else if entityTypes.isEmpty {
                ContentUnavailableView {
                    Label(
                        NSLocalizedString("cases_no_entity_types", comment: "No Entity Types"),
                        systemImage: "doc.text.magnifyingglass"
                    )
                } description: {
                    Text(NSLocalizedString(
                        "cases_no_entity_types_description",
                        comment: "No entity types are configured for this hub."
                    ))
                }
                .accessibilityIdentifier("schema-browser-empty")
            } else {
                List(entityTypes) { entityType in
                    NavigationLink {
                        SchemaDetailView(entityType: entityType)
                    } label: {
                        EntityTypeRow(entityType: entityType)
                    }
                    .accessibilityIdentifier("schema-entity-\(entityType.id)")
                }
                .listStyle(.insetGrouped)
                .accessibilityIdentifier("schema-browser-list")
            }
        }
        .navigationTitle(NSLocalizedString("admin_schema_browser", comment: "Entity Types"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadEntityTypes()
        }
        .refreshable {
            await loadEntityTypes()
        }
    }

    // MARK: - Data Loading

    private func loadEntityTypes() async {
        isLoading = true
        errorMessage = nil

        do {
            let response: EntityTypesResponse = try await appState.apiService.request(
                method: "GET", path: appState.apiService.hp("/api/settings/cms/entity-types")
            )
            entityTypes = response.entityTypes.filter { $0.isArchived != true }
            isLoading = false
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }
}

// MARK: - EntityTypeRow

/// A single row in the entity type list showing icon, name, and metadata badges.
private struct EntityTypeRow: View {
    let entityType: CaseEntityTypeDefinition

    var body: some View {
        HStack(spacing: 12) {
            // Icon
            Image(systemName: iconName)
                .font(.title2)
                .foregroundStyle(iconColor)
                .frame(width: 36, height: 36)
                .background(iconColor.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))

            // Name and description
            VStack(alignment: .leading, spacing: 2) {
                Text(entityType.label)
                    .font(.brand(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)

                if let description = entityType.description, !description.isEmpty {
                    Text(description)
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                        .lineLimit(1)
                }

                // Metadata badges
                HStack(spacing: 8) {
                    BadgeView(
                        text: "\(entityType.fields.count) \(NSLocalizedString("schema_fields_label", comment: "fields"))",
                        icon: "list.bullet"
                    )

                    BadgeView(
                        text: "\(entityType.statuses.count) \(NSLocalizedString("schema_statuses_label", comment: "statuses"))",
                        icon: "circle.fill"
                    )

                    if let category = entityType.category {
                        BadgeView(
                            text: category,
                            icon: "folder"
                        )
                    }
                }
                .padding(.top, 2)
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }

    private var iconName: String {
        if let icon = entityType.icon, !icon.isEmpty {
            return icon
        }
        switch entityType.category {
        case "event": return "calendar"
        case "contact": return "person.crop.circle"
        default: return "doc.text"
        }
    }

    private var iconColor: Color {
        if let colorHex = entityType.color, !colorHex.isEmpty {
            return Color(hex: colorHex) ?? Color.brandPrimary
        }
        return Color.brandPrimary
    }
}

// BadgeView and Color.init(hex:) are defined app-wide in Components/BadgeView.swift and ReportTypePicker.swift

// MARK: - Preview

#if DEBUG
#Preview("Schema Browser") {
    NavigationStack {
        SchemaBrowserView()
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
