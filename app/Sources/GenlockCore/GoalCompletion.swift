import Foundation

/// Finishing a goal, and noticing that one was finished.
public enum GoalCompletion {
    /// Identifies one finish, so a goal reopened and finished again is new.
    public static func key(_ goal: Snapshot.Goal) -> String? {
        guard goal.status == "done", let at = goal.completedAt else { return nil }
        return "\(goal.id)@\(at)"
    }

    public static func keys(_ goals: [Snapshot.Goal]) -> Set<String> { Set(goals.compactMap(key)) }

    /// Goals finished since the keys in `seen` were saved, oldest first. Nil means this project has
    /// never been looked at, and history is not news.
    public static func newlyFinished(_ goals: [Snapshot.Goal], seen: Set<String>?) -> [Snapshot.Goal] {
        guard let seen else { return [] }
        return goals.filter { key($0).map { !seen.contains($0) } ?? false }
            .sorted { ($0.completedAt ?? "") < ($1.completedAt ?? "") }
    }

    public static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// One line on what it took, such as "12 tasks over 9 days". Empty when there is nothing to say.
    public static func summary(_ goal: Snapshot.Goal) -> String {
        var parts: [String] = []
        if goal.progress.done > 0 { parts.append(goal.progress.done == 1 ? "1 task" : "\(goal.progress.done) tasks") }
        if let start = date(goal.created), let end = date(goal.completedAt) {
            let days = Int(end.timeIntervalSince(start) / 86400)
            if days == 1 { parts.append("1 day") } else if days > 1 { parts.append("\(days) days") }
        }
        return parts.joined(separator: " over ")
    }

    /// Goal closure needs evidence, and this is what the records already show.
    public static func defaultEvidence(_ goal: Snapshot.Goal) -> String {
        goal.progress.total > 0 ? "\(goal.progress.done) of \(goal.progress.total) tasks done" : "Marked complete in the Genlock app"
    }

    /// Everything linked is finished and nothing is listed as next, so asking is reasonable.
    public static func looksReached(_ goal: Snapshot.Goal) -> Bool {
        goal.status == "active" && goal.progress.total > 0 && goal.progress.done == goal.progress.total && goal.next.isEmpty
    }
}
