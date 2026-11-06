import AppKit
import GenlockCore
import SwiftUI

/// One project's live state, from `genlock snapshot`.
@MainActor @Observable
final class ProjectState {
    var snapshot: Snapshot?
    var error: SnapshotError?
    /// What changed in the last refresh, to point at it briefly.
    var recentlyChanged: Set<String> = []
    /// What its latest conversation is about, which needs no goals or setup.
    var activity: SessionActivity?
    @ObservationIgnored var watcher: ProjectWatcher?
    @ObservationIgnored var refreshing = false
    @ObservationIgnored var refreshAgain = false
    @ObservationIgnored var clearHighlight: DispatchWorkItem?
}

enum Route: Equatable { case dashboard, sessions }

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    // A test can point this elsewhere, so it never sees or changes your real project list.
    private(set) var store = ProjectStore(file: ProcessInfo.processInfo.environment["GENLOCK_APP_STORE"].map { URL(fileURLWithPath: $0) } ?? ProjectStore.defaultFile)
    private(set) var tools: ToolEnvironment?
    private(set) var states: [String: ProjectState] = [:]
    private(set) var sessions: [String: TerminalSession] = [:]
    private(set) var selection = DashSelection()
    @ObservationIgnored private var memory = SessionMemory()
    @ObservationIgnored private var memoryFile: URL { SessionMemory.file(beside: store.file) }
    var route: Route = .dashboard
    var visible: [String] = []
    var message: String? {
        didSet {
            messageTimer?.cancel()
            guard message != nil else { return }
            let clear = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { withAnimation(.easeOut) { self?.message = nil } }
            }
            messageTimer = clear
            DispatchQueue.main.asyncAfter(deadline: .now() + 14, execute: clear)
        }
    }
    @ObservationIgnored private var messageTimer: DispatchWorkItem?
    var suggestions: [String] = []
    var hiddenInspectors: Set<String> = []
    var hoveredCard: String?
    var setupTarget: String?
    var iconTarget: String?
    var settingUp: Set<String> = []
    var focus = DashFocus(saved: UserDefaults.standard.string(forKey: "dashFocus")) {
        didSet { UserDefaults.standard.set(focus.rawValue, forKey: "dashFocus") }
    }
    let voice = VoiceController()

    @ObservationIgnored var lastClickHadShift = false
    @ObservationIgnored var cardFrames: [String: CGRect] = [:]
    let updater = AppUpdater()
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var voiceTicker: Timer?

    func boot() {
        suggestions = ProjectStore.discover().filter { store.project($0) == nil }
        for p in store.projects { state(for: p.id) }
        restoreSessions()
        removeForgottenChannels()
        Task.detached {
            let resolved = ToolEnvironment.resolve()
            await MainActor.run {
                self.tools = resolved
                self.updater.start()
                for p in self.store.projects { self.startWatching(p.id); self.refresh(p.id) }
                // Anything clicked while the tools were being found starts now.
                for session in self.sessions.values where !session.isRunning && session.exitCode == nil {
                    self.launch(session, tools: resolved)
                }
            }
        }
        // What no file event signals: claims lapsing, and days ticking over on deadlines.
        ticker = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            MainActor.assumeIsolated {
                for p in AppModel.shared.store.projects { AppModel.shared.refresh(p.id) }
            }
        }
        voiceTicker = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            MainActor.assumeIsolated {
                let model = AppModel.shared
                model.voice.replayMovedOn(working: Set(model.sessions.values.filter { $0.phase == "working" }.map(\.key)))
                model.routeUpdates()
                model.voice.collectReplies(from: Array(model.sessions.values))
                model.collectSpawns()
                model.collectTells()
                model.clearAssistantIfAsked()
                model.refreshAssistantName()
                model.voice.expireReply()
                model.updateAttention()
                model.rememberSessions()
            }
        }
    }

    @discardableResult
    func state(for id: String) -> ProjectState {
        if let s = states[id] { return s }
        let s = ProjectState()
        states[id] = s
        return s
    }

    private func startWatching(_ id: String) {
        guard FileManager.default.fileExists(atPath: id) else { return }
        state(for: id).watcher = ProjectWatcher(folder: id) { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.refresh(id) }
            }
        }
    }

    /// One snapshot at a time per project. A change during a refresh runs one more afterwards.
    func refresh(_ id: String) {
        guard let tools else { return }
        let s = state(for: id)
        if s.refreshing { s.refreshAgain = true; return }
        s.refreshing = true
        let transcripts = Transcripts(project: id, claudeHome: Transcripts.claudeHome(environment: tools.environment))
        let conversation = memory.conversations[id]
        Task.detached(priority: .userInitiated) {
            let result = GenlockCLI.snapshot(of: id, tools: tools)
            let activity = transcripts.activity(conversation: conversation)
            await MainActor.run {
                if s.activity != activity { s.activity = activity }
                self.apply(result, to: s, id: id)
            }
        }
    }

    private func apply(_ result: Result<Snapshot, SnapshotError>, to s: ProjectState, id: String) {
        s.refreshing = false
        switch result {
        case .success(let snap):
            s.error = nil
            if snap != s.snapshot {
                let changed = SnapshotDiff.changedIDs(old: s.snapshot, new: snap)
                if s.snapshot == nil {
                    // The first load is not a change, and animating it spills text out of the growing card.
                    var instant = Transaction()
                    instant.disablesAnimations = true
                    withTransaction(instant) { s.snapshot = snap }
                } else {
                    withAnimation(.easeOut(duration: 0.25)) {
                        s.snapshot = snap
                        if !changed.isEmpty { s.recentlyChanged = changed }
                    }
                }
                if !changed.isEmpty {
                    s.clearHighlight?.cancel()
                    let clear = DispatchWorkItem { [weak s] in
                        MainActor.assumeIsolated {
                            withAnimation(.easeOut(duration: 0.6)) { s?.recentlyChanged = [] }
                        }
                    }
                    s.clearHighlight = clear
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: clear)
                }
            }
        case .failure(let e):
            s.error = e
        }
        if s.refreshAgain {
            s.refreshAgain = false
            refresh(id)
        }
    }

    // MARK: Projects

    func addProject(path: String) {
        let clean = URL(fileURLWithPath: path).standardizedFileURL.path
        if let existing = store.project(clean) {
            // Already here, so go and show it rather than appear to do nothing.
            focusDashboard(focus == .all ? .all : DashFocus(saved: existing.tier.rawValue))
            message = "\(existing.name) is already in \(existing.tier.title)."
            return
        }
        let p = withAnimation(.spring(duration: 0.35)) { store.add(path: path, tier: focus.tierForNewProject) }
        persist()
        route = .dashboard
        message = "Added \(p.name) to \(p.tier.title)."
        suggestions.removeAll { $0 == p.id }
        state(for: p.id)
        startWatching(p.id)
        refresh(p.id)
    }

    func removeProject(_ id: String) {
        for key in sessions.values.filter({ $0.projectID == id }).map(\.key) { endSession(key) }
        states[id]?.watcher?.stop()
        states[id] = nil
        store.remove(id)
        persist()
    }

    func setIcon(_ id: String, _ icon: ProjectIcon?) {
        withAnimation(.spring(duration: 0.3)) { store.setIcon(id, icon) }
        persist()
        iconTarget = nil
    }

    func chooseIconImage(for id: String) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.prompt = "Use Image"
        panel.message = "Choose an image for this project"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try store.setIcon(id, imageAt: url)
            persist()
            iconTarget = nil
        } catch {
            message = "Could not use that image: \(error.localizedDescription)"
        }
    }

    func move(_ id: String, to tier: Tier, before other: String? = nil) {
        withAnimation(.snappy) { store.move(id, to: tier, before: other) }
        persist()
    }

    private func persist() {
        do { try store.save() } catch { message = "Could not save your projects: \(error.localizedDescription)" }
    }

    func chooseFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        panel.message = "Choose project folders"
        if panel.runModal() == .OK {
            for url in panel.urls { addProject(path: url.path) }
        }
    }

    /// Writes to the project, so it runs only because someone chose it, on the setup screen.
    func setUp(_ id: String, flag: String) {
        setupTarget = nil
        let name = URL(fileURLWithPath: id).lastPathComponent
        settingUp.insert(id)
        Task {
            while self.tools == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
            let tools = self.tools!
            await self.runSetUp(id, name: name, flag: flag, tools: tools)
        }
    }

    private func runSetUp(_ id: String, name: String, flag: String, tools: ToolEnvironment) async {
        await Task.detached {
            let out = try? GenlockCLI.run(["init", flag], in: id, tools: tools)
            await MainActor.run {
                self.settingUp.remove(id)
                self.refresh(id)
                if out?.status != 0 {
                    self.message = "Could not set up \(name): \(out?.stderr.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Genlock did not run")"
                } else {
                    let running = self.sessions[id]?.isRunning == true
                    self.message = running
                        ? "\(name) is on the signal. End and restart its session to load the new rules."
                        : "\(name) is on the signal. Open its session and start working. Claude will track goals as you go."
                }
            }
        }.value
    }

    // MARK: Who needs you

    @ObservationIgnored var openMainWindow: (() -> Void)?

    /// What the Dock and menu bar count: sessions that need you, and replies waiting to be heard.
    var alertCount: Int { needingAttention.count + voice.waitingReplies }

    func hearReplies() { voice.hearReplies(from: Array(sessions.values)) }
    func dismissReplies() { voice.dismissReplies(from: Array(sessions.values)) }

    var needingAttention: [TerminalSession] {
        sessions.values.filter { $0.attention != nil }.sorted { $0.key < $1.key }
    }

    func attention(project: String) -> Attention? {
        let here = sessions.values.filter { $0.projectID == project }.compactMap(\.attention)
        return here.contains(.waiting) ? .waiting : here.first
    }

    private func isLooking(at key: String) -> Bool {
        NSApp.isActive && route == .sessions && visible.contains(key)
    }

    func updateAttention() {
        for session in sessions.values where session.isRunning {
            let report = session.channel.readState()
            let isNew = (report?.at ?? 0) > session.lastReportAt
            if let report, isNew {
                session.lastReportAt = report.at
                if let id = report.session { session.conversation = id }
                session.phase = report.state
                session.attentionMessage = report.message
            }
            guard let report else { continue }
            let result = Attention.next(current: session.attention, report: report, isNew: isNew, looking: isLooking(at: session.key))
            if session.attention != result.attention {
                withAnimation(.spring(duration: 0.3)) { session.attention = result.attention }
                if result.attention == nil { Notifier.clear(session.key) }
            }
            if result.notify, let attention = result.attention { Notifier.post(session: session, attention: attention) }
        }
        let count = alertCount
        NSApp.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
    }

    /// Where a click on a notification or the menu bar lands.
    func showSession(_ key: String) {
        NSApp.activate(ignoringOtherApps: true)
        if NSApp.windows.first(where: { $0.canBecomeMain && $0.isVisible }) == nil { openMainWindow?() }
        NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
        guard sessions[key] != nil else { route = .dashboard; return }
        if !visible.contains(key) { visible = [key] }
        route = .sessions
        focus(key)
        updateAttention()
    }

    func focusDashboard(_ focus: DashFocus) {
        withAnimation(.spring(duration: 0.32)) {
            self.focus = focus
            route = .dashboard
        }
    }

    // MARK: Clicking cards

    /// Shift comes from the mouse-down event rather than from whatever is held by the time
    /// SwiftUI's tap fires, which can be after the key has come up.
    func clickCard(_ id: String) {
        let shift = lastClickHadShift
        lastClickHadShift = false
        if let open = selection.click(id, shift: shift) { openSessions(open) }
        if selection.overflowed { message = "A split holds up to \(DashSelection.maxPanes) sessions." }
    }

    func shiftReleased() {
        guard route == .dashboard, let open = selection.shiftReleased() else { return }
        openSessions(open)
    }

    func clearMarks() { selection.clear() }
    func isMarked(_ id: String) -> Bool { selection.marked.contains(id) }
    func markOrder(_ id: String) -> Int? { selection.marked.firstIndex(of: id).map { $0 + 1 } }
    var markedCount: Int { selection.marked.count }

    // MARK: Sessions

    func openSessions(_ ids: [String]) {
        for id in ids { ensureSession(id) }
        visible = ids
        route = .sessions
        focus(ids.first)
    }

    /// Read from disk rather than the snapshot, which may not have loaded when a session starts.
    private func spinoffsAllowed(_ project: String) -> Bool {
        FileManager.default.fileExists(atPath: "\(project)/.genlock/records")
    }

    @discardableResult
    private func ensureSession(_ id: String) -> TerminalSession {
        if let existing = sessions[id], existing.isRunning || existing.exitCode != nil { return existing }
        let session = sessions[id] ?? TerminalSession(projectID: id)
        sessions[id] = session
        if let tools { launch(session, tools: tools) }
        return session
    }

    /// Picks up the session's conversation unless `fresh` asks for a new one. A spin-off keeps
    /// its own either way, because the id holding its claim cannot start over.
    private func launch(_ session: TerminalSession, tools: ToolEnvironment, fresh: Bool = false) {
        let transcripts = Transcripts(project: session.projectID, claudeHome: Transcripts.claudeHome(environment: tools.environment))
        let newID = UUID().uuidString.lowercased()
        let start = fresh && session.spawn == nil
            ? ConversationStart.new(newID)
            : transcripts.start(saved: memory.conversations[session.key], spawnSession: session.spawn?.session, newID: newID)
        if session.spawn == nil {
            session.onFailedPickUp = { [weak self, weak session] in
                guard let self, let session, self.sessions[session.key] === session else { return }
                self.message = "\(session.label) had no conversation to pick up, so this is a new one."
                self.restart(session.key, fresh: true)
            }
        }
        let isAssistant = session.projectID == assistantFolder
        session.start(tools: tools, conversation: start, voice: voice.speakReplies,
                      spinoffs: !isAssistant && (session.spawn != nil || spinoffsAllowed(session.projectID)),
                      assistantOf: isAssistant ? store.file : nil,
                      assistantName: isAssistant ? namer.saved : nil)
    }

    /// Reopens what was open last time, ready to carry on. Before the tools are found these
    /// wait, and boot starts them.
    private func restoreSessions() {
        memory = SessionMemory.load(from: memoryFile)
        let back = memory.restorable { project in project == self.assistantFolder || self.store.project(project)?.exists == true }
        for open in back.open {
            let session = TerminalSession(projectID: open.project, spawn: open.spawn, token: open.token)
            sessions[session.key] = session
        }
        visible = back.visible
        if !visible.isEmpty { route = .sessions }
    }

    /// Sessions outlive the app, so their channels do too. Only one nothing remembers can go.
    private func removeForgottenChannels() {
        let keep = Set(sessions.values.map(\.voiceToken))
        let base = VoiceChannel.defaultBase
        for name in (try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? [] where !keep.contains(name) {
            let folder = base.appendingPathComponent(name)
            SessionHost.end(socket: SessionHost.socket(in: folder))
            try? FileManager.default.removeItem(at: folder)
        }
    }

    /// A session you ended, or that exited, is not reopened. Its conversation is still remembered.
    func rememberSessions() {
        var next = memory
        let open = sessions.values.filter { $0.isRunning || ($0.exitCode == nil && $0.startError == nil) }
        next.open = open.map { SessionMemory.Open(project: $0.projectID, spawn: $0.spawn, token: $0.voiceToken) }.sorted { $0.key < $1.key }
        next.visible = visible
        for session in open { if let id = session.conversation { next.conversations[session.key] = id } }
        guard next != memory else { return }
        memory = next
        try? next.save(to: memoryFile)
    }

    func restart(_ key: String, fresh: Bool) {
        let project = sessions[key]?.projectID ?? key
        let spawn = sessions[key]?.spawn
        if sessions[key]?.isRunning == true { sessions[key]?.end() }
        sessions[key]?.channel.remove()
        if fresh && spawn == nil { memory.conversations[key] = nil }
        let session = TerminalSession(projectID: project, spawn: spawn)
        sessions[key] = session
        if let tools { launch(session, tools: tools, fresh: fresh) }
    }

    /// An agent's spin-off, which you have already said yes to, joins the split.
    func collectSpawns() {
        for session in Array(sessions.values) {
            for request in session.channel.takeSpawns() { openSpawn(request, beside: session.key) }
        }
    }

    private func openSpawn(_ request: SpawnRequest, beside parent: String) {
        guard let tools else { return }
        if let folder = sessions[parent]?.projectID, !request.belongs(to: folder) {
            message = "Ignored spin-off \(request.ticket), which came from \(request.project), not this project."
            return
        }
        // The parent's id, not the path git reports: they can spell one folder differently (/tmp, /private/tmp).
        let session = TerminalSession(projectID: sessions[parent]?.projectID ?? request.project, spawn: request)
        sessions[session.key] = session
        launch(session, tools: tools)
        var next = visible
        if !next.contains(parent) { next.append(parent) }
        if next.count >= DashSelection.maxPanes {
            message = "\(request.ticket) is running, but the split is full. Find it in the bar above."
        } else {
            next.append(session.key)
        }
        withAnimation(.spring(duration: 0.4)) {
            visible = next
            route = .sessions
        }
    }

    func endSession(_ key: String) {
        sessions[key]?.end()
        sessions[key]?.channel.remove()
        sessions[key] = nil
        visible.removeAll { $0 == key }
        if visible.isEmpty {
            // Another open session is closer to where you were than the dashboard.
            if let next = sessions.keys.sorted().first { visible = [next]; focus(next) } else { route = .dashboard }
        }
    }

    /// What the bar's new-session menu offers: a project has one main session, so those without.
    var projectsWithoutSession: [Project] { store.projects.filter { sessions[$0.id] == nil && $0.exists } }

    func hasRunningSession(project: String) -> Bool {
        sessions.values.contains { $0.projectID == project && $0.isRunning }
    }

    /// Showing or hiding a pane leaves its session running.
    func closePane(_ id: String) {
        visible.removeAll { $0 == id }
        if visible.isEmpty { route = .dashboard }
    }

    func toggleInSplit(_ id: String) {
        if let i = visible.firstIndex(of: id) {
            if visible.count > 1 { visible.remove(at: i) }
        } else if visible.count >= DashSelection.maxPanes {
            message = "A split holds up to \(DashSelection.maxPanes) sessions."
        } else {
            visible.append(id)
        }
    }

    func focus(_ id: String?) {
        guard let id, let view = sessions[id]?.view else { return }
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
    }

    /// The session that dictation goes to: the terminal holding the keyboard, or the first on screen.
    var focusedProject: String? {
        let responder = NSApp.keyWindow?.firstResponder
        if let hit = visible.first(where: { sessions[$0]?.view === responder }) { return hit }
        return visible.first
    }

    /// From the dashboard there is no project in front of you, so you are talking to the Assistant.
    func pressVoice(for id: String? = nil) {
        if id == nil && voice.replyTo == nil && route == .dashboard && voice.machine.state == .idle {
            openAssistant()
            if askingAssistantName { return }
        }
        voice.press(target: ReplyTarget.dictationTarget(pane: id, reply: voice.replyTo, focused: focusedProject))
    }

    // MARK: The Assistant

    /// One session across all projects. It lives in a folder of its own, outside any repository.
    var assistantFolder: String {
        VoiceChannel.defaultBase.deletingLastPathComponent().appendingPathComponent("Assistant").path
    }

    private var namer: AssistantName { AssistantName(folder: URL(fileURLWithPath: assistantFolder)) }

    /// What to call it everywhere. Refreshed on the timer, because the agent can name itself.
    private(set) var assistantName = AssistantName.fallback
    /// Asking once is enough: "Not now" stays "Assistant", and it can be named by talking to it.
    var askingAssistantName = false
    private var askedForName: Bool {
        get { UserDefaults.standard.bool(forKey: "askedAssistantName") }
        set { UserDefaults.standard.set(newValue, forKey: "askedAssistantName") }
    }

    func refreshAssistantName() {
        let name = namer.saved ?? AssistantName.fallback
        if name != assistantName { assistantName = name }
        if let session = sessions[assistantFolder], session.displayName != name { session.displayName = name }
    }

    /// The answer to the question that opening it for the first time asks.
    func nameAssistant(_ choice: String?, letItChoose: Bool = false) {
        askedForName = true
        askingAssistantName = false
        if let choice { namer.save(choice) }
        refreshAssistantName()
        let hadSession = sessions[assistantFolder]?.isRunning == true
        openAssistant()
        if letItChoose {
            sessions[assistantFolder]?.submit(SessionLaunch.chooseOwnName)
        } else if hadSession, let saved = namer.saved, choice != nil {
            sessions[assistantFolder]?.submit(SessionLaunch.told(name: saved))
        }
    }

    func openAssistant() {
        if namer.saved == nil && !askedForName {
            askingAssistantName = true
            return
        }
        try? FileManager.default.createDirectory(atPath: assistantFolder, withIntermediateDirectories: true)
        ensureSession(assistantFolder)
        if !visible.contains(assistantFolder) { visible = [assistantFolder] }
        route = .sessions
        focus(assistantFolder)
    }

    /// The Assistant asked to start clean, at a break it chose. Waits for its turn to end and for
    /// you to hear anything it said. What carries over is the handoff it wrote for itself.
    func clearAssistantIfAsked() {
        guard let session = sessions[assistantFolder], session.isRunning, let handoff = session.channel.requestedHandoff,
              SessionLaunch.assistantMayClear(phase: session.phase, repliesWaiting: session.channel.waitingCount,
                                              dictating: voice.machine.state != .idle) else { return }
        let wasFocused = focusedProject == assistantFolder
        session.end()
        session.channel.remove()
        memory.conversations[assistantFolder] = nil
        let fresh = TerminalSession(projectID: assistantFolder)
        fresh.startsQuietly = true
        fresh.handoff = handoff
        sessions[assistantFolder] = fresh
        if let tools { launch(fresh, tools: tools, fresh: true) }
        if wasFocused { focus(assistantFolder) }
    }

    /// When two or more projects have something to say, the Assistant goes through them with you.
    func routeUpdates() {
        guard voice.speakReplies, let tools else { return }
        let ready = sessions.values
            .filter { $0.projectID != assistantFolder && $0.channel.waitingCount > 0
                && UpdateRouting.isReady(phase: $0.phase, isRunning: $0.isRunning) }
            .sorted { tierOrder($0.projectID) < tierOrder($1.projectID) }
        guard UpdateRouting.handToAssistant(projectsReady: ready.count, listening: voice.machine.state != .idle, speaking: voice.isSpeaking) else { return }
        let updates = ready.flatMap { session in session.channel.takeMessages().map { (session: session, text: $0) } }
        voice.keepForReplay(updates.map { (text: $0.text, from: $0.session.key) }, handedTo: assistantFolder)
        let briefing = UpdateRouting.briefing(updates.map { (project: $0.session.label, text: $0.text) })
        if let assistant = sessions[assistantFolder], assistant.isRunning {
            assistant.channel.markPending()
            assistant.submit(briefing)
        } else {
            // Typed before it is ready, a long line would be cut off, so it starts with this instead.
            try? FileManager.default.createDirectory(atPath: assistantFolder, withIntermediateDirectories: true)
            let assistant = TerminalSession(projectID: assistantFolder)
            assistant.startsQuietly = true
            assistant.openingMessage = briefing
            sessions[assistantFolder] = assistant
            launch(assistant, tools: tools)
            assistant.channel.markPending()
        }
    }

    private func tierOrder(_ project: String) -> Int {
        switch store.project(project)?.tier {
        case .today: return 0
        case .soon: return 1
        case .later: return 2
        case nil: return 3
        }
    }

    func collectTells() {
        for session in sessions.values where session.isRunning {
            for text in session.channel.takeTells() { session.submit(text) }
        }
    }

    // MARK: Reviews

    func open(_ review: Snapshot.Review, in id: String) {
        guard let s = states[id]?.snapshot, let url = review.url(root: s.root) else { return }
        if review.exists(root: s.root) { NSWorkspace.shared.open(url) }
        else { message = "\(review.path) is no longer there." }
    }

    /// Moves a goal or task to a place in its order. This is `genlock rank`, as for any agent.
    func rank(_ item: String, to place: Int, in project: String) {
        runCLI(["rank", item, "--to", "\(place)"], in: project, failure: "Could not move it")
    }

    func setDue(_ item: String, to day: String?, in project: String) {
        runCLI(["due", item] + (day.map { [$0] } ?? ["--clear"]), in: project, failure: "Could not change the due date")
    }

    private func runCLI(_ args: [String], in project: String, failure: String) {
        guard let tools else { return }
        Task.detached {
            let out = try? GenlockCLI.run(args, in: project, tools: tools)
            await MainActor.run {
                if out?.status != 0 { self.message = "\(failure): \(out?.stderr ?? "")" }
                self.refresh(project)
            }
        }
    }

    func markReviewed(_ review: Snapshot.Review, in id: String) {
        guard let tools else { return }
        Task.detached {
            let out = try? GenlockCLI.run(["review", "done", review.id], in: id, tools: tools)
            await MainActor.run {
                if out?.status != 0 { self.message = "Could not mark it reviewed: \(out?.stderr ?? "")" }
                self.refresh(id)
            }
        }
    }
}
