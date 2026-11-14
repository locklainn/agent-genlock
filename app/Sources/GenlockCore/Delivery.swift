import Foundation

/// Whether a message the app typed into a session reached it whole. Typed as plain keystrokes, a
/// message over about 1 KB reached Claude Code in pieces and sometimes only its last piece
/// survived; typed as a paste it arrives whole. This checks the session's own transcript, which is
/// the only place that says what the agent actually received.
public enum Delivery {
    /// Seconds to wait before a message that has not shown up counts as lost. The session may be
    /// slow to start its turn, and a busy one only takes a typed message when its turn ends.
    public static let graceSeconds: TimeInterval = 20
    /// Typed this many times in all before the sender is told it did not arrive.
    public static let tries = 2
    /// How much of the end of a transcript to search: the prompt that started the current turn,
    /// even after a long turn of tool output.
    public static let tailBytes = 4 << 20

    /// The text compared without whitespace or Claude Code's paste wrapper: a long paste is wrapped
    /// in <pasted_content> and may be split into several, and neither changes what was said.
    public static func squeezed(_ s: String) -> String {
        let unwrapped = s.replacingOccurrences(of: #"</?pasted_content[^>]*>"#, with: "", options: .regularExpression)
        return String(unwrapped.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.map(Character.init))
    }

    /// Everything the user side of the conversation said, in these transcript lines. A message typed
    /// while the session was busy reaches it mid-turn as a queued_command attachment, not a user
    /// line: it arrived all the same, and typing it again makes the agent answer it twice.
    public static func prompts(inTranscript tail: String) -> [String] {
        tail.split(separator: "\n").compactMap { line -> String? in
            if line.contains("\"queued_command\""), let data = line.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let a = obj["attachment"] as? [String: Any], a["type"] as? String == "queued_command" {
                if let text = a["prompt"] as? String { return text }
                let parts = (a["prompt"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
                return parts.isEmpty ? nil : parts.joined(separator: "\n")
            }
            guard line.contains("\"user\""), let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["type"] as? String == "user", let message = obj["message"] as? [String: Any] else { return nil }
            if let text = message["content"] as? String { return text }
            let parts = (message["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }
    }

    /// Whether `text` arrived whole in one prompt of this transcript.
    public static func arrived(_ text: String, inTranscript tail: String) -> Bool {
        let want = squeezed(text)
        guard !want.isEmpty else { return true }
        return prompts(inTranscript: tail).contains { squeezed($0).contains(want) }
    }

    /// The last `tailBytes` of a transcript, or nil if it cannot be read.
    public static func tail(of url: URL, bytes: Int = tailBytes) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > UInt64(bytes) ? size - UInt64(bytes) : 0)
        guard let data = try? handle.readToEnd() else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    /// One message typed into a session and not yet seen in its transcript.
    public struct Pending: Equatable {
        public var text: String
        public var at: Date
        public var tries: Int
        public init(text: String, at: Date, tries: Int = 1) { self.text = text; self.at = at; self.tries = tries }
    }

    public enum Verdict: Equatable { case arrived, wait, retype, lost }

    /// What to do about one pending message. A session that is working or stuck on a prompt may
    /// still take it when its turn ends, so it is only typed again once the session is idle.
    public static func verdict(_ p: Pending, arrived: Bool, phase: String?, now: Date) -> Verdict {
        if arrived { return .arrived }
        // Half an hour on: whatever the session is doing, the sender should know.
        if now.timeIntervalSince(p.at) > 1800 { return .lost }
        if now.timeIntervalSince(p.at) < graceSeconds || phase == "working" || phase == "waiting" { return .wait }
        return p.tries < tries ? .retype : .lost
    }
}
