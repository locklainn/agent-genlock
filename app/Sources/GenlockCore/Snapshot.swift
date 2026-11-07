import Foundation

/// The JSON that `genlock snapshot` prints. The app reads records only through this.
public struct Snapshot: Decodable, Equatable {
    public static let supportedFormat = 3

    public var format: Int
    public var root: String
    public var initialized: Bool
    public var goalsDeclined: Bool?
    public var currentGoal: String?
    public var lastTicket: String?
    public var goals: [Goal]
    public var tickets: [Ticket]
    public var openTickets: [String]
    public var questionsForUser: [Question]
    public var reviews: [Review]
    public var claims: [Claim]
    public var uncommitted: Int?

    public struct Goal: Decodable, Equatable, Identifiable {
        /// Whether someone chose its short name. Otherwise that is just the start of the title.
        public var named: Bool?
        public var heading: String { Snapshot.heading(short: named == false ? nil : short, title: title) }
        /// Its place in the strict order, from 1. Nil once closed.
        public var rank: Int?
        public var due: String?
        public var daysUntil: Int?
        public var short: String?
        public var id: String
        public var title: String
        public var status: String
        public var why: String?
        public var doneWhen: String?
        public var waitingOn: String?
        public var lastActivity: String?
        public var created: String?
        /// When it was finished, and what showed it. Nil until then.
        public var completedAt: String?
        public var evidence: String?
        public var progress: Progress
        public var next: [NextThing]
        public var forbids: [Forbid]
        public var decisions: [Decision]
        public var refs: [Ref]
    }

    public struct Progress: Decodable, Equatable {
        public var done: Int
        public var total: Int
        public var blocked: Int
    }

    public struct NextThing: Decodable, Equatable, Identifiable {
        public var n: Int
        public var text: String
        public var due: String?
        public var daysUntil: Int?
        public var id: String { "\(n):\(text)" }
    }

    public struct Forbid: Decodable, Equatable {
        public var text: String
        public var liftedBy: String?
    }

    public struct Decision: Decodable, Equatable {
        public var text: String
        public var userSaid: String?
        public var withdrawn: Bool?
    }

    public struct Ref: Decodable, Equatable {
        public var path: String
        public var why: String
    }

    public struct Ticket: Decodable, Equatable, Identifiable {
        /// Whether someone chose its short name. Otherwise that is just the start of the title.
        public var named: Bool?
        public var heading: String { Snapshot.heading(short: named == false ? nil : short, title: title) }
        /// The session working on it.
        public var owner: String?
        /// Its place in the strict order, from 1. Nil once closed.
        public var rank: Int?
        public var due: String?
        public var daysUntil: Int?
        public var short: String?
        public var id: String
        public var title: String
        public var status: String
        public var goal: String?
        public var updated: String
        public var summary: String
        public var latest: Latest?
        public var blockedReason: String?
        public var requirements: [Requirement]
        public var hazards: [Hazard]
        public var forbids: [Forbid]
    }

    public struct Latest: Decodable, Equatable {
        public var text: String
        public var at: String
    }

    public struct Requirement: Decodable, Equatable, Identifiable {
        public var n: Int
        public var text: String
        public var state: String
        public var evidence: String?
        public var id: Int { n }
    }

    public struct Hazard: Decodable, Equatable {
        public var what: String
        public var verify: String
    }

    public struct Question: Decodable, Equatable, Identifiable {
        public var id: String
        public var text: String
        public var about: String?
    }

    public struct Review: Decodable, Equatable, Identifiable {
        public var id: String
        public var path: String
        public var why: String
        public var about: String?
        public var status: String
        public var note: String?
        public var updated: String?

        public var isOpen: Bool { status == "open" }
        public var isURL: Bool { path.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil }

        /// Where to open this, resolved against the project's folder.
        public func url(root: String) -> URL? {
            if isURL { return URL(string: path) }
            if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
            return URL(fileURLWithPath: root).appendingPathComponent(path)
        }

