import Foundation

/// Suspend until `condition` holds, and say whether it did before `timeout` ran out.
///
/// There is no pause between looks: each one yields the executor, so the work the condition
/// is waiting on (a stubbed response delivered back onto the actor, a task the view model
/// started) runs in between, and the wait ends the turn after the condition becomes true.
/// `timeout` is a backstop that only bounds how long a fault takes to be reported — it is
/// never spent on a healthy run. A condition that is true on the final look after the deadline
/// still counts, so a slow turn cannot turn a satisfied wait into a failure.
@MainActor
func waitForCondition(timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        await Task.yield()
    }
    return condition()
}
