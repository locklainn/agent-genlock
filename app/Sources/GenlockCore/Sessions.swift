import Foundation

/// Which sessions were open and which conversation each one was in, so a restart picks up where
/// you left off. Kept beside your project list, on this Mac and never in a repository.
public struct SessionMemory: Codable, Equatable {
    /// Only a session that actually ended is closed. One that could not start yet, or could not be
    /// reached, may still be running, and forgetting it is how a running session gets lost.
    public static func stillOpen(isRunning: Bool, exitCode: Int32?) -> Bool { isRunning || exitCode == nil }

    public struct Open: Codable, Equatable {
        public var project: String
        public var spawn: SpawnRequest?
        /// Names its channel folder, and so the host still running it after a restart.
        public var token: String?
        /// Set for a second or later session in the same project, which has its own conversation.
        public var slot: String?
        /// For a session you ended: its conversation, so reopening it is that conversation and
        /// not whatever the project's main session has moved on to.
        public var conversation: String?

        public init(project: String, spawn: SpawnRequest? = nil, token: String? = nil, slot: String? = nil, conversation: String? = nil) {
            self.project = project
            self.spawn = spawn
            self.token = token
            self.slot = slot
            self.conversation = conversation
        }

        public var key: String { SessionMemory.key(project: project, ticket: spawn?.ticket, slot: slot) }
    }

    public var open: [Open] = []
    public var visible: [String] = []
    /// Session key to Claude Code's conversation id. Outlives the session, so a later click resumes it.
    public var conversations: [String: String] = [:]
    /// Closed from the tab bar but still running. Optional, so a file written before it existed still loads.
    public var tucked: [String]? = nil
    /// Sessions you ended lately, newest first, so one ended by accident can be reopened.
    public var ended: [Open]? = nil

    public init() {}

    public static let endedKept = 5

    /// A project's main session is keyed by its folder, a spin-off by its task, and any other
    /// session by a slot of its own.
    public static func key(project: String, ticket: String?, slot: String?) -> String {
        if let ticket { return "\(project)#\(ticket)" }
        if let slot { return "\(project)#+\(slot)" }
        return project
    }

    /// Puts a session at the front of the recently ended list, once, keeping the newest few.
    public static func noteEnded(_ open: Open, in list: [Open]) -> [Open] {
        Array(([open] + list.filter { $0.key != open.key }).prefix(endedKept))
    }

    public static func file(beside store: URL) -> URL {
        store.deletingLastPathComponent().appendingPathComponent("sessions.json")
    }

    /// A missing or damaged file is the same as having nothing open.
    public static func load(from file: URL) -> SessionMemory {
        guard let data = try? Data(contentsOf: file),
              let memory = try? JSONDecoder().decode(SessionMemory.self, from: data) else { return SessionMemory() }
        return memory
    }

    public func save(to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: file, options: .atomic)
    }

    /// What to reopen: only what still has a folder, with the split as you left it. If none of
    /// the split survives, the first session reopened takes its place.
    public func restorable(projectExists: (String) -> Bool) -> (open: [Open], visible: [String]) {
        let open = open.filter { projectExists($0.project) }
        let keys = open.map(\.key)
        let shown = Array(visible.filter(keys.contains).prefix(SplitLayout.maxPanes))
        return (open, shown.isEmpty ? Array(keys.prefix(1)) : shown)
    }
}

/// Symlinks resolved by realpath, because Foundation's own resolving drops the /private that
/// Claude Code and git both keep. A path that does not exist comes back as given.
public func resolvedPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}

/// How a session's conversation begins.
public enum ConversationStart: Equatable {
    /// A new conversation under this id.
    case new(String)
    /// This exact conversation.
    case resume(String)
    /// The folder's most recent conversation, whose id is not known yet.
    case latest

    /// Claude Code refuses to pick up a folder whose only history is `claude -p` runs, and exits
    /// at once. Dying this fast means nothing was there to pick up, not that you ended it.
    public func failedToPickUp(exitCode: Int32?, after seconds: TimeInterval) -> Bool {
        if case .new = self { return false }
        return exitCode != 0 && seconds < 8
    }
}

/// What a conversation is about, for a dashboard card.
public struct SessionActivity: Equatable {
    public var title: String?
    public var prompt: String?
    public var at: Date?

    public init(title: String? = nil, prompt: String? = nil, at: Date? = nil) {
        self.title = title
        self.prompt = prompt
        self.at = at
    }
}

/// The conversations Claude Code has kept for one folder.
public struct Transcripts {
    public let folder: URL

    /// How much of a transcript's end to read. Claude Code keeps re-appending the title and last prompt.
    static let tailBytes = 2 << 20

