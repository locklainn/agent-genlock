import Foundation

/// A task or goal picked from Whole project, to be typed into a session's prompt.
public struct PromptPick: Equatable, Hashable {
    public enum Kind: String { case task, goal }
    public var kind: Kind
    public var id: String
    /// The short name genlock resolves anywhere an id goes.
    public var short: String

    public init(kind: Kind, id: String, short: String?) {
        self.kind = kind
        self.id = id
        self.short = (short?.isEmpty == false ? short : nil) ?? id
    }
}

/// Picking tasks and goals into a prompt. A click types one; Shift-clicks mark several and
/// releasing Shift types them together, as Shift-clicking cards opens a split.
public struct PromptPicks: Equatable {
    public private(set) var marked: [PromptPick] = []

    public init() {}

    /// Returns what to type now, or nil if this click only marked or unmarked one.
    public mutating func click(_ pick: PromptPick, shift: Bool) -> [PromptPick]? {
        if !shift {
            defer { marked = [] }
            return marked.contains(pick) ? marked : marked + [pick]
        }
        if let i = marked.firstIndex(of: pick) { marked.remove(at: i) } else { marked.append(pick) }
        return nil
    }

    public mutating func shiftReleased() -> [PromptPick]? {
        guard !marked.isEmpty else { return nil }
        defer { marked = [] }
        return marked
    }

    public mutating func clear() { marked = [] }

    public func order(of pick: PromptPick) -> Int? { marked.firstIndex(of: pick).map { $0 + 1 } }

    /// What is typed: short names the agent can hand straight to genlock, never submitted, with
    /// a trailing space so you carry on typing.
    public static func text(for picks: [PromptPick]) -> String {
        guard !picks.isEmpty else { return "" }
        return picks.map { "\($0.kind.rawValue) \($0.short)" }.joined(separator: ", ") + " "
    }

    /// Where picks go: the session the panel belongs to, else the project's session shown last,
    /// else its first. Nil means the project has none, so a new one starts.
    public static func target(from session: String?, lastShown: String?, open: [String]) -> String? {
        if let session, open.contains(session) { return session }
        if let lastShown, open.contains(lastShown) { return lastShown }
        return open.first
    }
}
