import Foundation

/// Closing a session ends it. Nothing waits hidden to come back: the conversation goes to
/// Recently ended, one click from reopened, which is the undo in place of a dialog.
extension AppModel {
    /// The tab's ✕ and its menu's Close. No dialog, because Recently ended is the way back.
    func closeTab(_ key: String) {
        endNoted(key)
    }

    /// Shows a project from the bar's plus menu: where you were in it, else a new session.
    func openProject(_ project: String) {
        if let onScreen = visible.first(where: { sessions[$0]?.projectID == project }) { return focus(onScreen) }
        if sessionKeys(in: project).isEmpty { newSession(in: project) } else { showProject(project) }
    }
}
