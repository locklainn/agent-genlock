import Foundation

/// Closing a session ends it, everywhere the same way: the tab ✕, the tab menu's Close, the
/// project menu's Close All, and the pane header's ✕ in grid or single view all ask once, then
/// end into Recently ended. Nothing waits hidden to come back.
extension AppModel {
    /// What every close control calls: asks for confirmation before anything ends.
    func requestClose(_ keys: [String]) {
        let live = keys.filter { sessions[$0] != nil }
        if !live.isEmpty { closing = live }
    }

    /// The confirmed close, and the driver's. Ends the session into Recently ended. Closing the
    /// one you were looking at, alone on screen, keeps you in its project: its other session, or a
    /// fresh one when it was the last (never the Assistant, which nobody chose to go to).
    func closeTab(_ key: String, replace: Bool = true) {
        let project = sessions[key]?.projectID
        let alone = visible == [key] && route == .sessions
        endNoted(key)
        guard replace, alone, let project, project != assistantFolder else { return }
        if sessionKeys(in: project).isEmpty { newSession(in: project) }
    }

    func confirmClose() {
        let keys = closing ?? []
        closing = nil
        // Close All means the project is being cleared, so nothing replaces its sessions.
        keys.forEach { closeTab($0, replace: keys.count == 1) }
    }

    /// Shows a project from the bar's plus menu: where you were in it, else a new session.
    func openProject(_ project: String) {
        if let onScreen = visible.first(where: { sessions[$0]?.projectID == project }) { return focus(onScreen) }
        if sessionKeys(in: project).isEmpty { newSession(in: project) } else { openProjectHub(project) }
    }
}
