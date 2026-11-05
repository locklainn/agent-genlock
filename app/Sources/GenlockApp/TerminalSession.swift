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
    let voiceToken = UUID().uuidString
    let channel: VoiceChannel
    private(set) var isRunning = false
    private(set) var exitCode: Int32?
    private(set) var startError: String?
    var attention: Attention?
    /// What it last reported: working, done or waiting.
    var phase: String?
    var attentionMessage = ""
    /// Sent as the first message when the session starts.
    @ObservationIgnored var firstMessage: String?
    @ObservationIgnored var lastReportAt: Double = 0
    @ObservationIgnored let view: LocalProcessTerminalView

    var label: String {
        let name = URL(fileURLWithPath: projectID).lastPathComponent
        return spawn.map { "\(name) · \($0.ticket)" } ?? name
    }

    static func key(project: String, ticket: String?) -> String {
        ticket.map { "\(project)#\($0)" } ?? project
    }

    init(projectID: String, spawn: SpawnRequest? = nil) {
        self.projectID = projectID
        self.spawn = spawn
        key = Self.key(project: projectID, ticket: spawn?.ticket)
        channel = VoiceChannel(session: voiceToken)
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        super.init()
        view.processDelegate = self
        view.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.nativeBackgroundColor = Theme.terminal
        view.nativeForegroundColor = NSColor(white: 0.92, alpha: 1)
    }

    func start(tools: ToolEnvironment, resume: Bool, voice: Bool, spinoffs: Bool) {
        guard let claude = tools.claudePath else {
            startError = "Claude Code was not found. Install it, then try again."
            return
        }
        startError = nil
        exitCode = nil
        try? channel.prepare()
        var env = tools.environment
        env["GENLOCK_APP_CHANNEL"] = channel.folder.path
        if let spawn { env["GENLOCK_SESSION"] = spawn.session }
        let genlockCommand = tools.genlockArgv?.map { $0.contains(" ") ? "\"\($0)\"" : $0 }.joined(separator: " ")
        let args = SessionLaunch.arguments(resume: resume, voice: voice, genlockCommand: genlockCommand, spinoffs: spinoffs,
                                           reportsState: true, sessionID: spawn?.session, prompt: spawn?.prompt ?? firstMessage)
        view.startProcess(executable: claude, args: args,
                          environment: env.map { "\($0.key)=\($0.value)" },
                          execName: nil, currentDirectory: projectID)
        isRunning = true
    }

    /// Text and Return arrive separately, because a terminal app treats a burst that
    /// includes Return as a paste rather than as pressing Enter.
    func submit(_ text: String) {
        view.send(txt: text)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.view.send(txt: "\r")
        }
    }

    func end() {
        view.terminate()
        isRunning = false
    }

    // MARK: LocalProcessTerminalViewDelegate

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.isRunning = false
                self?.exitCode = exitCode
            }
        }
    }
}
