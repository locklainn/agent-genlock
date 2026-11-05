import Foundation

/// Press to start, press again to send.
public struct VoiceMachine: Equatable {
    public enum State: Equatable { case idle, listening, sending }
    public enum Action: Equatable { case startListening, finishListening, none }

    public private(set) var state: State = .idle
    public init() {}

    public mutating func press() -> Action {
        switch state {
        case .idle: state = .listening; return .startListening
        case .listening: state = .sending; return .finishListening
        case .sending: return .none
        }
    }

    public mutating func reset() { state = .idle }

    /// What to tell the user when recognition fails. Nil for what is normal: stopping with nothing said.
    public static func explain(recognitionError text: String) -> (message: String, needsDictationSetting: Bool)? {
        let lower = text.lowercased()
        if lower.contains("siri and dictation are disabled") || lower.contains("dictation is disabled") {
            return ("Dictation is turned off on this Mac. Turn it on in System Settings, Keyboard, Dictation, then press Talk again.", true)
        }
        if lower.contains("no speech") || lower.contains("code=1110") || lower.contains("canceled") || lower.contains("cancelled") {
            return nil
        }
        return ("Speech recognition stopped: \(text)", false)
    }

    /// What to type into the terminal, or nil if nothing was said.
    public static func message(from transcript: String) -> String? {
        let t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : "[voice] \(t.replacingOccurrences(of: "\n", with: " "))"
    }
}

/// How a session is started. All of voice is passed here, so a project needs no setup for it.
public enum SessionLaunch {
    public static let voiceRule = """
    Messages that begin with [voice] were dictated, and the user is listening rather than reading.
    The words came from speech recognition, so read them charitably: names and code terms may be misheard.

    Reply in writing as usual. Then, before ending your turn, run this once:
        genlock say "the spoken version"

    The spoken version carries only the important details, in one to three plain sentences. No file paths, code, lists or status labels, because they are unpleasant to hear. Say what happened or what you need from them. If there is more worth knowing, end by asking whether to go into more depth, and only go deeper when they say so.

    Say it warmly and directly, the way a sharp colleague would. Keep it natural and conversational, and never let the tone blur what is true or what you need from them. This is for the spoken version only; your written reply stays as usual.

    Messages without [voice] were typed. Do not run genlock say for those.
    """

    public static let spinoffRule = """
    You are running inside the Genlock app, beside the user's other sessions.

    Before finishing each response, ask whether a rabbit hole came up: real work that could run in isolation from what you are doing, more than a quick fix. Starting it here would bloat this conversation and burn tokens, so offer to move it instead. Most responses have none, so do not manufacture one.

    To move one, in this order:
    1. genlock claim YOUR_TICKET --path WHAT_YOU_ARE_TOUCHING
    2. genlock spinoff propose "THE OUTCOME" --parent YOUR_TICKET --why ".." --context "EVERYTHING THE NEW AGENT NEEDS, because it starts with none of this conversation" --path WHAT_IT_WILL_TOUCH --needs none --blocks none
    3. Follow the verdict. If SAFE, offer it in one line: "I can kick off a spinoff so you can work from there: THE OUTCOME." Then wait.
    4. Only on the user's yes: genlock spinoff launch ID --user-said "THEIR WORDS". It opens in a new pane beside you. Carry on with your own work.

    If NOT SAFE, do not offer a launch. Say the ticket is recorded and why it has to wait.
    """

    /// `prompt` opens a spin-off with its handoff. Flags come after it, because --allowedTools
    /// would otherwise swallow it as another tool name.
    public static func arguments(resume: Bool, voice: Bool, genlockCommand: String?, spinoffs: Bool = false,
                                 reportsState: Bool = false, sessionID: String? = nil, prompt: String? = nil) -> [String] {
        var args: [String] = []
        if let prompt { args.append(prompt) }
        if resume { args.append("--continue") }
        if let sessionID { args += ["--session-id", sessionID] }
        guard let genlockCommand else { return args }
        var rules: [String] = []
        if voice || reportsState { args += ["--settings", sessionSettings(genlockCommand: genlockCommand)] }
        if voice { rules.append(voiceRule) }
        if spinoffs {
            rules.append(spinoffRule)
        }
        if !rules.isEmpty { args += ["--append-system-prompt", rules.joined(separator: "\n\n")] }
        // genlock only records and coordinates, and a prompt mid-handoff would break the flow.
        if !rules.isEmpty { args += ["--allowedTools", "Bash(genlock:*)"] }
        return args
    }

