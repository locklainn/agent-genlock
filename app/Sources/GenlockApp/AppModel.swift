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
    /// The plan's usage bars, from the server (UsagePoller), or an older session's status line.
    var usage: UsageReading? = UsageReading.load()
    @ObservationIgnored let usagePoller = UsagePoller()
    /// The project whose sessions the bar's second row lists.
    var activeProject: String?
    @ObservationIgnored var lastShown: [String: String] = [:]
    /// Where Control-Tab goes back to.
    @ObservationIgnored var previousSession: String?
    /// Ended lately, newest first. Reopening one picks its conversation back up.
    var recentlyEnded: [SessionMemory.Open] = []
    /// Sessions waiting on the one close confirmation. Every ✕ and Close in the app lands here.
    var closing: [String]?
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
    /// What a pane shows: its terminal, or only the goal and tasks it is on.
    var paneMode = PaneMode(rawValue: UserDefaults.standard.string(forKey: "paneMode") ?? "") ?? .cli {
        didSet { UserDefaults.standard.set(paneMode.rawValue, forKey: "paneMode") }
    }
    var hoveredCard: String?
    var setupTarget: String?
    var completingGoal: CompletingGoal?
    @ObservationIgnored private var lookingForClaude = false
    var showingCompleted = false
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
    @ObservationIgnored private var claudeTicker: Timer?
    @ObservationIgnored private var storeWatcher: ProjectWatcher?

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
        usagePoller.start()
        watchStore()
        claudeTicker = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            MainActor.assumeIsolated {
                AppModel.shared.lookForClaude()
                let usage = UsageReading.load()
                if usage != AppModel.shared.usage { AppModel.shared.usage = usage }
            }
        }
        voiceTicker = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            MainActor.assumeIsolated {
                let model = AppModel.shared
                model.voice.replayMovedOn(working: Set(model.sessions.values.filter { $0.phase == "working" }.map(\.key)))
                model.routeUpdates()
                model.relayToAssistant()
                model.voice.collectReplies(from: Array(model.sessions.values))
                model.collectSpawns()
                model.openSessionsIfAsked()
                model.collectTells()
                model.closeSessionsIfAsked()
                model.clearAssistantIfAsked()
                model.startAssistantFreshIfDue()
                model.swapSessionsIfAsked()
                model.refreshAssistantName()
                model.voice.expireReply()
                model.updateAttention()
                model.rememberSessions()
            }
        }
    }

    @discardableResult
    /// Another session can change the project list, such as a project's icon. Shown at once.
    private func watchStore() {
        let folder = store.file.deletingLastPathComponent().path
        let file = ProjectStore.comparable(store.file.path)
        let onChange: () -> Void = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.reloadStore() } }
        }
        storeWatcher = ProjectWatcher(folder: folder, relevant: { ProjectStore.comparable($0) == file }, onChange: onChange)
    }

    /// Picks up the project list as saved on disk, and starts on any project added elsewhere.
    func reloadStore() {
        var fresh = store
        guard fresh.reload() else { return }
        withAnimation(.spring(duration: 0.3)) { store = fresh }
        for p in store.projects where states[p.id]?.watcher == nil {
            state(for: p.id)
            if tools != nil { startWatching(p.id); refresh(p.id) }
        }
    }

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
            noteFinishedGoals(snap, in: id)
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
            let wait = session.channel.readWait(phase: session.phase)
            if session.wait != wait { withAnimation(.easeOut(duration: 0.2)) { session.wait = wait } }
            let title = session.channel.readTitle()
            if session.title != title { session.title = title }
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
        if let open = selection.click(id, shift: shift) {
            // A single project opens on its hub; the Assistant's card, and Shift-picks, open as before.
            if !shift, open.count == 1, open[0] != assistantFolder { openProjectHub(open[0]) } else { openSessions(open) }
        }
        if selection.overflowed { message = "A split holds up to \(DashSelection.maxPanes) sessions." }
    }

    func shiftReleased() {
        if let picked = picks.shiftReleased(), let to = picksTo { return typePicks(picked, project: to.project, session: to.session) }
        guard route == .dashboard, let open = selection.shiftReleased() else { return }
        openSessions(open)
    }

    // MARK: Picking tasks and goals into a prompt

    private(set) var picks = PromptPicks()
    /// Where Shift-clicked picks go when Shift comes up.
    @ObservationIgnored private var picksTo: (project: String, session: String?)?
    /// Counts each time picks are typed, so Whole project knows to close and hand you the prompt.
    private(set) var picksTyped = 0

    /// A click types a task or goal into the prompt; Shift-clicks mark several for when Shift comes up.
    func clickPick(_ pick: PromptPick, project: String, session: String?) {
        let shift = lastClickHadShift
        lastClickHadShift = false
        // Marks belong to one project's list; picking in another starts over.
        if let to = picksTo, to.project != project || to.session != session { picks.clear() }
        picksTo = (project, session)
        if let now = picks.click(pick, shift: shift) { typePicks(now, project: project, session: session) }
    }

    func pickOrder(_ pick: PromptPick) -> Int? { picks.order(of: pick) }

    /// Types, never submits, so you can say what to do with them. With no session in the
    /// project, a new one starts and gets them once Claude Code is up.
    func typePicks(_ picked: [PromptPick], project: String, session: String?) {
        picks.clear()
        picksTo = nil
        let text = PromptPicks.text(for: picked)
        guard !text.isEmpty else { return }
        let open = sessions.keys.filter { sessions[$0]?.projectID == project }.sorted()
        picksTyped += 1
        if let key = PromptPicks.target(from: session, lastShown: lastShown[project], open: open), let target = sessions[key] {
            if !visible.contains(key) || route != .sessions { show(key) }
            target.view.send(txt: text)
            focus(key)
            return
        }
        newSession(in: project)
        guard let key = lastShown[project] ?? sessions.keys.first(where: { sessions[$0]?.projectID == project }) else { return }
        // Claude Code takes a moment to draw its prompt; typing before then is lost.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, let target = self.sessions[key], target.isRunning else { return }
            target.view.send(txt: text)
            self.focus(key)
        }
    }

    func clearMarks() { selection.clear() }
    func isMarked(_ id: String) -> Bool { selection.marked.contains(id) }
    func markOrder(_ id: String) -> Int? { selection.marked.firstIndex(of: id).map { $0 + 1 } }
    var markedCount: Int { selection.marked.count }

    // MARK: Sessions

    func openSessions(_ ids: [String]) {
        for id in ids { ensureSession(id) }
        if let first = ids.first { activeProject = sessions[first]?.projectID ?? first }
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
        // Another session in a project has its own conversation, never the folder's latest one.
        let own = session.slot.map { _ in fresh ? newID : (memory.conversations[session.key] ?? newID) }
        let start = fresh && session.spawn == nil && session.slot == nil
            ? ConversationStart.new(newID)
            : transcripts.start(saved: memory.conversations[session.key], spawnSession: session.spawn?.session ?? own, newID: newID)
        if let own, session.slot != nil { memory.conversations[session.key] = own }
        if session.spawn == nil && session.slot == nil {
            session.onFailedPickUp = { [weak self, weak session] in
                guard let self, let session, self.sessions[session.key] === session else { return }
                self.message = "\(session.label) had no conversation to pick up, so this is a new one."
                self.restart(session.key, fresh: true)
            }
        }
        // No "The session ended" popup: an exit closes it like the ✕ does, landing on the project's
        // other session or a fresh one. Kept for a start that failed or died at once (it would loop),
        // and for a session whose host is still alive (only the view let go).
        session.onExited = { [weak self, weak session] in
            guard let self, let session, self.sessions[session.key] === session, session.startError == nil,
                  session.projectID != self.assistantFolder, (session.ranFor ?? 0) >= 5,
                  !SessionHost.isAlive(socket: SessionHost.socket(in: session.channel.folder)) else { return }
            self.closeTab(session.key)
        }
        let isAssistant = session.projectID == assistantFolder
        let isSub = session.slot == Self.subSlot
        session.start(tools: tools, conversation: start, voice: voice.speakReplies,
                      spinoffs: !isAssistant && !isSub && (session.spawn != nil || spinoffsAllowed(session.projectID)),
                      assistantOf: isAssistant || isSub ? store.file : nil,
                      assistantName: isAssistant ? namer.saved : nil,
                      remote: isAssistant && remoteControl,
                      subassistant: isSub ? (path: session.projectID, name: projectName(session.projectID)) : nil)
    }

    /// Reopens what was open last time, ready to carry on. Before the tools are found these
    /// wait, and boot starts them.
    private func restoreSessions() {
        memory = SessionMemory.load(from: memoryFile)
        let back = memory.restorable { project in project == self.assistantFolder || self.store.project(project)?.exists == true }
        for open in back.open {
            let session = TerminalSession(projectID: open.project, spawn: open.spawn, slot: open.slot, token: open.token)
            sessions[session.key] = session
        }
        visible = back.visible
        recentlyEnded = memory.ended ?? []
        // Closing a tab used to hide its session rather than end it. Those were closed, so end them.
        for key in memory.tucked ?? [] where sessions[key] != nil && !visible.contains(key) { endNoted(key) }
        if !visible.isEmpty { route = .sessions }
        adoptRunningSessions()
    }

    /// Whatever the memory says, a session still running comes back. Otherwise it would carry on
    /// working where nobody can see or reach it.
    private func adoptRunningSessions() {
        let known = Set(sessions.values.map(\.voiceToken))
        for name in (try? FileManager.default.contentsOfDirectory(atPath: VoiceChannel.defaultBase.path)) ?? [] where !known.contains(name) {
            let channel = VoiceChannel(session: name)
            guard let owner = channel.owner, owner.token == name,
                  owner.project == assistantFolder || store.project(owner.project)?.exists == true,
                  SessionHost.isAlive(socket: SessionHost.socket(in: channel.folder)) else { continue }
            let session = TerminalSession(projectID: owner.project, spawn: owner.spawn, slot: owner.slot, token: name)
            if sessions[session.key] == nil { sessions[session.key] = session }
        }
    }

    /// Claude Code replaces itself when it updates, so missing can just mean not yet. Sessions
    /// waiting for it start once it is back.
    private func lookForClaude() {
        guard !lookingForClaude, tools != nil, sessions.values.contains(where: \.isWaitingForClaude) else { return }
        lookingForClaude = true
        Task.detached {
            let resolved = ToolEnvironment.resolve()
            await MainActor.run {
                self.lookingForClaude = false
                guard let claude = resolved.claudePath, FileManager.default.isExecutableFile(atPath: claude) else { return }
                self.tools = resolved
                for session in self.sessions.values where session.isWaitingForClaude { self.launch(session, tools: resolved) }
            }
        }
    }

    /// Sessions outlive the app, so their channels do too. Only one nothing remembers can go.
    private func removeForgottenChannels() {
        let keep = Set(sessions.values.map(\.voiceToken))
        let base = VoiceChannel.defaultBase
        for name in (try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? [] where !keep.contains(name) {
            let folder = base.appendingPathComponent(name)
            // Cleaning up never ends anything. Only you do, by ending the session.
            if !SessionHost.isAlive(socket: SessionHost.socket(in: folder)) { try? FileManager.default.removeItem(at: folder) }
        }
    }

    /// A session you ended, or that exited, is not reopened. Its conversation is still remembered.
    func rememberSessions() {
        var next = memory
        let open = sessions.values.filter { SessionMemory.stillOpen(isRunning: $0.isRunning, exitCode: $0.exitCode) }
        next.open = open.map { SessionMemory.Open(project: $0.projectID, spawn: $0.spawn, token: $0.voiceToken, slot: $0.slot) }.sorted { $0.key < $1.key }
        next.visible = visible
        next.tucked = nil
        next.ended = recentlyEnded.isEmpty && memory.ended == nil ? nil : recentlyEnded
        for session in open { if let id = session.conversation { next.conversations[session.key] = id } }
        guard next != memory else { return }
        memory = next
        try? next.save(to: memoryFile)
    }

    func restart(_ key: String, fresh: Bool) {
        let project = sessions[key]?.projectID ?? key
        let spawn = sessions[key]?.spawn
        let slot = sessions[key]?.slot
        // Not attached does not mean not running. Resuming a session that is still going is attaching to it.
        if let current = sessions[key], !current.isRunning, SessionHost.isAlive(socket: SessionHost.socket(in: current.channel.folder)) {
            if !fresh, let tools {
                launch(current, tools: tools)
                return
            }
            current.end()
        }
        if sessions[key]?.isRunning == true { sessions[key]?.end() }
        sessions[key]?.channel.remove()
        if fresh && spawn == nil { memory.conversations[key] = nil }
        let session = TerminalSession(projectID: project, spawn: spawn, slot: slot)
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
            message = "\(tabLabel(session.key)) is running, but the split is full. Find it in \(projectName(session.projectID))'s tabs."
        } else {
            next.append(session.key)
        }
        withAnimation(.spring(duration: 0.4)) {
            visible = next
            route = .sessions
        }
    }

    /// Brings a session to the front, from a tab or from the overflow menu.
    func show(_ key: String) {
        if let now = visible.first, now != key { previousSession = now }
        if let project = sessions[key]?.projectID { activeProject = project; lastShown[project] = key }
        visible = [key]
        route = .sessions
        focus(key)
    }

    /// Ends a session and keeps its conversation under Recently ended, one click from reopened.
    func endNoted(_ key: String) {
        guard let session = sessions[key] else { return }
        recentlyEnded = SessionMemory.noteEnded(SessionMemory.Open(project: session.projectID, spawn: session.spawn, slot: session.slot,
                                                                    conversation: session.conversation ?? memory.conversations[key]), in: recentlyEnded)
        endSession(key)
    }

    /// The way back from ending a session by accident: same conversation, new process.
    func reopen(_ ended: SessionMemory.Open) {
        recentlyEnded.removeAll { $0.key == ended.key }
        if sessions[ended.key] == nil {
            if let conversation = ended.conversation { memory.conversations[ended.key] = conversation }
            let session = TerminalSession(projectID: ended.project, spawn: ended.spawn, slot: ended.slot)
            sessions[session.key] = session
            if let tools { launch(session, tools: tools) }
        }
        show(ended.key)
    }

    /// Switches one pane to another session, leaving the rest of the split as it is.
    func showInPane(_ key: String, replacing pane: String) {
        if let project = sessions[key]?.projectID { activeProject = project; lastShown[project] = key }
        if visible.contains(key) { focus(key); return }
        previousSession = pane
        if let i = visible.firstIndex(of: pane) { visible[i] = key } else { visible = [key] }
        route = .sessions
        focus(key)
    }

    /// The project in front of you: the one picked last, else the first on screen.
    var currentProject: String? {
        if let activeProject, sessions.values.contains(where: { $0.projectID == activeProject }) { return activeProject }
        return visible.first.flatMap { sessions[$0]?.projectID }
    }

    /// Projects with a session that has a tab, alphabetically by name.
    var projectsWithTabs: [String] {
        Array(Set(sessions.values.map(\.projectID))).sorted { projectName($0).localizedCaseInsensitiveCompare(projectName($1)) == .orderedAscending }
    }

    /// A project's sessions with tabs, its main session first. Not its Assistant, which has its own pinned tab.
    func sessionKeys(in project: String) -> [String] {
        sessions.keys.filter { sessions[$0]?.projectID == project && sessions[$0]?.slot != Self.subSlot }.sorted()
    }

    // MARK: Project Assistants

    /// The session slot a project's own Assistant runs in. genlock knows it by the same name.
    static let subSlot = "assistant"

    func subKey(_ project: String) -> String { SessionMemory.key(project: project, ticket: nil, slot: Self.subSlot) }

    func isSubassistant(_ key: String) -> Bool { sessions[key]?.slot == Self.subSlot }

    /// A project's sessions as its grid shows them: its Assistant first, then the rest. `start`
    /// opens the Assistant when it is not running; without it, only an open one is included.
    func gridKeys(_ project: String, start: Bool) -> [String] {
        let sub = subKey(project)
        if start && sessions[sub] == nil { startSubassistant(project) }
        return (sessions[sub] == nil ? [] : [sub]) + sessionKeys(in: project)
    }

    /// Shows a project's grid, its Assistant first if you opened it. Never starts one.
    func openProjectGrid(_ project: String) {
        openSessions(Array(gridKeys(project, start: false).prefix(SplitLayout.maxPanes)))
    }

    /// Whether the screen is one project's grid: several panes, all from that project.
    func showingProjectGrid(_ project: String) -> Bool {
        visible.count > 1 && visible.allSatisfy { sessions[$0]?.projectID == project }
    }

    /// Command-G. In one session, its project's grid. In a project's grid, back to the session
    /// you are in, with its project's tabs. In the all-projects grid, out to the project you are in.
    func toggleProjectGrid() {
        guard route == .sessions, let key = focusedProject ?? visible.first, let project = sessions[key]?.projectID else { return }
        if visible.count > 1 { show(key); return }
        let keys = gridKeys(project, start: false)
        if keys.count > 1 { openProjectGrid(project) } else { message = "\(projectName(project)) has one session, so there is no grid to show." }
    }

    /// What clicking a project opens: its hub, its sessions side by side, in whichever mode you
    /// are already in (switching it on a click is disorienting). Its Assistant leads only if you
    /// already opened it; a click never starts one.
    func openProjectHub(_ project: String) {
        openSessions(Array(gridKeys(project, start: false).prefix(SplitLayout.maxPanes)))
    }

    /// Out of the hub: one session alone, with its terminal.
    func breakOut(_ key: String) {
        paneMode = .cli
        show(key)
    }

    /// Shows a project's Assistant, starting it on a project status when it is not open yet.
    func openSubassistant(_ project: String, replacing pane: String? = nil) {
        let key = subKey(project)
        if sessions[key] == nil { startSubassistant(project) }
        if let pane { showInPane(key, replacing: pane) } else { show(key) }
    }

    private func startSubassistant(_ project: String, quietly opening: String? = nil) {
        memory.conversations[subKey(project)] = nil
        let session = TerminalSession(projectID: project, slot: Self.subSlot)
        if let opening { session.startsQuietly = true; session.openingMessage = opening }
        sessions[session.key] = session
        if let tools { launch(session, tools: tools, fresh: true) }
    }

    /// Status update in a project: its Assistant starts on a fresh conversation and sweeps, so it
    /// stays near-stateless like the main one. A turn in progress is left to finish.
    func projectStatus(_ project: String, replacing pane: String? = nil) {
        let key = subKey(project)
        if let current = sessions[key], current.isRunning, current.phase == "working" {
            message = "\(projectName(project))'s Assistant is mid-turn. Try Status update again once it has answered."
        } else if sessions[key] != nil {
            restart(key, fresh: true)
        }
        openSubassistant(project, replacing: pane)
    }

    func projectName(_ project: String) -> String {
        if project == assistantFolder { return assistantName }
        return store.project(project)?.name ?? URL(fileURLWithPath: project).lastPathComponent
    }

    /// Back to the session you were last in there, else its first.
    func showProject(_ project: String) {
        let keys = sessionKeys(in: project)
        guard let key = lastShown[project].flatMap({ keys.contains($0) ? $0 : nil }) ?? keys.first else { return }
        show(key)
    }

    /// Control-Tab: the session before this one.
    func showPrevious() {
        guard let previous = previousSession, sessions[previous] != nil else { return }
        show(previous)
    }

    /// Another session in a project that already has one: its own tab and its own conversation.
    /// New means a new conversation. Picking up an old one is Recently ended's job.
    func newSession(in project: String) {
        show(startSession(in: project))
    }

    /// Starts a new conversation in a project without bringing it to the front, and returns its key.
    @discardableResult
    private func startSession(in project: String, opening: String? = nil) -> String {
        guard sessions[project] != nil else {
            memory.conversations[project] = nil
            let session = TerminalSession(projectID: project)
            session.openingMessage = opening
            sessions[project] = session
            if let tools { launch(session, tools: tools, fresh: true) }
            return project
        }
        let session = TerminalSession(projectID: project, slot: String(UUID().uuidString.prefix(6)).lowercased())
        session.openingMessage = opening
        sessions[session.key] = session
        if let tools { launch(session, tools: tools) }
        return session.key
    }

    /// A grid is the list of panes taken when it was opened, so a session started later is not in
    /// it. When the grid on screen already shows this session's project (its own grid, or every
    /// project's), the session joins it after that project's last pane. One session on screen is
    /// left alone, so nothing jumps in front of you. Returns whether it joined.
    @discardableResult
    func joinGridIfShowing(_ key: String) -> Bool {
        guard route == .sessions, visible.count > 1, !visible.contains(key), visible.count < DashSelection.maxPanes,
              let project = sessions[key]?.projectID,
              let last = visible.lastIndex(where: { sessions[$0]?.projectID == project }) else { return false }
        withAnimation(.spring(duration: 0.4)) { visible.insert(key, at: last + 1) }
        return true
    }

    /// The Assistant opened a session on a project, for you, often while you are on the phone.
    /// It starts in the background: whatever you are looking at stays in front.
    func openSessionsIfAsked() {
        guard tools != nil else { return }
        let askers = sessions.values.filter { $0.projectID == assistantFolder || $0.slot == Self.subSlot }
        for asker in askers {
            let who = asker.slot == Self.subSlot ? "\(projectName(asker.projectID))'s Assistant" : assistantName
            for request in asker.channel.takeOpens() {
                guard let project = store.project(request.project), project.exists else {
                    message = "\(who) asked to open \(request.project), which is not one of your projects."
                    continue
                }
                // A project's Assistant opens sessions in its own project only.
                if asker.slot == Self.subSlot && project.id != asker.projectID { continue }
                let key = startSession(in: project.id, opening: request.prompt)
                message = joinGridIfShowing(key)
                    ? "\(who) opened \(tabLabel(key)) in \(project.name), beside its other sessions."
                    : "\(who) opened \(tabLabel(key)) in \(project.name). Find it in its tabs."
            }
        }
    }

    /// What a tab says beside its project icon: what the session is for, never an id. A spin-off
    /// by its task, any other by the task it is working on, else the project's name.
    func tabLabel(_ key: String) -> String {
        guard let session = sessions[key] else { return key }
        if session.slot == Self.subSlot { return "Assistant" }
        if let title = session.title { return title }
        if session.spawn != nil { return label(project: session.projectID, spawn: session.spawn) ?? session.label }
        let snap = state(for: session.projectID).snapshot
        let focus = snap.flatMap { $0.initialized ? session.focus(in: $0) : nil }
        if let task = focus?.working?.heading { return task }
        let keys = sessions.keys.filter { sessions[$0]?.projectID == session.projectID && sessions[$0]?.spawn == nil && sessions[$0]?.slot != Self.subSlot }.sorted()
        if session.slot == nil && keys.count == 1 { return projectName(session.projectID) }
        return "Session \((keys.firstIndex(of: key) ?? 0) + 1)"
    }

    func label(project: String, spawn: SpawnRequest?) -> String? {
        if let spawn {
            return state(for: project).snapshot?.ticket(spawn.ticket)?.heading ?? "New session"
        }
        return sessions[project]?.label ?? store.project(project)?.name
    }

    func endSession(_ key: String) {
        let project = sessions[key]?.projectID
        sessions[key]?.end()
        sessions[key]?.channel.remove()
        sessions[key] = nil
        visible.removeAll { $0 == key }
        if visible.isEmpty {
            // Where you were: the same project's last-shown or other session, else the session
            // before this one, else the dashboard. Never whichever key sorts first (it was the Assistant).
            let same = project.map { p in lastShown[p].flatMap { sessions[$0] != nil ? $0 : nil } ?? sessionKeys(in: p).first } ?? nil
            let back = previousSession.flatMap { sessions[$0] != nil ? $0 : nil }
            if let next = same ?? back { show(next) } else { route = .dashboard }
        }
    }

    /// What the bar's new-session menu offers: a project has one main session, so those without.
    var projectsWithoutSession: [Project] { store.projects.filter { sessions[$0.id] == nil && $0.exists } }

    func hasRunningSession(project: String) -> Bool {
        sessions.values.contains { $0.projectID == project && $0.isRunning }
    }

    /// Takes a pane out of the split and leaves its session running. Not an ✕: ✕ always ends.
    func hidePane(_ id: String) {
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

    /// Remote Control on the Assistant, so it can be reached from the Claude Code app or
    /// claude.ai/code. Saved, and carried by every launch, so restarts and handoffs keep it.
    var remoteControl = UserDefaults.standard.bool(forKey: "assistantRemoteControl") {
        didSet {
            guard remoteControl != oldValue else { return }
            UserDefaults.standard.set(remoteControl, forKey: "assistantRemoteControl")
            // The flag only applies at launch, so a running Assistant restarts on its same conversation.
            if sessions[assistantFolder] != nil { restart(assistantFolder, fresh: false) }
            message = remoteControl
                ? "\(assistantName) is on Remote Control. Find it in the Claude Code app or at claude.ai/code."
                : "Remote Control is off for \(assistantName)."
        }
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
        // Typed into a terminal that is still starting, the ask is lost, so a new session opens on it.
        if letItChoose && !hadSession {
            // One waiting to start takes it with it; one that has exited is replaced.
            let session = sessions[assistantFolder].flatMap { $0.exitCode == nil ? $0 : nil } ?? TerminalSession(projectID: assistantFolder)
            session.openingMessage = SessionLaunch.chooseOwnName
            sessions[assistantFolder] = session
        }
        openAssistant()
        if letItChoose && hadSession {
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
        activeProject = assistantFolder
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

    /// A session asked, on your yes, to give way to a fresh one on a goal. Once its turn ends
    /// the fresh one takes its place in the tab and the split, and opens on that goal. The old
    /// conversation goes to Recently ended, so a swap made by mistake is one click from undone.
    func swapSessionsIfAsked() {
        guard let tools else { return }
        for old in Array(sessions.values) where old.projectID != assistantFolder && old.isRunning {
            guard let swap = old.channel.requestedSwap,
                  SessionSwap.ready(phase: old.phase, repliesWaiting: old.channel.waitingCount,
                                    dictating: voice.machine.state != .idle) else { continue }
            let key = old.key
            let wasFocused = focusedProject == key
            let conversation = old.conversation ?? old.channel.readState()?.session ?? memory.conversations[key]
            let newSlot = { String(UUID().uuidString.prefix(6)).lowercased() }
            recentlyEnded = SessionMemory.noteEnded(SessionSwap.ended(project: old.projectID, spawn: old.spawn, slot: old.slot,
                                                                      conversation: conversation, keptSlot: newSlot()), in: recentlyEnded)
            old.end()
            old.channel.remove()
            sessions[key] = nil
            let fresh = TerminalSession(projectID: old.projectID, slot: SessionSwap.freshSlot(spawn: old.spawn, slot: old.slot, newSlot: newSlot()))
            fresh.openingMessage = swap.prompt
            if fresh.key == key { memory.conversations[key] = nil }
            sessions[fresh.key] = fresh
            launch(fresh, tools: tools, fresh: true)
            if let i = visible.firstIndex(of: key) { visible[i] = fresh.key }
            if lastShown[fresh.projectID] == key { lastShown[fresh.projectID] = fresh.key }
            if previousSession == key { previousSession = fresh.key }
            if wasFocused { focus(fresh.key) }
            message = "Started a fresh session on \(swap.title). The previous conversation is under Recently ended."
        }
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

    /// Project sessions' replies to what the Assistant told them, and their questions for you,
    /// handed to the Assistant together once it is idle, whether or not voice is on.
    func relayToAssistant() {
        guard tools != nil else { return }
        let reporters = sessions.values.filter { $0.projectID != assistantFolder }
        let waiting = reporters.flatMap { session in session.channel.peekRelays().map { (session: session, file: $0.file, report: $0.report) } }
            .sorted { ($0.report.at ?? 0) < ($1.report.at ?? 0) }
        guard !waiting.isEmpty else { return }
        // A reply a project's Assistant asked for goes back to it. Everything else, and anything for
        // a project Assistant that has since closed, goes to the main one.
        let subs = Dictionary(sessions.values.filter { $0.slot == Self.subSlot }.map { ($0.channel.folder.path, $0) },
                              uniquingKeysWith: { a, _ in a })
        let target = { (report: RelayReport) -> TerminalSession? in
            RelayRouting.recipient(of: report, among: Array(subs.keys)).flatMap { subs[$0] }
        }
        let forTally = waiting.filter { target($0.report) == nil }
        if !forTally.isEmpty {
            let stillOwing = reporters.filter { $0.channel.owesReply && $0.isRunning && $0.phase == "working" }.count
            deliverRelays(forTally, to: sessions[assistantFolder], stillOwing: stillOwing)
        }
        for sub in Set(waiting.compactMap { target($0.report)?.key }).compactMap({ sessions[$0] }) {
            let mine = waiting.filter { target($0.report) === sub }
            let stillOwing = reporters.filter { $0.projectID == sub.projectID && $0 !== sub && $0.channel.owesReply && $0.isRunning && $0.phase == "working" }.count
            deliverRelays(mine, to: sub, stillOwing: stillOwing)
        }
    }

    /// Hands reports to one assistant together, once it is idle. `to` nil or a closed main
    /// Assistant starts the main one; a project's Assistant is always open when it is the target.
    private func deliverRelays(_ waiting: [(session: TerminalSession, file: URL, report: RelayReport)], to assistant: TerminalSession?, stillOwing: Int) {
        guard let tools else { return }
        let oldest = waiting.first?.report.at.map { Date().timeIntervalSince1970 - $0 / 1000 } ?? 0
        guard RelayRouting.ready(reports: waiting.count, assistantPhase: assistant?.phase, assistantRunning: assistant?.isRunning == true,
                                 dictating: voice.machine.state != .idle, stillOwing: stillOwing, oldestAge: oldest) else { return }
        let briefing = RelayRouting.briefing(waiting.map { item in
            let s = item.session
            let handle = s.spawn?.ticket ?? s.slot.map { "+\($0)" } ?? "main"
            let task = tabLabel(s.key)
            return (project: projectName(s.projectID), session: handle, task: task == projectName(s.projectID) ? "" : task, report: item.report)
        })
        for item in waiting { try? FileManager.default.removeItem(at: item.file) }
        if let assistant, assistant.isRunning {
            assistant.submit(briefing)
        } else if let assistant, assistant.slot == Self.subSlot {
            startSubassistant(assistant.projectID, quietly: briefing)
        } else {
            try? FileManager.default.createDirectory(atPath: assistantFolder, withIntermediateDirectories: true)
            let fresh = TerminalSession(projectID: assistantFolder)
            fresh.startsQuietly = true
            fresh.openingMessage = briefing
            sessions[assistantFolder] = fresh
            launch(fresh, tools: tools)
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

    /// The Assistant closed a session for you during a sweep. It goes to Recently ended, so a
    /// close made by mistake is one click from undone. Never one that has started working again.
    func closeSessionsIfAsked() {
        for session in Array(sessions.values) where session.projectID != assistantFolder && session.channel.requestedClose {
            guard session.phase != "working" else {
                // A session closing itself asks during its own last turn: wait for that turn to end.
                // The Assistant's close of a session that has started working again is dropped.
                if !session.channel.requestedSelfClose {
                    try? FileManager.default.removeItem(at: session.channel.folder.appendingPathComponent("close.json"))
                }
                continue
            }
            let key = session.key
            recentlyEnded = SessionMemory.noteEnded(SessionMemory.Open(project: session.projectID, spawn: session.spawn, slot: session.slot,
                                                                        conversation: session.conversation ?? session.channel.readState()?.session ?? memory.conversations[key]),
                                                     in: recentlyEnded)
            let label = tabLabel(key)
            endSession(key)
            message = "Closed \(label). It is under Recently ended if you want it back."
        }
    }

    /// Opens the Assistant and asks it to go through every session.
    func statusSweep() {
        if namer.saved == nil && !askedForName { return openAssistant() }
        startAssistantFresh(on: SessionLaunch.statusSweep)
        openAssistant()
    }

    /// A status update waiting to start the Assistant on a fresh conversation.
    private var freshStatus: String?

    /// Every status update starts the Assistant clean, so its context never piles up. The old
    /// conversation is kept in its conversations folder. A turn in progress finishes first.
    func startAssistantFresh(on opening: String) {
        freshStatus = opening
        startAssistantFreshIfDue()
    }

    func startAssistantFreshIfDue() {
        if let asked = sessions[assistantFolder]?.channel.takeFreshTell() { freshStatus = asked }
        guard let opening = freshStatus else { return }
        let old = sessions[assistantFolder]
        if let old, old.exitCode == nil, !old.isRunning {
            // Not started yet (the tools are still being found): it opens on this instead.
            old.openingMessage = opening
            freshStatus = nil
            return
        }
        if let old, old.isRunning {
            guard SessionLaunch.assistantMayStartFresh(phase: old.phase, repliesWaiting: old.channel.waitingCount,
                                                       dictating: voice.machine.state != .idle) else { return }
            keepAssistantConversation(old.channel.readState()?.transcript)
            old.end()
            old.channel.remove()
        }
        guard let tools else { return }
        freshStatus = nil
        let wasFocused = focusedProject == assistantFolder
        memory.conversations[assistantFolder] = nil
        try? FileManager.default.createDirectory(atPath: assistantFolder, withIntermediateDirectories: true)
        let fresh = TerminalSession(projectID: assistantFolder)
        fresh.openingMessage = opening
        sessions[assistantFolder] = fresh
        launch(fresh, tools: tools, fresh: true)
        if wasFocused { focus(assistantFolder) }
    }

    private func keepAssistantConversation(_ transcript: String?) {
        guard let transcript, FileManager.default.fileExists(atPath: transcript) else { return }
        let kept = URL(fileURLWithPath: assistantFolder).appendingPathComponent("conversations")
        try? FileManager.default.createDirectory(at: kept, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try? FileManager.default.copyItem(atPath: transcript, toPath: kept.appendingPathComponent("\(stamp).jsonl").path)
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

    /// Your words are the answer, so they are also what is on record as yours.
    func answerQuestion(_ question: Snapshot.Question, _ text: String, in project: String) {
        runCLI(["answer", question.id, text, "--user-said", text], in: project, failure: "Could not send that answer")
    }

    func discuss(_ question: Snapshot.Question, with session: TerminalSession) {
        session.submit("About this question you have for me (\(question.id)): \(question.text) Help me decide. Once I have, record it with genlock answer.")
        focus(session.key)
    }

    func completeGoal(_ goal: Snapshot.Goal, evidence: String, in project: String) {
        runCLI(["goal", "done", goal.id, "--evidence", evidence, "--user-said", "Marked complete in the Genlock app"],
               in: project, failure: "Could not complete it")
    }

    func reopenGoal(_ goal: Snapshot.Goal, in project: String) {
        runCLI(["goal", "reopen", goal.id, "--user-said", "Reopened in the Genlock app"], in: project, failure: "Could not reopen it")
    }

    /// Celebrates each goal once, whoever finished it and even if the app was closed at the time.
    private func noteFinishedGoals(_ snap: Snapshot, in id: String) {
        guard snap.initialized else { return }
        var saved = UserDefaults.standard.dictionary(forKey: "celebratedGoals") as? [String: [String]] ?? [:]
        let keys = GoalCompletion.keys(snap.goals)
        let seen = saved[id].map(Set.init)
        guard seen != keys else { return }
        for goal in GoalCompletion.newlyFinished(snap.goals, seen: seen) {
            let project = store.project(id)
            CelebrationPresenter.show(Celebration(goal: goal, project: project?.name ?? URL(fileURLWithPath: id).lastPathComponent, tier: project?.tier ?? .soon))
        }
        saved[id] = Array(keys)
        UserDefaults.standard.set(saved, forKey: "celebratedGoals")
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
