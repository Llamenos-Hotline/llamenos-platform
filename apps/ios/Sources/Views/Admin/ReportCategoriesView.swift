import SwiftUI

// MARK: - ReportCategoriesView

/// Admin view for managing report categories. Shows a list of categories with
/// swipe-to-delete and a toolbar button to add new categories via an alert.
struct ReportCategoriesView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        ZStack {
            if viewModel.isLoadingReportCategories && viewModel.reportCategories.isEmpty {
                loadingState
            } else if viewModel.reportCategories.isEmpty {
                emptyState
            } else {
                categoriesList
            }
        }
        .navigationTitle(NSLocalizedString("admin_report_categories", comment: "Report Categories"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.newCategoryName = ""
                    viewModel.showNewCategoryAlert = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("add-category-button")
                .accessibilityLabel(NSLocalizedString("admin_add_category", comment: "Add Category"))
            }
        }
        .alert(
            NSLocalizedString("admin_new_category_title", comment: "New Category"),
            isPresented: $viewModel.showNewCategoryAlert
        ) {
            TextField(
                NSLocalizedString("admin_category_name_placeholder", comment: "Category name"),
                text: $viewModel.newCategoryName
            )
            .accessibilityIdentifier("category-name-input")

            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {
                viewModel.newCategoryName = ""
            }

            Button(NSLocalizedString("admin_add_category", comment: "Add")) {
                Task { await viewModel.createReportCategory(name: viewModel.newCategoryName) }
            }
            .disabled(viewModel.newCategoryName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text(NSLocalizedString(
                "admin_new_category_message",
                comment: "Enter a name for the new report category."
            ))
        }
        .refreshable {
            viewModel.isLoadingReportCategories = false
            await viewModel.loadReportCategories()
        }
        .task {
            await viewModel.loadReportCategories()
        }
        .accessibilityIdentifier("report-categories-view")
    }

    // MARK: - Categories List

    private var categoriesList: some View {
        List {
            Section {
                ForEach(viewModel.reportCategories) { category in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(category.name)
                                .font(.brand(.body))
                                .foregroundStyle(Color.brandForeground)

                            if let date = category.createdDate {
                                Text(date.formatted(date: .abbreviated, time: .omitted))
                                    .font(.brand(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                            }
                        }

                        Spacer()

                        Image(systemName: "tag.fill")
                            .font(.caption)
                            .foregroundStyle(Color.brandPrimary.opacity(0.5))
                    }
                    .padding(.vertical, 2)
                    .accessibilityIdentifier("category-row-\(category.id)")
                }
                .onDelete { indexSet in
                    for index in indexSet {
                        let category = viewModel.reportCategories[index]
                        viewModel.confirmDelete(id: category.id, type: .reportCategory)
                    }
                }
            } header: {
                Text(L10n.format(
                    "admin_categories_header",
                    comment: "Categories (%d)",
                    viewModel.reportCategories.count
                ))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("report-categories-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_no_categories", comment: "No Categories"),
                systemImage: "tag"
            )
        } description: {
            Text(NSLocalizedString(
                "admin_no_categories_message",
                comment: "Report categories help classify incidents."
            ))
        } actions: {
            Button {
                viewModel.newCategoryName = ""
                viewModel.showNewCategoryAlert = true
            } label: {
                Text(NSLocalizedString("admin_add_first_category", comment: "Add First Category"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("add-first-category")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("categories-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_categories", comment: "Loading categories..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("categories-loading")
    }
}