    /// Reports what the session is doing, and sends a silent dictated turn back once.
    public static func sessionSettings(genlockCommand: String) -> String {
        let hook: [[String: Any]] = [["hooks": [["type": "command", "command": "\(genlockCommand) session-state"]]]]
        let settings: [String: Any] = ["hooks": ["Stop": hook, "Notification": hook, "UserPromptSubmit": hook, "PostToolUse": hook]]
        let data = try! JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}

/// What a session told the app about itself, through Claude Code's own hooks.
public struct SessionReport: Decodable, Equatable {
    public var state: String
    public var message: String
    public var at: Double
}

/// Whether a session needs you. It stops needing you once you have seen it or it has resumed.
public enum Attention: String, Equatable {
    case done, waiting

    public var headline: String { self == .waiting ? "needs you" : "is done" }

    /// `current` is what is outstanding; `looking` is whether you can see this session now.
    public static func next(current: Attention?, report: SessionReport, isNew: Bool, looking: Bool) -> (attention: Attention?, notify: Bool) {
        if looking { return (nil, false) }
        guard isNew else { return (current, false) }
        switch report.state {
        case "done": return (.done, true)
        case "waiting": return (.waiting, true)
        default: return (nil, false)
        }
    }
}

/// An agent asking for a spin-off to open as a pane. Its safety check and the user's yes have
/// already happened in `genlock spinoff launch`, which also took the claim.
public struct SpawnRequest: Decodable, Equatable {
    public var ticket: String
    public var session: String
    public var title: String
    public var project: String
    public var prompt: String
}

/// The folder a session's spoken replies arrive in. Outside the repository, so voice writes
/// nothing to a project.
public struct VoiceChannel {
    public let folder: URL

    public init(session: String, base: URL = VoiceChannel.defaultBase) {
        folder = base.appendingPathComponent(session)
    }

    public static var defaultBase: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Genlock/voice")
    }

    public func prepare() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    public func markPending() {
        try? prepare()
        FileManager.default.createFile(atPath: folder.appendingPathComponent("pending").path, contents: Data())
    }

    public func clearPending() {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("pending"))
    }

    /// Everything waiting to be spoken, oldest first, removed as it is read.
    public func takeMessages() -> [String] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { return [] }
        var out: [String] = []
        for name in names.filter({ $0.hasPrefix("say-") && $0.hasSuffix(".json") }).sorted() {
            let url = folder.appendingPathComponent(name)
            defer { try? fm.removeItem(at: url) }
            if let data = try? Data(contentsOf: url),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = obj["text"] as? String, !text.isEmpty {
                out.append(text)
            }
        }
        return out
    }

    /// Spin-offs waiting to open, removed as they are read.
    public func takeSpawns() -> [SpawnRequest] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { return [] }
        var out: [SpawnRequest] = []
        for name in names.filter({ $0.hasPrefix("spawn-") && $0.hasSuffix(".json") }).sorted() {
            let url = folder.appendingPathComponent(name)
            defer { try? fm.removeItem(at: url) }
            if let data = try? Data(contentsOf: url), let req = try? JSONDecoder().decode(SpawnRequest.self, from: data) {
                out.append(req)
            }
        }
        return out
    }

    /// What the session last reported, or nil if it has said nothing yet.
    public func readState() -> SessionReport? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("state.json")) else { return nil }
        return try? JSONDecoder().decode(SessionReport.self, from: data)
    }

    public func remove() { try? FileManager.default.removeItem(at: folder) }

    /// With several sessions open, a reply has to say whose it is.
    public static func spoken(_ text: String, project: String, sessionsOpen: Int) -> String {
        sessionsOpen > 1 ? "\(project). \(text)" : text
    }
}


/// Which voice reads replies: Ava, in the best quality this Mac has, so a better download
/// is picked up on its own.
public struct VoiceOption: Equatable {
    public var identifier: String
    public var name: String
    public var language: String
    public var isMale: Bool
    /// 1 default, 2 enhanced, 3 premium.
    public var quality: Int

    public init(identifier: String, name: String, language: String, isMale: Bool, quality: Int) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.isMale = isMale
        self.quality = quality
    }

    public static let preferredName = "Ava"

    public static func preferred(from voices: [VoiceOption]) -> VoiceOption? {
        voices.filter { $0.name.hasPrefix(preferredName) }.max { $0.quality < $1.quality }
            ?? voices.filter { $0.language == "en-US" }.max { $0.quality < $1.quality }
    }

    /// Worth mentioning only when Ava is missing, or one download from sounding much better.
    public static func upgradeHint(for voice: VoiceOption?) -> String? {
        if let voice, voice.name.hasPrefix(preferredName), voice.quality >= 2 { return nil }
        return "For the best Ava, download \"Ava (Premium)\" in System Settings, Accessibility, Spoken Content, System Voice, Manage Voices. Genlock will use her automatically."
    }
}