    public init(project: String, claudeHome: URL) {
        let name = String(resolvedPath(project).map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        folder = claudeHome.appendingPathComponent("projects").appendingPathComponent(name)
    }

    public static func claudeHome(environment: [String: String]) -> URL {
        environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    private func file(_ id: String) -> URL { folder.appendingPathComponent("\(id).jsonl") }

    /// A session opened and never spoken to has no transcript, and asking to resume it would fail.
    public func has(_ id: String) -> Bool { FileManager.default.fileExists(atPath: file(id).path) }

    public var newest: URL? {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { $0.pathExtension == "jsonl" }.max { Self.modified($0) < Self.modified($1) }
    }

    private static func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    /// Picks up the remembered conversation, or else the folder's latest. A spin-off only ever
    /// has its own, and starts on its handoff until that exists.
    public func start(saved: String?, spawnSession: String?, newID: String) -> ConversationStart {
        if let spawnSession { return has(spawnSession) ? .resume(spawnSession) : .new(spawnSession) }
        if let saved, has(saved) { return .resume(saved) }
        return newest == nil ? .new(newID) : .latest
    }

    public func activity(conversation: String?) -> SessionActivity? {
        guard let url = conversation.map(file).flatMap({ has($0.deletingPathExtension().lastPathComponent) ? $0 : nil }) ?? newest,
              let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(Self.tailBytes) ? size - UInt64(Self.tailBytes) : 0
        guard (try? handle.seek(toOffset: start)) != nil, let data = try? handle.readToEnd() else { return nil }
        var activity = Self.activity(inTail: String(decoding: data, as: UTF8.self))
        activity.at = Self.modified(url)
        return activity.title == nil && activity.prompt == nil ? nil : activity
    }

    /// This format is Claude Code's own and undocumented, so anything unrecognised is skipped.
    static func activity(inTail text: String) -> SessionActivity {
        var out = SessionActivity()
        for line in text.split(separator: "\n") where line.contains("\"ai-title\"") || line.contains("\"last-prompt\"") {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if object["type"] as? String == "ai-title", let title = object["aiTitle"] as? String { out.title = title }
            if object["type"] as? String == "last-prompt", let prompt = object["lastPrompt"] as? String { out.prompt = tidy(prompt) }
        }
        return out
    }

    private static func tidy(_ prompt: String) -> String {
        var text = prompt.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if text.hasPrefix("[voice] ") { text.removeFirst("[voice] ".count) }
        return text
    }
}

/// A session asking, on the user's yes, to be replaced by a fresh one on a goal. Written by
/// `genlock swap` after it has checked that the records hold everything the fresh one needs.
public struct SwapRequest: Codable, Equatable {
    public var goal: String
    public var title: String
    public var prompt: String
    public var user_said: String?

    public init(goal: String, title: String, prompt: String, user_said: String? = nil) {
        self.goal = goal
        self.title = title
        self.prompt = prompt
        self.user_said = user_said
    }
}

/// How one session gives way to a fresh one in its place.
public enum SessionSwap {
    /// Only once its turn has ended and you have heard what it said, as with the Assistant.
    public static func ready(phase: String?, repliesWaiting: Int, dictating: Bool) -> Bool {
        SessionLaunch.assistantMayClear(phase: phase, repliesWaiting: repliesWaiting, dictating: dictating)
    }

    /// The fresh session's slot. A main session stays the main session; anything else becomes
    /// another session of its own, because a spin-off's id belongs to its ticket.
    public static func freshSlot(spawn: SpawnRequest?, slot: String?, newSlot: String) -> String? {
        spawn == nil && slot == nil ? nil : newSlot
    }

    /// What Recently ended keeps, so reopening it is the old conversation. A main session's key
    /// passes to the fresh one, so the old conversation is kept under a slot of its own.
    public static func ended(project: String, spawn: SpawnRequest?, slot: String?, conversation: String?, keptSlot: String) -> SessionMemory.Open {
        if spawn != nil || slot != nil { return SessionMemory.Open(project: project, spawn: spawn, slot: slot, conversation: conversation) }
        return SessionMemory.Open(project: project, slot: keptSlot, conversation: conversation)
    }
}

/// How many sessions an agent may have open in one project. genlock refuses an open at the cap
/// before asking; the app checks again when it opens one, so nothing that slipped past piles up.
/// A handoff replaces the session that asked, so it is always allowed, and the user's words
/// (genlock's --over-cap) lift the cap for one open. Your own ⌘N is not capped. The cap is the
/// only thing that stops an agent opening a session (TJ, 12 Nov 2026).
public enum SessionCap {
    public static let fallback = 12

    /// GENLOCK_SESSION_CAP, as genlock reads it, else 12 (TJ, 12 Nov 2026).
    public static func limit(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Int {
        Int(environment["GENLOCK_SESSION_CAP"] ?? "").flatMap { $0 > 0 ? $0 : nil } ?? fallback
    }

    public static func allows(open: Int, limit: Int, handoff: Bool, overCap: String? = nil) -> Bool {
        handoff || open < limit || !(overCap ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