        public func exists(root: String) -> Bool {
            if isURL { return true }
            guard let url = url(root: root) else { return false }
            return FileManager.default.fileExists(atPath: url.path)
        }
    }

    public struct Claim: Decodable, Equatable, Identifiable {
        public var key: String
        public var session: String
        public var paths: [String]
        public var resources: [String]
        public var id: String { key }
    }

    public static func decode(_ data: Data) throws -> Snapshot {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return try d.decode(Snapshot.self, from: data)
    }

    public var openReviews: [Review] { reviews.filter(\.isOpen) }
    public func goal(_ id: String?) -> Goal? { goals.first { $0.id == id } }
    public func ticket(_ id: String?) -> Ticket? { tickets.first { $0.id == id } }
    public var activeTickets: [Ticket] { tickets.filter { openTickets.contains($0.id) } }

    /// A heading to read at a glance: the short name in plain words, or the title if it has none.
    public static func heading(short: String?, title: String) -> String {
        guard let short, !short.isEmpty else { return title }
        let words = short.replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// What the panel shows by default: what is going on now, with the rest a level down.
    public struct TaskFocus: Equatable {
        public var active: [Ticket]
        public var justFinished: [Ticket]
        public var backlog: [Ticket]
    }

    /// Counts as going on: started, stuck, or touched in the last day.
    public static let recentSeconds: TimeInterval = 24 * 3600
    public static let justFinishedLimit = 3

    public func taskFocus(now: Date = Date()) -> TaskFocus {
        let recent = { (t: Ticket) in
            ISODate.parse(t.updated).map { now.timeIntervalSince($0) <= Self.recentSeconds } ?? false
        }
        let order = ["in_progress": 0, "blocked": 1]
        let active = rankedTasks
            .filter { $0.status == "in_progress" || $0.status == "blocked" || recent($0) }
            .sorted { (order[$0.status] ?? 2, $1.updated) < (order[$1.status] ?? 2, $0.updated) }
        let ids = Set(active.map(\.id))
        let finished = tickets.filter { $0.status == "done" && recent($0) }.sorted { $0.updated > $1.updated }
        return TaskFocus(active: active, justFinished: Array(finished.prefix(Self.justFinishedLimit)),
                         backlog: rankedTasks.filter { !ids.contains($0.id) })
    }

    /// Open tasks, most important first.
    public var rankedTasks: [Ticket] { activeTickets.sorted { ($0.rank ?? .max) < ($1.rank ?? .max) } }

    /// What one session is on, out of everything in its project. A spin-off's own ticket is its own
    /// from the start, even before its agent takes it.
    public struct SessionFocus: Equatable {
        public var goal: Goal?
        public var mine: [Ticket]
        /// What it most recently finished, for when it is on nothing now.
        public var lastFinished: Ticket?
        public var working: Ticket? { mine.first }

        public init(goal: Goal?, mine: [Ticket], lastFinished: Ticket? = nil) {
            self.goal = goal
            self.mine = mine
            self.lastFinished = lastFinished
        }
    }

    public func sessionFocus(agents: Set<String>, ticket: String? = nil) -> SessionFocus {
        let order = ["in_progress": 0, "blocked": 1]
        let mine = rankedTasks
            .filter { $0.id == ticket || $0.owner.map(agents.contains) == true }
            .sorted { (($0.id == ticket ? 0 : 1), order[$0.status] ?? 2, $0.rank ?? .max) < (($1.id == ticket ? 0 : 1), order[$1.status] ?? 2, $1.rank ?? .max) }
        let finished = tickets.filter { $0.status == "done" && $0.owner.map(agents.contains) == true }.max { $0.updated < $1.updated }
        return SessionFocus(goal: goal(mine.first?.goal) ?? goal(currentGoal), mine: mine, lastFinished: finished)
    }

    /// Questions for you, by the goal or task each is about. `isCurrent` marks what the session is on.
    public struct QuestionGroup: Equatable, Identifiable {
        public var about: String?
        public var label: String
        public var isCurrent: Bool
        public var questions: [Question]
        public var id: String { about ?? "general" }
    }

    public func questionGroups(focus: SessionFocus) -> [QuestionGroup] {
        let current = Set([focus.goal?.id].compactMap { $0 } + focus.mine.flatMap { [$0.id, $0.goal].compactMap { $0 } })
        var order: [String?] = []
        for q in questionsForUser where !order.contains(q.about) { order.append(q.about) }
        let groups = order.map { about -> QuestionGroup in
            let label = about.flatMap { id in goal(id)?.heading ?? tickets.first { $0.id == id }?.heading } ?? "General"
            return QuestionGroup(about: about, label: label, isCurrent: about.map(current.contains) ?? false,
                                 questions: questionsForUser.filter { $0.about == about })
        }
        func place(_ g: QuestionGroup) -> Int { goal(g.about)?.rank ?? tickets.first { $0.id == g.about }?.rank ?? .max }
        return groups.sorted { ($0.isCurrent ? 0 : 1, place($0)) < ($1.isCurrent ? 0 : 1, place($1)) }
    }

    /// What a session is doing, in one answer, from what its agent is doing and what it holds.
    public struct SessionStatus: Equatable {
        /// `waitingForWork` is said only when nothing suggests the agent did work off the record;
        /// `untracked` is a turn that ran with no task at all, which is worth a look.
        public enum Kind: Equatable { case working, workingUnrecorded, needsYou, paused, untracked, waitingForWork, ended }
        public var kind: Kind
        public var headline: String
        public var task: Ticket?
        public var detail: String?
    }

    public static func sessionStatus(phase: String?, isRunning: Bool, message: String?, focus: SessionFocus) -> SessionStatus {
        let task = focus.working
        let said = message.map(plainLine).flatMap { $0.isEmpty ? nil : $0 }
        let progress = task?.blockedReason ?? task?.latest?.text
        if !isRunning { return SessionStatus(kind: .ended, headline: "Session ended", task: task, detail: nil) }
        switch phase {
        case "working":
            return task == nil
                ? SessionStatus(kind: .workingUnrecorded, headline: "Working, no task recorded", task: nil, detail: nil)
                : SessionStatus(kind: .working, headline: "Working on", task: task, detail: progress)
        case "waiting":
            return SessionStatus(kind: .needsYou, headline: "Needs you", task: task, detail: said)
        default:
            if task != nil { return SessionStatus(kind: .paused, headline: "Paused on", task: task, detail: said ?? progress) }
            // No turn yet, or its last turn closed a task: there is no sign of work off the record.
            if phase == nil { return SessionStatus(kind: .waitingForWork, headline: "Waiting for work", task: nil, detail: nil) }
            if let last = focus.lastFinished {
                return SessionStatus(kind: .waitingForWork, headline: "Waiting for work", task: nil, detail: "Last finished: \(last.heading)")
            }
            // It ran a turn and has never had a task. It may have done real work nobody recorded.
            return SessionStatus(kind: .untracked, headline: "No task recorded", task: nil, detail: said ?? "It has run, but never on a task. Check what it did.")
        }
    }

    /// What an agent said, as a line to read: no status label, no markdown.
    static func plainLine(_ text: String) -> String {
        var line = text.replacingOccurrences(of: #"\[[A-Z-]+\]\s*"#, with: "", options: .regularExpression)
        line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
        return line.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Finished goals, newest first.
    public var completedGoals: [Goal] {
        goals.filter { $0.status == "done" }.sorted { ($0.completedAt ?? "") > ($1.completedAt ?? "") }
    }

    /// What has to close before this goal can.
    public func openTasks(of goal: Goal) -> [Ticket] { activeTickets.filter { $0.goal == goal.id } }

    /// Open goals, most important first.
    public var rankedGoals: [Goal] { goals.filter { $0.rank != nil }.sorted { $0.rank! < $1.rank! } }
}

/// What a dashboard card needs, derived in one place so it can be tested without a screen.
public struct CardSummary: Equatable {
    public var goalTitle: String?
    public var goalProgress: String?
    public var nextThing: String?
    public var lastTaskTitle: String?
    public var lastTaskStatus: String?
    public var lastTaskUpdated: Date?
    public var waitingOnYou: Int
    public var toReview: Int
    public var deadline: Deadline?
    public var needsSetup: Bool
    public var extraGoals: Int

    public struct Deadline: Equatable {
        public var text: String
        public var daysUntil: Int
        public init(text: String, daysUntil: Int) {
            self.text = text
            self.daysUntil = daysUntil
        }
        public var isOverdue: Bool { daysUntil < 0 }
        public var label: String {
            switch daysUntil {
            case ..<0: return "overdue by \(-daysUntil)d"
            case 0: return "due today"
            case 1: return "due tomorrow"
            default: return "due in \(daysUntil)d"
            }
        }
    }

    public static let deadlineWindowDays = 7

    public init(_ s: Snapshot) {
        let current = s.goal(s.currentGoal)
        goalTitle = current?.title
        goalProgress = current.flatMap { $0.progress.total > 0 ? "\($0.progress.done) of \($0.progress.total)" : nil }
        nextThing = current?.next.first?.text
        let last = s.ticket(s.lastTicket)
        lastTaskTitle = last?.title
        lastTaskStatus = last?.status
        lastTaskUpdated = last.flatMap { ISODate.parse($0.updated) }
        waitingOnYou = s.questionsForUser.count
        toReview = s.openReviews.count
        needsSetup = !s.initialized
        let live = s.goals.filter { $0.status == "active" || $0.status == "parked" }
        extraGoals = max(0, s.goals.filter { $0.status == "active" }.count - 1)
        let nextDates = live.flatMap(\.next).compactMap { n in n.daysUntil.map { Deadline(text: n.text, daysUntil: $0) } }
        let goalDates = live.compactMap { g in g.daysUntil.map { Deadline(text: g.title, daysUntil: $0) } }
        let taskDates = s.activeTickets.compactMap { t in t.daysUntil.map { Deadline(text: t.title, daysUntil: $0) } }
        deadline = (nextDates + goalDates + taskDates)
            .filter { $0.daysUntil <= Self.deadlineWindowDays }
            .min { $0.daysUntil < $1.daysUntil }
    }
}

public enum ISODate {
    public static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// "5m ago". Short enough for a card, and honest about precision.
    public static func age(_ date: Date, now: Date = Date()) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        switch s {
        case ..<60: return "just now"
        case ..<3600: return "\(s / 60)m ago"
        case ..<86400: return "\(s / 3600)h ago"
        default: return "\(s / 86400)d ago"
        }
    }
}

/// Which things changed between two snapshots, so the UI can point at them.
public enum SnapshotDiff {
    public static func changedIDs(old: Snapshot?, new: Snapshot) -> Set<String> {
        guard let old else { return [] }
        let before = signatures(old)
        let after = signatures(new)
        return Set(after.compactMap { key, sig in before[key] == sig ? nil : key })
    }

    private static func signatures(_ s: Snapshot) -> [String: String] {
        var out: [String: String] = [:]
        for g in s.goals {
            out[g.id] = "\(g.title)|\(g.status)|\(g.progress.done)/\(g.progress.total)/\(g.progress.blocked)|\(g.waitingOn ?? "")"
            for n in g.next { out["\(g.id)/next/\(n.text)"] = "\(n.n)|\(n.due ?? "")" }
        }
        for t in s.tickets {
            out[t.id] = "\(t.title)|\(t.status)|\(t.summary)|\(t.latest?.text ?? "")|\(t.hazards.count)"
        }
        for q in s.questionsForUser { out[q.id] = q.text }
        for r in s.reviews { out[r.id] = "\(r.status)|\(r.why)" }
        return out
    }
}
