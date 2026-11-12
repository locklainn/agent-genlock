import AppKit
import GenlockCore
import SwiftTerm

/// One running Claude Code. Owns its terminal view and process independently of what is on
/// screen, so moving between the dashboard and a split neither restarts nor redraws it.
@MainActor @Observable
final class TerminalSession: NSObject, LocalProcessTerminalViewDelegate {
    /// The project's folder for its main session, or folder#ticket for a spin-off.
    let key: String
    let projectID: String
    let spawn: SpawnRequest?
    /// Set when this is not the project's main session.
    let slot: String?
    let voiceToken: String
    let channel: VoiceChannel
    private(set) var isRunning = false
    private(set) var exitCode: Int32?
    private(set) var startError: String?
    var attention: Attention?
    /// What it last reported: working, done or waiting.
    var phase: String?
    var attentionMessage = ""
    /// What it is blocked on that is not the agent thinking (a long command, a queue, a background job).
    var wait: SessionWait?
    /// What the agent named this session with `genlock title`. Its tab shows it ahead of its task.
    var title: String?
    @ObservationIgnored var lastReportAt: Double = 0
    /// The conversation it is in, once known. Nil while continuing the folder's latest.
    var conversation: String?
    /// A cleared Assistant waits to be spoken to, rather than opening with a status report.
    @ObservationIgnored var startsQuietly = false
    /// Its first message, when it has been started in order to deal with something.
    @ObservationIgnored var openingMessage: String?
    /// What a cleared Assistant left itself.
    @ObservationIgnored var handoff: String?
    /// Called when picking up a conversation fails as it starts.
    @ObservationIgnored var onFailedPickUp: (() -> Void)?
    /// Its process ended on its own (/exit, a crash, an agent closing itself), not through the app.
    @ObservationIgnored var onExited: (() -> Void)?
    /// How long it had been running, if it was started.
    var ranFor: TimeInterval? { started.map { Date().timeIntervalSince($0.at) } }
    @ObservationIgnored private var started: (how: ConversationStart, at: Date)?
    @ObservationIgnored var cols = 0
    @ObservationIgnored var rows = 0
    @ObservationIgnored let view: PaneTerminalView

    /// What the Assistant is called, in place of its folder's name.
    var displayName: String?

    var label: String {
        let name = displayName ?? URL(fileURLWithPath: projectID).lastPathComponent
        return spawn != nil || slot != nil ? "\(name), another session" : name
    }

    static func key(project: String, ticket: String?) -> String {
        SessionMemory.key(project: project, ticket: ticket, slot: nil)
    }

    /// `token` finds a session's host again after a restart.
    init(projectID: String, spawn: SpawnRequest? = nil, slot: String? = nil, token: String? = nil) {
        self.projectID = projectID
        self.spawn = spawn
        voiceToken = token ?? UUID().uuidString
        self.slot = slot
        key = SessionMemory.key(project: projectID, ticket: spawn?.ticket, slot: slot)
        channel = VoiceChannel(session: voiceToken)
        view = PaneTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        super.init()
        view.processDelegate = self
        view.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.nativeBackgroundColor = Theme.terminal
        view.nativeForegroundColor = NSColor(white: 0.92, alpha: 1)
    }

    static let claudeMissing = "Claude Code was not found. Genlock keeps looking, and this session starts as soon as it is there."
    var isWaitingForClaude: Bool { startError == Self.claudeMissing && !isRunning }

