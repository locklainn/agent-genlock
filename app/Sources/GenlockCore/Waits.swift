import Foundation

/// What a session is blocked on that is not the agent thinking: a long command, a background task
/// still running after its turn ended, or a wait a script declared with `genlock wait` (a test
/// queue, a lock). Written by genlock's session-state hook into the session's channel folder
/// (lib/waits.mjs); the app shows it so a quiet session is not mistaken for a stuck one.
public struct SessionWait: Equatable {
    /// Where the wait came from: a long command, a script's declaration, a job left running.
    public enum Kind: String, Equatable { case tool, queued, running, background }

    /// What is happening, the thing the app colors by. Testing and running are work being done;
    /// queued and waiting are nothing being done until something else moves.
    public enum State: String, Equatable, CaseIterable {
        case testing, running, queued, waiting
        public var isWork: Bool { self == .testing || self == .running }
    }

    public var label: String
    public var kind: Kind
    public var state: State = .running
    /// Milliseconds since 1970, as the hook writes them.
    public var since: Double
    /// Other background tasks also still running.
    public var more: Int = 0

    /// A foreground command counts as a wait only once it has run this long. Shorter is just work.
    public static let toolThreshold: Double = 10_000

    /// "testing the town" as the agent said it; "Running: Run the slow tests" for a command.
    public var headline: String {
        let tail = more > 0 ? " +\(more)" : ""
        switch kind {
        case .queued, .running: return label
        case .background: return "Background: \(label)\(tail)"
        case .tool: return "Running: \(label)"
        }
    }

    /// One word for what it waits on, for beside an hourglass with no room for the label:
    /// "testing", "building". The first keyword found in the label wins; otherwise the kind.
    /// Only testing ever says "testing": the word and the color come from the same state.
    public var gist: String {
        if state != .running { return state.rawValue }
        let word = SessionWait.keyword(label)
        if let word, word != "testing" { return word }
        return kind == .background ? "background" : "running"
    }

    /// The first keyword found in a label, if any: "testing", "building".
    static func keyword(_ label: String) -> String? {
        let words = label.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
        return gists.first { keys, _ in words.contains { w in keys.contains { w.hasPrefix($0) } } }?.1
    }

    static let gists: [([String], String)] = [
        (["test", "pytest", "jest", "vitest", "xctest"], "testing"),
        (["build", "compil", "bundl", "xcodebuild", "make"], "building"),
        (["lint", "typecheck", "tsc"], "checking"),
        (["install", "npm", "pip", "brew"], "installing"),
        (["deploy", "publish", "ship", "release"], "deploying"),
        (["push", "upload"], "pushing"),
        (["pull", "clone", "fetch", "download", "curl", "wget"], "fetching"),
        (["render", "export", "encod", "transcod", "ffmpeg"], "rendering"),
        (["sleep", "wait", "poll", "watch"], "waiting"),
        (["search", "grep", "find", "index", "scan"], "searching"),
    ]

    public func elapsed(now: Date = Date()) -> String {
        SessionWait.duration(max(0, now.timeIntervalSince1970 * 1000 - since) / 1000)
    }

    public static func duration(_ seconds: Double) -> String {
        let s = Int(seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m\(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h\(String(format: "%02d", (s % 3600) / 60))m"
    }

    /// A command nobody declared: testing if its label says so, else running.
    static func guess(_ label: String) -> State {
        keyword(label) == "testing" ? .testing : .running
    }

    struct Entry: Decodable { var label: String; var since: Double; var kind: String?; var id: String?; var explicit: Bool? = nil }

    /// Which wait to show. A declared one is the most specific, so it wins; a foreground command
    /// shows only past the threshold; background tasks only once the agent has stopped working.
    static func pick(phase: String?, tool: Entry?, background: [Entry], declared: [Entry], nowMs: Double) -> SessionWait? {
        if let d = declared.max(by: { $0.since < $1.since }) {
            // `kind` is the state the script declared; the oldest files wrote queued or running.
            // A state the script chose stands. One it left to the default is guessed like any
            // command, so "truck_net4 (test queue)" reads as testing, not as running.
            // Only "running" was ever written as a default; any other state was chosen.
            let chosen = d.explicit == true || (d.kind ?? "running") != "running" ? State(rawValue: d.kind ?? "") : nil
            let state = chosen ?? guess(d.label)
            return SessionWait(label: d.label, kind: state == .queued ? .queued : .running, state: state, since: d.since)
        }
        if phase == "working", let t = tool, nowMs - t.since >= toolThreshold {
            return SessionWait(label: t.label, kind: .tool, state: guess(t.label), since: t.since)
        }
        if phase != "working", let b = background.max(by: { $0.since < $1.since }) {
            return SessionWait(label: b.label, kind: .background, state: guess(b.label), since: b.since, more: background.count - 1)
        }
        return nil
    }

    /// Reads the wait files in a session's channel folder.
    public static func read(folder: URL, phase: String?, now: Date = Date()) -> SessionWait? {
        let fm = FileManager.default
        func entry(_ name: String) -> Entry? {
            (try? Data(contentsOf: folder.appendingPathComponent(name))).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
        }
        let names = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
        let declared = names.filter { $0.hasPrefix("wait-decl-") && $0.hasSuffix(".json") }.compactMap(entry)
        let background = (try? Data(contentsOf: folder.appendingPathComponent("wait-bg.json")))
            .flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
        return pick(phase: phase, tool: entry("wait-tool.json"), background: background, declared: declared,
                    nowMs: now.timeIntervalSince1970 * 1000)
    }
}

extension VoiceChannel {
    public func readWait(phase: String?, now: Date = Date()) -> SessionWait? {
        SessionWait.read(folder: folder, phase: phase, now: now)
    }
}
