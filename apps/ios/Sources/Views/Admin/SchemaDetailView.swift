import SwiftUI

// MARK: - SchemaDetailView

/// Read-only detail view for an entity type schema. Shows name, description,
/// category, fields list, statuses, severities, and contact roles.
/// No editing — that is desktop-only.
struct SchemaDetailView: View {
    let entityType: EntityType

    var body: some View {
        List {
            // Overview section
            overviewSection

            // Fields section
            fieldsSection

            // Statuses section
            statusesSection

            // Severities section (if defined)
            if let severities = entityType.severities, !severities.isEmpty {
                severitiesSection(severities)
            }

            // Contact roles (if defined)
            if let contactRoles = entityType.contactRoles, !contactRoles.isEmpty {
                contactRolesSection(contactRoles)
            }

            // Configuration section
            configSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle(entityType.label)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("schema-detail-view")
    }

    // MARK: - Overview Section

    private var overviewSection: some View {
        Section {
            LabeledContent(
                NSLocalizedString("schema_name", comment: "Name"),
                value: entityType.name
            )
            .accessibilityIdentifier("schema-detail-name")

            LabeledContent(
                NSLocalizedString("schema_label", comment: "Label"),
                value: entityType.label
            )

            LabeledContent(
                NSLocalizedString("schema_label_plural", comment: "Plural"),
                value: entityType.labelPlural
            )

            if let description = entityType.description, !description.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(NSLocalizedString("schema_description", comment: "Description"))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                    Text(description)
                        .font(.brand(.body))
                }
            }

            if let category = entityType.category {
                LabeledContent(
                    NSLocalizedString("schema_category", comment: "Category"),
                    value: category
                )
            }

            if let templateId = entityType.templateId {
                LabeledContent(
                    NSLocalizedString("schema_template", comment: "Template"),
                    value: templateId
                )
            }
        } header: {
            Text(NSLocalizedString("schema_overview", comment: "Overview"))
        }
    }

    // MARK: - Fields Section

    private var fieldsSection: some View {
        Section {
            if entityType.fields.isEmpty {
                Text(NSLocalizedString("schema_no_fields", comment: "No fields defined"))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandMutedForeground)
            } else {
                ForEach(entityType.fields) { field in
                    FieldRow(field: field)
                }
            }
        } header: {
            HStack {
                Text(NSLocalizedString("schema_fields", comment: "Fields"))
                Spacer()
                Text("\(entityType.fields.count)")
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
    }

    // MARK: - Statuses Section

    private var statusesSection: some View {
        Section {
            ForEach(entityType.statuses) { status in
                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor(status))
                        .frame(width: 10, height: 10)

                    Text(status.label)
                        .font(.brand(.body))

                    Spacer()

                    if status.value == entityType.defaultStatus {
                        Text(NSLocalizedString("schema_default", comment: "Default"))
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandPrimary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.brandPrimary.opacity(0.12))
                            .clipShape(Capsule())
                    }

                    if entityType.closedStatuses?.contains(status.value) == true ||
                        status.isClosed == true {
                        Text(NSLocalizedString("schema_closed", comment: "Closed"))
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.brandMutedForeground.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
                .accessibilityIdentifier("schema-status-\(status.value)")
            }
        } header: {
            HStack {
                Text(NSLocalizedString("schema_statuses", comment: "Statuses"))
                Spacer()
                Text("\(entityType.statuses.count)")
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
    }

    // MARK: - Severities Section

    private func severitiesSection(_ severities: [CaseEnumOption]) -> some View {
        Section {
            ForEach(severities) { severity in
                HStack(spacing: 8) {
                    if let colorHex = severity.color {
                        Circle()
                            .fill(Color(hex: colorHex) ?? Color.brandMutedForeground)
                            .frame(width: 10, height: 10)
                    }

                    Text(severity.label)
                        .font(.brand(.body))

                    Spacer()

                    if severity.value == entityType.defaultSeverity {
                        Text(NSLocalizedString("schema_default", comment: "Default"))
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandPrimary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.brandPrimary.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }
        } header: {
            Text(NSLocalizedString("schema_severities", comment: "Severities"))
        }
    }

    // MARK: - Contact Roles Section

    private func contactRolesSection(_ roles: [CaseEnumOption]) -> some View {
        Section {
            ForEach(roles) { role in
                HStack(spacing: 8) {
                    Image(systemName: role.icon ?? "person.fill")
                        .foregroundStyle(Color.brandPrimary)
                        .frame(width: 20)

                    Text(role.label)
                        .font(.brand(.body))
                }
            }
        } header: {
            Text(NSLocalizedString("schema_contact_roles", comment: "Contact Roles"))
        }
    }

    // MARK: - Config Section

    private var configSection: some View {
        Section {
            if let prefix = entityType.numberPrefix {
                LabeledContent(
                    NSLocalizedString("schema_number_prefix", comment: "Number Prefix"),
                    value: prefix
                )
            }

            configToggle(
                NSLocalizedString("schema_numbering", comment: "Auto-Numbering"),
                value: entityType.numberingEnabled ?? false
            )

            configToggle(
                NSLocalizedString("schema_sub_records", comment: "Sub-Records"),
                value: entityType.allowSubRecords ?? false
            )

            configToggle(
                NSLocalizedString("schema_file_attachments", comment: "File Attachments"),
                value: entityType.allowFileAttachments ?? true
            )

            configToggle(
                NSLocalizedString("schema_interactions", comment: "Interaction Links"),
                value: entityType.allowInteractionLinks ?? true
            )

            if let accessLevel = entityType.defaultAccessLevel {
                LabeledContent(
                    NSLocalizedString("schema_access_level", comment: "Default Access"),
                    value: accessLevel
                )
            }
        } header: {
            Text(NSLocalizedString("schema_configuration", comment: "Configuration"))
        }
    }

    // MARK: - Helpers

    private func configToggle(_ label: String, value: Bool) -> some View {
        HStack {
            Text(label)
                .font(.brand(.body))
            Spacer()
            Image(systemName: value ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(value ? Color.green : Color.brandMutedForeground)
        }
    }

    private func statusColor(_ status: CaseEnumOption) -> Color {
        if let colorHex = status.color, !colorHex.isEmpty {
            return Color(hex: colorHex) ?? Color.brandPrimary
        }
        return Color.brandPrimary
    }
}

// MARK: - FieldRow

/// A single field row showing name, type, required badge, and access level badge.
private struct FieldRow: View {
    let field: SharedEntityTypeDefinitionField

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Field label and name
            HStack {
                Text(field.label)
                    .font(.brand(.body))
                    .fontWeight(.medium)

                Spacer()

                // Type chip
                Text(field.type.rawValue)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(Color.brandPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.brandPrimary.opacity(0.12))
                    .clipShape(Capsule())
            }

            // Badges row
            HStack(spacing: 6) {
                if field.required == true {
                    RequiredBadge()
                } else {
                    OptionalBadge()
                }

                if let accessLevel = field.accessLevel, accessLevel != "all" {
                    AccessLevelBadge(level: accessLevel)
                }

                if let section = field.section, !section.isEmpty {
                    Text(section)
                        .font(.system(size: 10))
                        .foregroundStyle(Color.brandMutedForeground)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.brandMutedForeground.opacity(0.12))
                        .clipShape(Capsule())
                }
            }

            if let helpText = field.helpText, !helpText.isEmpty {
                Text(helpText)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("schema-field-\(field.id)")
    }
}

// MARK: - Badge Components

private struct RequiredBadge: View {
    var body: some View {
        Text(NSLocalizedString("schema_required", comment: "Required"))
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.brandDestructive)
            .clipShape(Capsule())
    }
}

private struct OptionalBadge: View {
    var body: some View {
        Text(NSLocalizedString("schema_optional", comment: "Optional"))
            .font(.system(size: 10))
            .foregroundStyle(Color.brandMutedForeground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.brandMutedForeground.opacity(0.12))
            .clipShape(Capsule())
    }
}

private struct AccessLevelBadge: View {
    let level: String

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "lock.fill")
                .font(.system(size: 8))
            Text(level)
                .font(.system(size: 10))
        }
        .foregroundStyle(Color.orange)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.orange.opacity(0.12))
        .clipShape(Capsule())
    }
}

