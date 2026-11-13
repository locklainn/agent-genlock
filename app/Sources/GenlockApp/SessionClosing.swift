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
    /// one you were looking at keeps you in its project: its other session, or its blank page with
    /// Start a session when it was the last. Nothing starts on its own, so a project you cleared
    /// has no empty session for a status update to report on.
    func closeTab(_ key: String) {
        endNoted(key)
    }

    func confirmClose() {
        let keys = closing ?? []
        closing = nil
        keys.forEach { closeTab($0) }
    }

    /// Shows a project from the bar's plus menu: where you were in it, else its blank page.
    func openProject(_ project: String) {
        if let onScreen = visible.first(where: { sessions[$0]?.projectID == project }) { return focus(onScreen) }
        openProjectHub(project)
    }

    /// A project with no sessions open: its page, blank but for Start a session.
    func showEmptyProject(_ project: String) {
        if let now = visible.first { previousSession = now }
        visible = []
        activeProject = project
        emptyProject = project
        route = .sessions
    }
}
