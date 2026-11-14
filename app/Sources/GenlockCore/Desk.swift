import Foundation

// The desk: the Mac app's Phone window. It is a second client of the phone bridge
// (mobile/bridge/desk.mjs), so it gets the same replies, cut into the same items, and sends answers
// in the same form. The walk rules are a port of the phone's WalkPlan
// (mobile/android/.../WalkPlan.kt); keep the two in step.

/// One thing to hear in a walk-through: what Tally said about one project's task.
public struct DeskItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var project: String
    public var task: String
    public var kind: String
    public var say: String
    public var ask: String?
    public var options: [String]
    /// It came in about something already heard in this walk, so it is read at the very end.
    public var late: Bool
    /// What TJ said that this replies to, and when the reply came (ms, laptop clock).
    public var re: String?
    public var at: Int64

    public init(id: String, project: String = "", task: String = "", kind: String = "update", say: String,
                ask: String? = nil, options: [String] = [], late: Bool = false, re: String? = nil, at: Int64 = 0) {
        self.id = id; self.project = project; self.task = task; self.kind = kind; self.say = say
        self.ask = ask; self.options = options; self.late = late; self.re = re; self.at = at
    }

    public var isQuestion: Bool { kind == "question" || ask != nil }
    /// Same project and task means the same subject; an item with neither is only itself.
    public var key: String {
        project.trimmingCharacters(in: .whitespaces).isEmpty && task.trimmingCharacters(in: .whitespaces).isEmpty
            ? "id:\(id)" : "\(project.trimmingCharacters(in: .whitespaces).lowercased())/\(task.trimmingCharacters(in: .whitespaces).lowercased())"
    }
    public var label: String { [project, task].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: " / ") }

    /// What is read aloud. A link is never read out: it is on the screen to click.
    public var spoken: String {
        var parts: [String] = []
        if late { parts.append("Came in while we talked.") }
        let names = [project, task].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if !names.isEmpty { parts.append(names.joined(separator: ", ") + ".") }
        parts.append(DeskWalk.unlinked(say))
        if let ask { parts.append(DeskWalk.unlinked(ask)) }
        return parts.joined(separator: " ")
    }
}

/// TJ's answer to one item: what he said, or that he skipped it.
public struct DeskAnswer: Equatable, Sendable {
    public var item: DeskItem
    public var answer: String?
    public var skipped: Bool
    public init(item: DeskItem, answer: String? = nil, skipped: Bool = false) { self.item = item; self.answer = answer; self.skipped = skipped }
}

public struct DeskLinkRef: Equatable, Sendable, Identifiable {
    public var label: String
    public var url: String
    public var id: String { url }
}

