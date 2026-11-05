import Foundation

/// The JSON that `genlock snapshot` prints. The app reads records only through this.
public struct Snapshot: Decodable, Equatable {
    public static let supportedFormat = 2

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
        public var id: String
        public var title: String
        public var status: String
        public var why: String?
        public var doneWhen: String?
        public var waitingOn: String?
        public var lastActivity: String?
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
        deadline = live.flatMap(\.next)
            .compactMap { n in n.daysUntil.map { Deadline(text: n.text, daysUntil: $0) } }
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
