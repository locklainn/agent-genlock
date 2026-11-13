import Foundation
import GenlockCore

/// What the grid view shows, written for the phone's Status tab: every project with a tab, each
/// session in the order its grid shows them, with the same title, status line and dot the panes
/// show. The phone bridge sends this file on, so the phone reads what the Mac decided rather than
/// working it out again from the records (which is how the old Status tab drifted from the Mac).
extension AppModel {
    static var phoneGridFile: URL {
        VoiceChannel.defaultBase.deletingLastPathComponent().appendingPathComponent("phone/grid.json")
    }

    func phoneGrid() -> [String: Any] {
        let projects: [[String: Any]] = projectsWithTabs.map { project in
            let snap = state(for: project).snapshot.flatMap { $0.initialized ? $0 : nil }
            let rows: [[String: Any]] = gridKeys(project, start: false).compactMap { key in
                guard let session = self.sessions[key] else { return nil }
                var row: [String: Any] = ["key": key, "title": tabLabel(key), "running": session.isRunning]
                if session.slot == Self.subSlot { row["assistant"] = true }
                if let need = session.attention { row["attention"] = need.rawValue }
                if let phase = session.phase { row["phase"] = phase }
                if let wait = session.wait {
                    row["wait"] = ["state": wait.state.rawValue, "gist": wait.gist, "headline": wait.headline, "since": wait.since]
                }
                if let snap {
                    let found = session.focus(in: snap)
                    let status = session.status(in: snap)
                    var st: [String: Any] = ["kind": Self.kindName(status.kind), "headline": status.headline]
                    if let task = status.task {
                        st["task"] = task.heading
                        st["taskStatus"] = task.status
                        if !task.summary.isEmpty { st["proof"] = task.summary }
                    }
                    if let detail = status.detail { st["detail"] = String(detail.prefix(300)) }
                    if let ws = status.waitState { st["waitState"] = ws.rawValue }
                    row["status"] = st
                    if found.mine.count > 1 { row["more"] = found.mine.count - 1 }
                    if let goal = snap.goal(found.working?.goal) {
                        row["goal"] = ["title": goal.heading, "done": goal.progress.done, "total": goal.progress.total]
                    }
                    let own = Snapshot.SessionFocus(goal: snap.goal(found.working?.goal), mine: found.mine, lastFinished: found.lastFinished)
                    let questions = snap.questionGroups(focus: own).filter(\.isCurrent).reduce(0) { $0 + $1.questions.count }
                    if questions > 0 { row["questions"] = questions }
                } else {
                    row["status"] = ["kind": session.isRunning ? "loading" : "ended", "headline": session.isRunning ? "Loading" : "Session ended"]
                }
                return row
            }
            var p: [String: Any] = ["id": project, "name": projectName(project), "sessions": rows]
            if project == assistantFolder { p["hub"] = true }
            if let need = attention(project: project) { p["attention"] = need.rawValue }
            return p
        }
        return ["pid": Int(ProcessInfo.processInfo.processIdentifier), "projects": projects]
    }

    static func kindName(_ kind: Snapshot.SessionStatus.Kind) -> String {
        switch kind {
        case .working: return "working"
        case .workingUnrecorded: return "workingUnrecorded"
        case .needsYou: return "needsYou"
        case .waitingOn: return "waitingOn"
        case .paused: return "paused"
        case .untracked: return "untracked"
        case .waitingForWork: return "waitingForWork"
        case .ended: return "ended"
        }
    }

    /// Written only when something on it changed, so the bridge can push on each write.
    func writePhoneGrid() {
        guard let data = try? JSONSerialization.data(withJSONObject: phoneGrid(), options: [.sortedKeys]) else { return }
        if data == lastPhoneGrid { return }
        lastPhoneGrid = data
        let file = Self.phoneGridFile
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}
