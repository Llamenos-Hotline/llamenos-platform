import Foundation

/// Holds a view's lazily created view model for the lifetime of the view.
///
/// Keep it in `@State` (`@State private var viewModelBox = ViewModelBox<VM>()`):
/// SwiftUI keeps the first box for the view's identity, and filling it during body
/// evaluation mutates an object, not view state, so the same view model is visible
/// to every later evaluation immediately.
///
/// It replaces creating the view model in a computed property and storing it with
/// `DispatchQueue.main.async { self.viewModel = vm }`. When the body was evaluated
/// twice before that block ran — a navigation push does it — two view models
/// existed: `.task` loaded one while the screen rendered the other, which stayed
/// empty. In CI the hub list showed "No Hubs" to a super-admin whose `GET
/// /api/hubs` had returned every hub.
final class ViewModelBox<ViewModel> {
    var value: ViewModel?
}