    func start(tools: ToolEnvironment, conversation start: ConversationStart, voice: Bool, spinoffs: Bool, assistantOf store: URL? = nil, assistantName: String? = nil, remote: Bool = false,
               subassistant scope: (path: String, name: String)? = nil) {
        guard let host = SessionHost.executable else {
            startError = "Genlock is missing its session host. Reinstall the app."
            return
        }
        // Already running from before a restart, this attaches and the arguments go unused, so it
        // needs no Claude Code at all. Otherwise the file has to be there now: it updates itself.
        let socket = SessionHost.socket(in: channel.folder)
        let reattaching = SessionHost.isAlive(socket: socket)
        let found = tools.claudePath.flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
        guard let claude = found ?? (reattaching ? "claude" : nil) else {
            startError = Self.claudeMissing
            return
        }
        startError = nil
        exitCode = nil
        try? channel.prepare()
        channel.recordOwner(SessionMemory.Open(project: projectID, spawn: spawn, token: voiceToken, slot: slot))
        var env = tools.environment
        env["GENLOCK_APP_CHANNEL"] = channel.folder.path
        if let spawn { env["GENLOCK_SESSION"] = spawn.session }
        // Only the Assistant is told where every project is. A project's own Assistant is told too,
        // and fenced to its project by GENLOCK_APP_SCOPE.
        if let store {
            env["GENLOCK_APP_PROJECTS"] = store.path
            env["GENLOCK_APP_CHANNELS"] = VoiceChannel.defaultBase.path
            if let scope { env["GENLOCK_APP_SCOPE"] = scope.path }
        }
        let genlockCommand = tools.genlockArgv?.map { $0.contains(" ") ? "\"\($0)\"" : $0 }.joined(separator: " ")
        var newID: String?
        var resumeID: String?
        switch start {
        case .new(let id): newID = id
        case .resume(let id): resumeID = id
        case .latest: break
        }
        conversation = reattaching ? resumeID : newID ?? resumeID
        started = reattaching ? nil : (start, Date())
        let args = SessionLaunch.arguments(resume: start == .latest, voice: voice, genlockCommand: genlockCommand, spinoffs: spinoffs,
                                           reportsState: true, sessionID: newID, resumeID: resumeID,
                                           prompt: openingMessage ?? (newID == nil ? nil : (store != nil ? (startsQuietly ? nil : (scope != nil ? SessionLaunch.subassistantOpening : SessionLaunch.assistantOpening)) : spawn?.prompt)),
                                           assistant: store != nil && scope == nil, assistantName: assistantName, handoff: handoff,
                                           remote: remote, subassistantOf: scope?.name)
        view.startProcess(executable: host, args: ["run", socket, projectID, "--", claude] + args,
                          environment: env.map { "\($0.key)=\($0.value)" },
                          execName: nil, currentDirectory: projectID)
        isRunning = true
    }

    /// Messages typed in and not yet seen in the transcript (see Delivery).
    @ObservationIgnored private var pending: [Delivery.Pending] = []
    @ObservationIgnored private var checkedAt = Date.distantPast

    /// Typed as a paste, because Claude Code reads plain keystrokes over about 1 KB in pieces and
    /// could keep only the last. Return goes separately, because a burst that includes it is read
    /// as part of the paste rather than as pressing Enter. Each message is then checked against
    /// the transcript (confirmDeliveries).
    func submit(_ text: String) {
        type(text)
        pending.append(Delivery.Pending(text: text, at: Date()))
    }

    private func type(_ text: String) {
        view.send(txt: TerminalInput.bracketed(text, enabled: view.terminalStateSnapshot().bracketedPasteMode))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.view.send(txt: "\r")
        }
    }

    /// Checks what was typed in against the transcript, every few seconds while anything is
    /// unconfirmed: types a missing message once more when the session is idle, and returns those
    /// that never arrived, for the sender to hear about.
    func confirmDeliveries(now: Date = Date()) -> [String] {
        guard !pending.isEmpty, now.timeIntervalSince(checkedAt) >= 3 else { return [] }
        checkedAt = now
        let tail = channel.readState()?.transcript.flatMap { Delivery.tail(of: URL(fileURLWithPath: $0)) }
        var lost: [String] = []
        var keep: [Delivery.Pending] = []
        for var p in pending {
            // No transcript yet (a session still starting): only the half-hour limit applies.
            let arrived = tail.map { Delivery.arrived(p.text, inTranscript: $0) } ?? false
            switch Delivery.verdict(p, arrived: arrived, phase: tail == nil ? "working" : phase, now: now) {
            case .arrived: continue
            case .wait: keep.append(p)
            case .retype:
                type(p.text)
                p.tries += 1
                p.at = now
                keep.append(p)
            case .lost: lost.append(p.text)
            }
        }
        pending = keep
        return lost
    }

    /// Really ends it. Quitting the app does not come through here.
    func end() {
        SessionHost.end(socket: SessionHost.socket(in: channel.folder))
        view.terminate()
        isRunning = false
    }

    // MARK: LocalProcessTerminalViewDelegate

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.cols = newCols
                self?.rows = newRows
            }
        }
    }
    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.isRunning = false
                self.exitCode = exitCode
                if let started = self.started, started.how.failedToPickUp(exitCode: exitCode, after: Date().timeIntervalSince(started.at)) {
                    self.onFailedPickUp?()
                } else {
                    self.onExited?()
                }
            }
        }
    }
}
