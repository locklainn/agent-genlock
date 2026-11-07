import Foundation

/// A project you were in never closes out from under you: closing or ending its last session
/// opens a fresh, empty one in its place, in the same pane.
extension AppModel {
    /// Closes a tab. If it was the project's last, a fresh session takes its place.
    func closeTab(_ key: String) {
        keepProjectOpen(closing: key) { tuck(key) }
    }

    /// Ends a session after asking. If it was the project's last, a fresh session takes its place.
    func endAndKeepProject(_ key: String) {
        keepProjectOpen(closing: key) { confirmEnd(key) }
    }

    /// Shows a project from the bar's plus menu: where you were in it, else a new session.
    func openProject(_ project: String) {
        if let onScreen = visible.first(where: { sessions[$0]?.projectID == project }) { return focus(onScreen) }
        if sessionKeys(in: project).isEmpty { newSession(in: project) } else { showProject(project) }
    }

    private func keepProjectOpen(closing key: String, _ close: () -> Void) {
        guard let project = sessions[key]?.projectID else { return close() }
        let wasLast = sessionKeys(in: project) == [key]
        let before = visible
        close()
        // Cancelled, or not the last: nothing to replace.
        guard wasLast, project != assistantFolder, sessionKeys(in: project).isEmpty,
              sessions[key] == nil || tucked.contains(key) else { return }
        newSession(in: project)
        guard let fresh = visible.first, let pane = before.firstIndex(of: key), before.count > 1 else { return }
        var split = before
        split[pane] = fresh
        visible = split.filter { sessions[$0] != nil && !tucked.contains($0) }
        focus(fresh)
    }
}
