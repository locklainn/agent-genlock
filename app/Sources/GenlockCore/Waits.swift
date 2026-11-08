import Foundation

/// What a session is blocked on that is not the agent thinking: a long command, a background task
/// still running after its turn ended, or a wait a script declared with `genlock wait` (a test
/// queue, a lock). Written by genlock's session-state hook into the session's channel folder
/// (lib/waits.mjs); the app shows it so a quiet session is not mistaken for a stuck one.
public struct SessionWait: Equatable {
    public enum Kind: String, Equatable { case tool, queued, running, background }

    public var label: String
    public var kind: Kind
    /// Milliseconds since 1970, as the hook writes them.
    public var since: Double
    /// Other background tasks also still running.
    public var more: Int = 0

    /// A foreground command counts as a wait only once it has run this long. Shorter is just work.
    public static let toolThreshold: Double = 10_000

    /// "Queued: build queue", "Running: Run the slow tests".
    public var headline: String {
        let tail = more > 0 ? " +\(more)" : ""
        switch kind {
        case .queued: return "Queued: \(label)"
        case .background: return "Background: \(label)\(tail)"
        case .tool, .running: return "Running: \(label)"
        }
    }

    public func elapsed(now: Date = Date()) -> String {
        SessionWait.duration(max(0, now.timeIntervalSince1970 * 1000 - since) / 1000)
    }

    public static func duration(_ seconds: Double) -> String {
        let s = Int(seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m\(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h\(String(format: "%02d", (s % 3600) / 60))m"
    }

    struct Entry: Decodable { var label: String; var since: Double; var kind: String?; var id: String? }

    /// Which wait to show. A declared one is the most specific, so it wins; a foreground command
    /// shows only past the threshold; background tasks only once the agent has stopped working.
    static func pick(phase: String?, tool: Entry?, background: [Entry], declared: [Entry], nowMs: Double) -> SessionWait? {
        if let d = declared.max(by: { $0.since < $1.since }) {
            return SessionWait(label: d.label, kind: d.kind == "queued" ? .queued : .running, since: d.since)
        }
        if phase == "working", let t = tool, nowMs - t.since >= toolThreshold {
            return SessionWait(label: t.label, kind: .tool, since: t.since)
        }
        if phase != "working", let b = background.max(by: { $0.since < $1.since }) {
            return SessionWait(label: b.label, kind: .background, since: b.since, more: background.count - 1)
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