public enum DeskWalk {
    private static let numbers = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                                  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]
    private static func count(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n < numbers.count ? numbers[n] : String(n)) \(n == 1 ? one : many)"
    }

    /// "Three updates, one question." Plain items count as updates.
    public static func arrivalLine(items: Int, questions: Int) -> String {
        let updates = items - questions
        var parts: [String] = []
        if updates > 0 { parts.append(count(updates, "update", "updates")) }
        if questions > 0 { parts.append(count(questions, "question", "questions")) }
        let line = parts.isEmpty ? "nothing new" : parts.joined(separator: ", ")
        return line.prefix(1).uppercased() + line.dropFirst() + "."
    }

    /// A reply's items in the order to walk them: one project at a time, in the order they first
    /// appear, with that project's questions ahead of its plain updates.
    public static func order(_ items: [DeskItem]) -> [DeskItem] {
        var projects: [String] = []
        for i in items where !projects.contains(i.project.lowercased()) { projects.append(i.project.lowercased()) }
        return projects.flatMap { p in
            let group = items.filter { $0.project.lowercased() == p }
            return group.filter(\.isQuestion) + group.filter { !$0.isQuestion }
        }
    }

    /// Merges newly arrived items into the queue still ahead, without interrupting anything:
    /// 1. same task as an item still ahead: it replaces that item, in its place;
    /// 2. about something already heard in this walk: to the very end, marked late;
    /// 3. same project as items still ahead: joins that group (questions before updates);
    /// 4. otherwise: at the end, ahead of any late items.
    public static func merge(_ ahead: [DeskItem], _ incoming: [DeskItem], heard: Set<String>) -> [DeskItem] {
        var q = ahead
        for var i in order(incoming) {
            if let same = q.firstIndex(where: { $0.key == i.key }) { i.late = q[same].late; q[same] = i; continue }
            if heard.contains(i.key) { i.late = true; q.append(i); continue }
            let firstLate = q.firstIndex(where: \.late) ?? q.count
            let group = (0..<firstLate).filter { !i.project.isEmpty && q[$0].project.caseInsensitiveCompare(i.project) == .orderedSame }
            let at: Int
            if group.isEmpty { at = firstLate }
            else if i.isQuestion { at = group.last(where: { q[$0].isQuestion }).map { $0 + 1 } ?? group[0] }
            else { at = group[group.count - 1] + 1 }
            q.insert(i, at: at)
        }
        return q
    }

    /// The items still worth hearing once TJ has moved on elsewhere at `mark` (ms): only those that
    /// came in at or after it. The one being heard now (`keepHead`) is not cut off.
    public static func current(_ items: [DeskItem], mark: Int64, keepHead: Bool) -> [DeskItem] {
        guard mark > 0 else { return items }
        return items.enumerated().filter { (keepHead && $0.offset == 0) || $0.element.at >= mark }.map(\.element)
    }

    private static let markdownLink = try! NSRegularExpression(pattern: #"\[([^\]]+)\]\((https?://[^\s)]+)\)"#)
    private static let bareURL = try! NSRegularExpression(pattern: #"https?://[^\s<>()\[\]"'`]+"#)

    private static func clean(_ u: String) -> String {
        var s = Substring(u)
        while let c = s.last, ".,;:!?*_".contains(c) { s = s.dropLast() }
        return String(s)
    }

    private static func replace(_ re: NSRegularExpression, in text: String, with f: (NSTextCheckingResult, NSString) -> String) -> String {
        let ns = text as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += f(m, ns)
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// Every link in `text`, once each: markdown links keep their label, bare ones are named by host.
    public static func links(in text: String) -> [DeskLinkRef] {
        var out: [DeskLinkRef] = []
        let ns = text as NSString
        for m in markdownLink.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let url = clean(ns.substring(with: m.range(at: 2)))
            if !out.contains(where: { $0.url == url }) { out.append(DeskLinkRef(label: ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces), url: url)) }
        }
        let rest = replace(markdownLink, in: text) { _, _ in " " }
        let rns = rest as NSString
        for m in bareURL.matches(in: rest, range: NSRange(location: 0, length: rns.length)) {
            let url = clean(rns.substring(with: m.range))
            var host = url.components(separatedBy: "://").last?.components(separatedBy: "/").first ?? url
            if host.hasPrefix("www.") { host.removeFirst(4) }
            if !out.contains(where: { $0.url == url }) { out.append(DeskLinkRef(label: host.isEmpty ? url : host, url: url)) }
        }
        return out
    }

    /// The links to show on `item`: those in its own words, then those in the written `reply` it came
    /// from. A reply's link goes to the item whose task (or project) its paragraph names; a link whose
    /// paragraph names none of the reply's items shows on all of them, so none is unreachable.
    public static func links(for item: DeskItem, reply: String?, siblings: [DeskItem]) -> [DeskLinkRef] {
        var out = links(in: [item.say, item.ask].compactMap { $0 }.joined(separator: "\n"))
        guard let reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return out }
        func names(_ i: DeskItem, _ para: String) -> Bool {
            let name = (i.task.isEmpty ? i.project : i.task).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return false }
            let pattern = #"(?<![\p{L}\d])"# + NSRegularExpression.escapedPattern(for: name) + #"(?![\p{L}\d])"#
            return para.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
        let paragraphs = reply.replacingOccurrences(of: #"\n[ \t]*\n\s*"#, with: "\u{1}", options: .regularExpression).components(separatedBy: "\u{1}")
        for para in paragraphs {
            let found = links(in: para)
            guard !found.isEmpty else { continue }
            let named = siblings.filter { names($0, para) }
            if named.isEmpty || named.contains(where: { $0.id == item.id }) {
                for l in found where !out.contains(where: { $0.url == l.url }) { out.append(l) }
            }
        }
        return out
    }

    /// `text` with its links taken out for speech: a markdown link leaves its label, a bare URL nothing.
    public static func unlinked(_ text: String) -> String {
        var s = replace(markdownLink, in: text) { m, ns in ns.substring(with: m.range(at: 1)) }
        s = replace(bareURL, in: s) { m, ns in let v = ns.substring(with: m.range); return String(v.dropFirst(clean(v).count)) }
        s = s.replacingOccurrences(of: #"\(\s*\)|:\s*(?=[.,;]|$)"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+([.,;:!?])"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// The `say` message for a walk's answers, as the phone sends it: one batch, one Tally turn.
    /// Nil when nothing was actually answered (hearing items needs no reply).
    public static func answersMessage(_ batch: [DeskAnswer], left: Int) -> [String: Any]? {
        guard batch.contains(where: { $0.answer != nil }) else { return nil }
        let arr: [[String: Any]] = batch.map { a in
            var o: [String: Any] = ["item": a.item.id, "project": a.item.project, "task": a.item.task]
            if let ask = a.item.ask { o["ask"] = ask }
            if let ans = a.answer { o["answer"] = ans }
            if a.skipped { o["skipped"] = true }
            return o
        }
        let summary = batch.map { "\($0.item.label.isEmpty ? "Reply" : $0.item.label): \($0.answer ?? "skipped")" }.joined(separator: "\n")
        return ["kind": "say", "text": summary, "answers": arr, "left": left]
    }

    /// The items of a `reply` message; a reply without any is one item of its whole text.
    public static func items(fromReply m: [String: Any], at: Int64, re: String?) -> [DeskItem] {
        let turn = (m["turn"] as? String) ?? (m["id"] as? String) ?? UUID().uuidString
        let raw = (m["items"] as? [[String: Any]]) ?? []
        var items: [DeskItem] = raw.compactMap { o in
            guard let say = o["say"] as? String, !say.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            return DeskItem(id: (o["id"] as? String) ?? UUID().uuidString, project: (o["project"] as? String) ?? "",
                            task: (o["task"] as? String) ?? "", kind: (o["kind"] as? String) ?? "update", say: say,
                            ask: (o["ask"] as? String).flatMap { $0.isEmpty ? nil : $0 }, options: (o["options"] as? [String]) ?? [],
                            re: re, at: at)
        }
        if items.isEmpty {
            let text = ((m["text"] as? String) ?? "").replacingOccurrences(of: #"[*`#_]"#, with: "", options: .regularExpression)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { items = [DeskItem(id: "\(turn)-0", say: text, re: re, at: at)] }
        }
        return items
    }
}

/// Where the bridge's desk listener is: written by mobile/bridge/desk.mjs.
public struct DeskEndpoint: Codable, Equatable, Sendable {
    public var port: Int
    public var token: String
    public var pid: Int32?

    public static func file(home: URL? = nil) -> URL {
        // A driven test points the window at its own bridge.
        if home == nil, let f = ProcessInfo.processInfo.environment["GENLOCK_DESK_FILE"] { return URL(fileURLWithPath: f) }
        let base = home ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Genlock")
        return base.appendingPathComponent("phone/desk.json")
    }

    public static func read(home: URL? = nil) -> DeskEndpoint? {
        guard let data = try? Data(contentsOf: file(home: home)) else { return nil }
        return try? JSONDecoder().decode(DeskEndpoint.self, from: data)
    }
}

/// The connection to the bridge's desk listener: a server-sent event stream in, POSTs out.
/// Reconnects by itself, re-reading desk.json each time (the bridge picks a new port and token when
/// it restarts). Callbacks arrive on the main queue.
public final class DeskConnection: @unchecked Sendable {
    public enum State: Equatable, Sendable { case connecting, connected, noBridge }

    private let home: URL?
    private let onMessage: @Sendable ([String: Any]) -> Void
    private let onState: @Sendable (State) -> Void
    private var task: Task<Void, Never>?
    private let lock = NSLock()
    private var endpoint: DeskEndpoint?
    private var lastSeen: Int64 = 0

    public init(home: URL? = nil, lastSeen: Int64 = 0, onMessage: @escaping @Sendable ([String: Any]) -> Void, onState: @escaping @Sendable (State) -> Void) {
        self.home = home; self.lastSeen = lastSeen; self.onMessage = onMessage; self.onState = onState
    }

    public func start() {
        guard task == nil else { return }
        task = Task.detached(priority: .userInitiated) { [weak self] in
            var wait: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                await self.state(.connecting)
                if let ep = DeskEndpoint.read(home: self.home), await self.run(ep) { wait = 1 }
                else { await self.state(.noBridge) }
                try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
                wait = min(wait * 2, 10)
            }
        }
    }

    public func stop() { task?.cancel(); task = nil }

    @MainActor private func deliver(_ m: [String: Any]) { onMessage(m) }
    @MainActor private func state(_ s: State) { onState(s) }

    /// Follows the stream until it ends. True when it got connected at all.
    private func run(_ ep: DeskEndpoint) async -> Bool {
        let since = lock.withLock { lastSeen }
        guard let url = URL(string: "http://127.0.0.1:\(ep.port)/events?token=\(ep.token)&lastSeen=\(since)") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3600
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            lock.withLock { endpoint = ep }
            await state(.connected)
            _ = try? await post(["kind": "hello", "lastSeen": since])
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                guard line.hasPrefix("data: "),
                      let m = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] else { continue }
                if let t = (m["t"] as? NSNumber)?.int64Value { lock.withLock { lastSeen = max(lastSeen, t) } }
                await deliver(m)
            }
            lock.withLock { endpoint = nil }
            return true
        } catch {
            lock.withLock { endpoint = nil }
            return false
        }
    }

    /// Sends one message to the bridge, as the phone would. Throws when the bridge is not there.
    @discardableResult
    public func post(_ msg: [String: Any]) async throws -> String {
        guard let ep = lock.withLock({ endpoint }) ?? DeskEndpoint.read(home: home),
              let url = URL(string: "http://127.0.0.1:\(ep.port)/send") else { throw URLError(.cannotConnectToHost) }
        var m = msg
        if m["id"] == nil { m["id"] = UUID().uuidString }
        m["t"] = Int64(Date().timeIntervalSince1970 * 1000)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: m)
        req.timeoutInterval = 10
        let (_, response) = try await URLSession.shared.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        return m["id"] as! String
    }
}