// Color.init(hex:) is defined in ReportTypePicker.swift — shared app-wide

// MARK: - Preview

#if DEBUG
#Preview("Schema Detail") {
    NavigationStack {
        SchemaDetailView(entityType: EntityType(
            id: "preview-1",
            hubId: nil,
            name: "incident",
            label: "Incident",
            labelPlural: "Incidents",
            description: "Track incidents reported during events",
            icon: "exclamationmark.triangle",
            color: "#EF4444",
            category: "case",
            templateId: nil,
            templateVersion: nil,
            fields: [
                SharedEntityTypeDefinitionField(
                    id: "f1", name: "title", label: "Title", type: "text",
                    required: true, options: nil, lookupId: nil, validation: nil,
                    section: nil, helpText: "Brief incident title", placeholder: nil,
                    defaultValue: nil, order: 0, indexable: true, indexType: nil,
                    accessLevel: "all", accessRoles: nil, visibleToUsers: true,
                    editableByUsers: true, templateId: nil, hubEditable: nil
                ),
            ],
            statuses: [
                CaseEnumOption(value: "open", label: "Open", color: "#22C55E",
                               icon: nil, order: 0, isDefault: true, isClosed: nil, isDeprecated: nil),
                CaseEnumOption(value: "closed", label: "Closed", color: "#6B7280",
                               icon: nil, order: 1, isDefault: nil, isClosed: true, isDeprecated: nil),
            ],
            defaultStatus: "open",
            closedStatuses: ["closed"],
            severities: [
                CaseEnumOption(value: "low", label: "Low", color: "#3B82F6",
                               icon: nil, order: 0, isDefault: true, isClosed: nil, isDeprecated: nil),
                CaseEnumOption(value: "high", label: "High", color: "#EF4444",
                               icon: nil, order: 1, isDefault: nil, isClosed: nil, isDeprecated: nil),
            ],
            defaultSeverity: "low",
            categories: nil,
            contactRoles: nil,
            numberPrefix: "INC",
            numberingEnabled: true,
            defaultAccessLevel: "assigned",
            piiFields: nil,
            allowSubRecords: false,
            allowFileAttachments: true,
            allowInteractionLinks: true,
            showInNavigation: true,
            showInDashboard: true,
            accessRoles: nil,
            editRoles: nil,
            isArchived: false,
            isSystem: false,
            createdAt: "",
            updatedAt: ""
        ))
    }
}
#endif
