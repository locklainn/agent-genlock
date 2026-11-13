import Foundation

/// One message TJ sent from the phone, and the Assistant's reply to it if one has come.
public struct PhoneExchange: Equatable, Identifiable, Sendable {
    public let id: String
    public let at: Date
    public let said: String
    public var reply: String?
    public var repliedAt: Date?
}

/// Everything said from the phone and answered, across every one of the Assistant's
/// conversations. A status update starts the Assistant fresh, so the pane on the Mac shows only
/// the newest conversation; this reads them all, which is the whole phone thread.
///
/// The rules mirror the phone bridge's TranscriptFollower (mobile/bridge/lib.mjs): a prompt
/// starting `[phone]` is the phone's, a queued command counts as a prompt, and a turn's reply is
/// the text of the message that ends it, answering whichever prompt came last.
public enum PhoneThread {
    public static let prefix = "[phone]"

    /// Where Claude Code keeps a folder's transcripts: the path with every other character a dash.
    public static func transcriptFolder(for folder: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        let mangled = String(folder.map { $0.isLetter || $0.isNumber ? $0 : "-" })
        return home.appendingPathComponent(".claude/projects").appendingPathComponent(mangled)
    }

    /// Every exchange in every transcript in `folder`, oldest first.
    public static func load(folder: URL) -> [PhoneExchange] { Reader(folder: folder).read() }

    /// Reads the folder again and again, parsing only transcripts that changed since last time:
    /// a conversation that has ended is read once. `since` skips files not written after it.
    public final class Reader: @unchecked Sendable {
        public let folder: URL
        private var parsed: [String: (stamp: Date, size: Int, exchanges: [PhoneExchange])] = [:]
        private let lock = NSLock()

        public init(folder: URL) { self.folder = folder }

        public func read(since: Date = .distantPast) -> [PhoneExchange] {
            lock.lock(); defer { lock.unlock() }
            let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
            var out: [PhoneExchange] = []
            var seen = Set<String>()
            for file in files where file.pathExtension == "jsonl" {
                let values = try? file.resourceValues(forKeys: Set(keys))
                let stamp = values?.contentModificationDate ?? .distantPast
                let size = values?.fileSize ?? 0
                guard stamp > since else { continue }
                seen.insert(file.path)
                if let hit = parsed[file.path], hit.stamp == stamp, hit.size == size { out += hit.exchanges; continue }
                let exchanges = (try? String(contentsOf: file, encoding: .utf8)).map(PhoneThread.parse) ?? []
                parsed[file.path] = (stamp, size, exchanges)
                out += exchanges
            }
            parsed = parsed.filter { seen.contains($0.key) }
            return out.filter { $0.at > since }.sorted { $0.at < $1.at }
        }
    }

    /// The phone's exchanges in one transcript.
    public static func parse(_ transcript: String) -> [PhoneExchange] {
        var out: [PhoneExchange] = []
        var lastWasPhone = false
        var texts: [String: [String]] = [:]
        for line in transcript.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let e = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if e["isSidechain"] as? Bool == true { continue }
            let type = e["type"] as? String
            let message = e["message"] as? [String: Any]
            var prompt: String?
            if type == "user", e["isMeta"] as? Bool != true, let content = message?["content"] as? String { prompt = content }
            if type == "attachment", let a = e["attachment"] as? [String: Any], a["type"] as? String == "queued_command" {
                prompt = a["prompt"] as? String
            }
            if let prompt {
                guard let source = source(prompt) else { continue }
                lastWasPhone = source == .phone
                if lastWasPhone {
                    out.append(PhoneExchange(id: e["uuid"] as? String ?? UUID().uuidString, at: date(e["timestamp"]),
                                             said: shown(prompt), reply: nil, repliedAt: nil))
                }
                continue
            }
            guard type == "assistant", let message, let content = message["content"] as? [[String: Any]] else { continue }
            let id = message["id"] as? String ?? e["uuid"] as? String ?? ""
            var got = texts[id] ?? []
            for c in content where c["type"] as? String == "text" {
                if let t = (c["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { got.append(t) }
            }
            texts[id] = got
            if message["stop_reason"] as? String == "end_turn" {
                texts[id] = nil
                if lastWasPhone, !got.isEmpty, let last = out.indices.last, out[last].reply == nil {
                    out[last].reply = withoutItems(got.joined(separator: "\n\n"))
                    out[last].repliedAt = date(e["timestamp"])
                }
            }
        }
        return out
    }

    /// The reply as the phone shows it: without the fenced ```items block Tally ends a phone reply
    /// with for the walk-through (mobile/bridge/items.mjs cuts the same block).
    static func withoutItems(_ text: String) -> String {
        guard let r = text.range(of: #"```items[^\n]*\n[\s\S]*?```\s*$"#, options: .regularExpression) else { return text }
        let cut = text[..<r.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        return cut.isEmpty ? text : cut
    }

    enum Source { case phone, other }

    /// Who wrote a prompt: the phone, someone else, or nobody (system text: notifications, command
    /// output, a compaction summary). A long message is wrapped in <pasted_content>.
    static func source(_ raw: String) -> Source? {
        let t = unwrapped(raw)
        if t.isEmpty { return nil }
        if t.hasPrefix(prefix) { return .phone }
        if t.hasPrefix("<") || t.hasPrefix("This session is being continued from a previous conversation") { return nil }
        return .other
    }

    private static func unwrapped(_ raw: String) -> String {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("<pasted_content"), let open = t.firstIndex(of: ">") {
            t = String(t[t.index(after: open)...])
            if let close = t.range(of: "</pasted_content>", options: .backwards) { t = String(t[..<close.lowerBound]) }
            t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return t
    }

    /// The prompt as TJ said it: without the [phone] and [voice] tags.
    static func shown(_ raw: String) -> String {
        var t = unwrapped(raw)
        for tag in [prefix, "[voice]"] where t.hasPrefix(tag) {
            t = String(t.dropFirst(tag.count)).trimmingCharacters(in: .whitespaces)
        }
        return t
    }

    private static func date(_ any: Any?) -> Date {
        guard let s = any as? String else { return .distantPast }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s) ?? .distantPast
    }
}
