import AppKit
import GenlockCore
import SwiftTerm
import SwiftUI

struct SessionsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            SessionBar()
            let rows = SplitLayout.arrange(model.visible)
            VSplitView {
                ForEach(rows, id: \.self) { row in
                    HSplitView {
                        ForEach(row, id: \.self) { PaneView(sessionKey: $0).frame(minWidth: 320, minHeight: 240) }
                    }
                }
            }
        }
    }
}

/// Two rows: your projects, then the sessions in the one you picked. Nothing scrolls out of
/// sight; what does not fit is in the menu at the end of each row.
struct SessionBar: View {
    @Environment(AppModel.self) private var model
    @State private var showingSpeech = false
    @State private var showingSwitcher = false
    /// The width each row has, measured, so it knows how many tabs fit.
    @State private var projectsWidth: CGFloat = 0
    @State private var sessionsWidth: CGFloat = 0

    var body: some View {
        let voice = model.voice
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { model.route = .dashboard } label: {
                    HStack(spacing: 7) {
                        SignalMark(size: 18, animated: false)
                        if model.projectsWithTabs.count <= 5 { Text("Dashboard") }
                    }
                }
                .buttonStyle(GlassButtonStyle())
                .help("Dashboard")

                projectTabs
                UpdatePill()
                Button { showingSwitcher = true } label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(GlassButtonStyle(compact: true))
                    .keyboardShortcut("k", modifiers: .command)
                    .help("Jump to any session (⌘K). Control-Tab goes back to the last one.")
                    .popover(isPresented: $showingSwitcher, arrowEdge: .bottom) { SessionSwitcher(close: { showingSwitcher = false }) }
                Button { model.showPrevious() } label: { EmptyView() }
                    .keyboardShortcut(.tab, modifiers: .control).frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
                Button { model.openAssistant() } label: { Label(model.assistantName, systemImage: "sparkles") }
                    .buttonStyle(GlassButtonStyle())
                    .help("One session across all your projects")
                Button { showingSpeech.toggle() } label: {
                    Image(systemName: voice.speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill")
                }
                .buttonStyle(GlassButtonStyle(active: voice.speakReplies, compact: true))
                .popover(isPresented: $showingSpeech, arrowEdge: .bottom) { SpeechSettings(voice: voice) }
                .help(voice.speakReplies
                      ? "Agents read short replies aloud after you dictate. Voice: \(voice.chosenVoice?.name ?? "system default"). Sessions started from now on follow this setting. \(VoiceOption.upgradeHint(for: voice.chosenVoice) ?? "")"
                      : "Spoken replies are off")
                .accessibilityLabel("Spoken replies")
            }
            .padding(.leading, 86).padding(.trailing, 14).padding(.top, 9).padding(.bottom, 9)
        }
        .background(Color.black.opacity(0.25))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
    }
}

/// Whether replies are read aloud, and how fast.
struct SpeechSettings: View {
    @Bindable var voice: VoiceController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Read replies aloud", isOn: $voice.speakReplies).toggleStyle(.switch)
            VStack(alignment: .leading, spacing: 6) {
                Text("Reading speed").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                Picker("Reading speed", selection: $voice.speechSpeed) {
                    ForEach(SpeechSpeed.options, id: \.self) { Text(SpeechSpeed.label($0)).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            HStack {
                Text("Hold → while it talks to go faster").font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary)
                Spacer(minLength: 12)
                Button("Try it") { voice.trySpeed() }.buttonStyle(GlassButtonStyle(compact: true))
            }
        }
        .padding(16)
        .frame(width: 340)
    }
}

extension SessionBar {
    private func measured(_ width: Binding<CGFloat>) -> some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { width.wrappedValue = geo.size.width }
                .onChange(of: geo.size.width) { _, w in width.wrappedValue = w }
        }
    }

    /// One tab per project. Its dot is the most urgent of its sessions.
    private var projectTabs: some View {
        let order = model.projectsWithTabs
        let natural: (String) -> CGFloat = { TabOverflow.width(of: TabOverflow.short(model.projectName($0))) + 14 }
        var layout = TabOverflow.layout(order: order, priority: model.currentProject.map { [$0] } ?? [], room: projectsWidth - 40, natural: natural)
        if !layout.hidden.isEmpty {
            layout = TabOverflow.layout(order: order, priority: model.currentProject.map { [$0] } ?? [], room: projectsWidth - 160, natural: natural)
        }
        return HStack(spacing: 6) {
            ForEach(layout.shown, id: \.self) { project in
                ProjectTab(project: project, width: layout.width, dot: projectDot(project))
            }
            moreProjects(layout.hidden)
            openProjectMenu
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(measured($projectsWidth))
    }

    private func projectDot(_ project: String) -> SwiftUI.Color {
        let keys = model.sessionKeys(in: project)
        let needs = keys.compactMap { model.sessions[$0]?.attention }
        if needs.contains(.waiting) { return Theme.red }
        if needs.contains(.done) { return Theme.amber }
        return keys.contains { model.sessions[$0]?.isRunning == true } ? Theme.green : Theme.textTertiary
    }

    private func dotColor(_ id: String) -> SwiftUI.Color {
        let need = model.sessions[id]?.attention
        let running = model.sessions[id]?.isRunning == true
        return need == .waiting ? Theme.red : (need == .done ? Theme.amber : (running ? Theme.green : Theme.textTertiary))
    }

    private func statusWord(_ id: String) -> String {
        switch model.sessions[id]?.attention {
        case .waiting: return "needs you"
        case .done: return "your turn"
        default: return model.sessions[id]?.isRunning == true ? (model.sessions[id]?.phase == "working" ? "working" : "idle") : "stopped"
        }
    }

    /// Projects with no room in the bar. Only projects: sessions live in each pane's header.
    @ViewBuilder
    private func moreProjects(_ hidden: [String]) -> some View {
        if !hidden.isEmpty {
            let urgent = hidden.map(projectDot).first { $0 == Theme.red } ?? hidden.map(projectDot).first { $0 == Theme.amber }
            Menu {
                ForEach(hidden, id: \.self) { project in
                    Button { model.showProject(project) } label: {
                        Image(nsImage: TabOverflow.dot(NSColor(projectDot(project))))
                        Text(model.projectName(project))
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    if let urgent { Circle().fill(urgent).frame(width: 7, height: 7).shadow(color: urgent, radius: 4) }
                    Text("+\(hidden.count) project\(hidden.count == 1 ? "" : "s")").font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(urgent ?? Theme.textSecondary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .padding(.horizontal, 6)
            .accessibilityLabel("More projects")
        }
    }

    private func menuRow(_ id: String) -> some View {
        Button { model.show(id) } label: {
            Image(nsImage: TabOverflow.dot(NSColor(dotColor(id))))
            Text("\(model.tabLabel(id))  ·  \(statusWord(id))")
        }
    }
}

/// Which sessions get a tab when not all fit: the ones on screen and the ones needing you first,
/// then the rest in order. Tabs keep their usual order either way.
enum TabOverflow {
    /// The narrowest a tab gets: status dot, project icon and a few letters.
    static let minWidth: CGFloat = 92

    /// Like browser tabs: natural width while they fit, then all shrink evenly, and only below
    /// the narrowest do the rest move to the menu, the ones on screen and needing you kept first.
    static func layout(order: [String], priority: [String], room: CGFloat, natural: (String) -> CGFloat) -> (shown: [String], hidden: [String], width: CGFloat?) {
        let gap: CGFloat = 6
        if order.reduce(0, { $0 + natural($1) + gap }) <= room { return (order, [], nil) }
        let fits = max(1, Int((room + gap) / (minWidth + gap)))
        if order.count <= fits { return (order, [], max(minWidth, (room + gap) / CGFloat(order.count) - gap)) }
        var keep: [String] = []
        for id in priority + order where order.contains(id) && !keep.contains(id) && keep.count < fits { keep.append(id) }
        return (order.filter(keep.contains), order.filter { !keep.contains($0) }, minWidth)
    }

    /// Long names end in an ellipsis; the whole name is in the tooltip and the menu.
    static let maxCharacters = 22
    static func short(_ label: String) -> String {
        label.count <= maxCharacters ? label : String(label.prefix(maxCharacters - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// A tab's width: its name in the bar's font, plus the dot, icon, close button and padding.
    static func width(of label: String) -> CGFloat {
        let font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        return ceil((label as NSString).size(withAttributes: [.font: font]).width) + 79
    }

    /// A coloured dot that menus show in colour rather than as a template.
    static func dot(_ color: NSColor) -> NSImage {
        let image = NSImage(size: NSSize(width: 10, height: 10), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

extension SessionBar {
    /// Opens another project beside what you have, without going back to the dashboard.
    /// Projects with no session yet, and adding a folder.
    private var openProjectMenu: some View {
        Menu {
            Section("Open a project") {
                ForEach(model.projectsWithoutSession) { project in
                    Button(project.name) { model.newSession(in: project.id) }
                }
            }
            let shownProjects = Set(model.projectsWithTabs)
            let closed = model.sessions.keys.sorted().filter { model.tucked.contains($0) && !shownProjects.contains(model.sessions[$0]?.projectID ?? "") }
            if !closed.isEmpty {
                Section("Closed tabs, still running") { ForEach(closed, id: \.self) { menuRow($0) } }
            }
            let ended = model.recentlyEnded.filter { model.sessions[$0.key] == nil && !shownProjects.contains($0.project) }
            if !ended.isEmpty {
                Section("Recently ended") {
                    ForEach(ended, id: \.key) { open in
                        Button("Reopen \(model.projectName(open.project)): \(model.label(project: open.project, spawn: open.spawn) ?? "")") { model.reopen(open) }
                    }
                }
            }
            Divider()
            Button("Add a Folder…") { model.chooseFolders() }
        } label: {
            Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .padding(.horizontal, 6)
        .help("Open another project")
        .accessibilityLabel("Open a project")
    }
}

/// The project's sessions, in the pane header beside its name. Underlined text rather than
/// capsules, so they read as part of this project and not as more projects.
struct HeaderSessionTabs: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    let paneKey: String
    @State private var room: CGFloat = 0

    var body: some View {
        let order = model.sessionKeys(in: projectID)
        let natural: (String) -> CGFloat = { TabOverflow.width(of: TabOverflow.short(model.tabLabel($0))) - 40 }
        let layout = TabOverflow.layout(order: order, priority: [paneKey], room: room - 90, natural: natural)
        let closed = model.sessions.keys.sorted().filter { model.tucked.contains($0) && model.sessions[$0]?.projectID == projectID }
        let ended = model.recentlyEnded.filter { $0.project == projectID && model.sessions[$0.key] == nil }
        HStack(spacing: 2) {
            ForEach(layout.shown, id: \.self) { key in
                SessionStripTab(key: key, paneKey: paneKey, width: layout.width)
            }
            if !layout.hidden.isEmpty || !closed.isEmpty || !ended.isEmpty {
                Menu {
                    if !layout.hidden.isEmpty {
                        Section("No room here") { ForEach(layout.hidden, id: \.self) { key in Button(model.tabLabel(key)) { model.showInPane(key, replacing: paneKey) } } }
                    }
                    if !closed.isEmpty {
                        Section("Closed tabs, still running") { ForEach(closed, id: \.self) { key in Button(model.tabLabel(key)) { model.showInPane(key, replacing: paneKey) } } }
                    }
                    if !ended.isEmpty {
                        Section("Recently ended") {
                            ForEach(ended, id: \.key) { open in Button("Reopen \(model.label(project: open.project, spawn: open.spawn) ?? "session")") { model.reopen(open) } }
                        }
                    }
                } label: {
                    Text(layout.hidden.isEmpty ? "\(closed.count + ended.count) closed" : "+\(layout.hidden.count + closed.count)")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.textTertiary)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Sessions in this project without a tab here")
            }
            Button { model.newSession(in: projectID) } label: {
                Image(systemName: "plus").font(.system(size: 10.5, weight: .bold)).frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textSecondary)
            .help("New session in \(model.projectName(projectID)), with its own conversation")
            .accessibilityLabel("New session")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { geo in
            Color.clear.onAppear { room = geo.size.width }.onChange(of: geo.size.width) { _, w in room = w }
        })
    }
}

/// One session in a pane header: a dot and its name, underlined when it is the one shown.
struct SessionStripTab: View {
    @Environment(AppModel.self) private var model
    let key: String
    let paneKey: String
    let width: CGFloat?
    @State private var hovering = false

    var body: some View {
        let current = key == paneKey
        let session = model.sessions[key]
        let need = session?.attention
        let dot = need == .waiting ? Theme.red : (need == .done ? Theme.amber : (session?.isRunning == true ? Theme.green : Theme.textTertiary))
        let label = model.tabLabel(key)
        Button { model.showInPane(key, replacing: paneKey) } label: {
            HStack(spacing: 5) {
                Circle().fill(dot).frame(width: 6, height: 6)
                Text(width == nil ? TabOverflow.short(label) : label)
                    .font(.system(size: 12, weight: current ? .semibold : .regular))
                    .foregroundStyle(current ? Theme.textPrimary : (hovering ? Theme.textPrimary.opacity(0.85) : Theme.textSecondary))
                    .lineLimit(1).truncationMode(.tail)
                    .fixedSize(horizontal: width == nil, vertical: false)
                if hovering && !current {
                    Button { withAnimation(.spring(duration: 0.3)) { model.tuck(key) } } label: {
                        Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.textTertiary)
                    .help("Close this tab. The session keeps running.")
                }
            }
            .padding(.horizontal, 7).padding(.vertical, 4)
            .frame(width: width, alignment: .leading)
            .overlay(alignment: .bottom) {
                Rectangle().fill(current ? Theme.textPrimary.opacity(0.85) : .clear).frame(height: 2).padding(.horizontal, 6).offset(y: 5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("\(label). Right-click for more.")
        .contextMenu {
            if session?.spawn == nil {
                Button("Start New Conversation") { model.restart(key, fresh: true); model.showInPane(key, replacing: paneKey) }
            }
            Button("Close Tab (keeps running)") { model.tuck(key) }
            Divider()
            Button("End Session…") { model.confirmEnd(key) }
        }
    }
}

/// A project in the top row. Clicking it shows the session you were last in there.
struct ProjectTab: View {
    @Environment(AppModel.self) private var model
    let project: String
    let width: CGFloat?
    let dot: SwiftUI.Color

    var body: some View {
        let active = model.currentProject == project
        let count = model.sessionKeys(in: project).count
        let name = model.projectName(project)
        Button { model.showProject(project) } label: {
            HStack(spacing: 6) {
                Circle().fill(dot).frame(width: 7, height: 7).shadow(color: dot == Theme.textTertiary ? .clear : dot, radius: 4)
                if let p = model.store.project(project) { ProjectIconView(project: p, size: 16) }
                else { Image(systemName: "sparkles").font(.system(size: 12)) }
                if width == nil { Text(TabOverflow.short(name)).lineLimit(1).fixedSize() }
                else { Text(name).lineLimit(1).truncationMode(.tail); Spacer(minLength: 0) }
                if count > 1 && width == nil {
                    Text("\(count)").font(.system(size: 10.5, weight: .bold)).monospacedDigit()
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.white.opacity(0.12), in: Capsule())
                }
            }
            .frame(width: width.map { max(0, $0 - 24) }, alignment: .leading)
        }
        .buttonStyle(GlassButtonStyle(active: active))
        .help("\(name): \(count) session\(count == 1 ? "" : "s")")
        .contextMenu {
            Button("New Session in \(name)") { model.newSession(in: project) }
            Button("Close All Its Tabs (they keep running)") { model.sessionKeys(in: project).forEach(model.tuck) }
        }
    }
}

/// Type to find any session, in any project. Return opens the first match.
struct SessionSwitcher: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    @State private var query = ""
    @FocusState private var typing: Bool

    private var matches: [String] {
        let all = model.sessions.keys.sorted { model.projectName(model.sessions[$0]!.projectID) < model.projectName(model.sessions[$1]!.projectID) }
        let words = query.lowercased().split(separator: " ")
        return all.filter { key in
            let text = "\(model.projectName(model.sessions[key]?.projectID ?? "")) \(model.tabLabel(key))".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Find a session", text: $query)
                .textFieldStyle(.roundedBorder).focused($typing)
                .onSubmit { if let first = matches.first { model.show(first); close() } }
            ForEach(matches.prefix(12), id: \.self) { key in
                Button { model.show(key); close() } label: {
                    HStack(spacing: 8) {
                        if let p = model.sessions[key].flatMap({ model.store.project($0.projectID) }) { ProjectIconView(project: p, size: 16) }
                        Text(model.projectName(model.sessions[key]?.projectID ?? "")).foregroundStyle(Theme.textSecondary)
                        Text(model.tabLabel(key)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                        Spacer(minLength: 0)
                        if model.tucked.contains(key) { Text("closed tab").font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(width: 380)
        .onAppear { typing = true }
    }
}

struct PaneView: View {
    @Environment(AppModel.self) private var model
    /// The session's key. A spin-off has its own, and shares its project's goals and tasks.
    let sessionKey: String
    private var projectID: String { model.sessions[sessionKey]?.projectID ?? sessionKey }
    private var spawn: SpawnRequest? { model.sessions[sessionKey]?.spawn }
    private static let pushBelow: CGFloat = 560
    /// Narrower in a tight pane, so the terminal keeps enough columns to read.
    private func inspectorWidth(_ pane: CGFloat) -> CGFloat { pane < 860 ? 250 : 320 }

    private var isSplit: Bool { model.visible.count > 1 }
    private var inspectorHidden: Bool { model.hiddenInspectors.contains(sessionKey) }
    private var name: String { projectID == model.assistantFolder ? model.assistantName : URL(fileURLWithPath: projectID).lastPathComponent }
    private var tier: Tier { model.store.project(projectID)?.tier ?? .soon }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.gradient(tier)).frame(height: 2)
            header
            if isSplit, projectID != model.assistantFolder, let session = model.sessions[sessionKey] {
                SessionStrip(session: session, tier: tier, openPanel: toggleInspector)
            }
            GeometryReader { geo in
                // A narrow pane cannot give up the room, so there it slides over the terminal, closed until asked.
                // Side by side, the strip above says what this session is on and the panel waits to be asked.
                let roomy = !isSplit && geo.size.width >= Self.pushBelow
                let showInspector = projectID != model.assistantFolder
                    && (isSplit ? model.hiddenInspectors.contains("\(sessionKey)#split")
                        : roomy ? !inspectorHidden : model.hiddenInspectors.contains("\(sessionKey)#open"))
                HStack(spacing: 0) {
                    terminal
                    if roomy && showInspector {
                        InspectorView(projectID: projectID, sessionKey: sessionKey).frame(width: inspectorWidth(geo.size.width))
                            .transition(.move(edge: .trailing))
                    }
                }
                .overlay(alignment: .trailing) {
                    if !roomy && showInspector {
                        InspectorView(projectID: projectID, sessionKey: sessionKey)
                            .frame(width: min(inspectorWidth(geo.size.width), geo.size.width - 24))
                            .shadow(color: .black.opacity(0.6), radius: 20)
                            .transition(.move(edge: .trailing))
                    }
                }
            }
        }
    }

    private var header: some View {
        let voice = model.voice
        let listeningHere = voice.isListening && voice.target == sessionKey
        return HStack(spacing: 10) {
            if let p = model.store.project(projectID) { ProjectIconView(project: p, size: 20) }
            Text(name).font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Theme.gradient(tier)).lineLimit(1).fixedSize()
            Rectangle().fill(Theme.hairline).frame(width: 1, height: 16)
            HeaderSessionTabs(projectID: projectID, paneKey: sessionKey)
            if let phase = model.sessions[sessionKey]?.phase, model.sessions[sessionKey]?.isRunning == true {
                switch phase {
                case "working": WorkingIndicator()
                case "waiting": Pill(text: "Needs you", symbol: "bell.fill", color: Theme.red)
                default: Pill(text: "Your turn", symbol: "person.fill", color: Theme.green)
                }
            }
            Spacer(minLength: 8)
            MicButton(listening: listeningHere) { model.pressVoice(for: sessionKey) }
            if projectID != model.assistantFolder {
                Button { toggleInspector() } label: { Image(systemName: "sidebar.right") }
                    .buttonStyle(IconButtonStyle()).help("Show or hide goals and tasks").accessibilityLabel("Goals and tasks")
            }
            Button { model.closePane(sessionKey) } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle()).help("Close this pane. The session keeps running.").accessibilityLabel("Close pane")
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(Color.white.opacity(0.03))
        .contentShape(Rectangle())
        .onTapGesture { model.focus(sessionKey) }
    }

    private func toggleInspector() {
        // Both flags flip together, so whichever applies at this width changes.
        withAnimation(.spring(duration: 0.32)) {
            for key in isSplit ? ["\(sessionKey)#split"] : [sessionKey, "\(sessionKey)#open"] {
                if model.hiddenInspectors.contains(key) { model.hiddenInspectors.remove(key) }
                else { model.hiddenInspectors.insert(key) }
            }
        }
    }

    @ViewBuilder private var terminal: some View {
        if let session = model.sessions[sessionKey] {
            ZStack {
                TerminalHost(session: session)
                if !session.isRunning && model.tools != nil { SessionEndedOverlay(session: session, projectID: sessionKey) }
            }
        } else {
            VStack(spacing: 12) {
                Text("No session").foregroundStyle(Theme.textSecondary)
                Button("Start") { model.openSessions(model.visible) }.buttonStyle(GlowButtonStyle())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Talk. The obvious, unmissable thing to press, which turns red and pulses when it is on.
struct MicButton: View {
    let listening: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: listening ? "stop.fill" : "mic.fill").font(.system(size: 11, weight: .bold))
                Text(listening ? "Send" : "Talk").font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 11).padding(.vertical, 5)
            .background(listening ? AnyShapeStyle(Theme.hot) : AnyShapeStyle(hovering ? Theme.brand : LinearGradient(colors: [Color.white.opacity(0.14)], startPoint: .leading, endPoint: .trailing)), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 1))
            .shadow(color: listening ? Color(hex: 0xFF4D6D).opacity(0.8) : .clear, radius: 10)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(listening ? "Send what you said (right Option)" : "Talk to this session. Press again to send (right Option)")
        .accessibilityLabel(listening ? "Send dictation" : "Start dictation")
    }
}

struct SessionEndedOverlay: View {
    @Environment(AppModel.self) private var model
    let session: TerminalSession
    let projectID: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "powerplug.fill").font(.system(size: 22)).foregroundStyle(Theme.brand)
            Group {
                if let problem = session.startError { Text(problem) }
                else { Text(session.exitCode.map { "The session ended (exit code \($0))." } ?? "The session ended.") }
            }
            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Resume conversation") { model.restart(projectID, fresh: false); model.focus(projectID) }.buttonStyle(GlowButtonStyle())
                Button("Start new") { model.restart(projectID, fresh: true); model.focus(projectID) }.buttonStyle(GlassButtonStyle())
            }
        }
        .padding(24)
        .background(Color(hex: 0x12141F).opacity(0.94), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
        .shadow(radius: 20)
    }
}

/// Puts the session's own terminal view on screen. The view outlives this wrapper, which is
/// what keeps scrollback and the running process intact when the layout changes.
struct TerminalHost: NSViewRepresentable {
    let session: TerminalSession

    func makeNSView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        container.wantsLayer = true
        container.layer?.backgroundColor = Theme.terminal.cgColor
        container.show(session.view)
        return container
    }

    func updateNSView(_ container: TerminalContainer, context: Context) {
        container.show(session.view)
    }
}

/// Keeps the terminal inside its pane at every size. It places the terminal whenever its own size
/// changes, because it is first created with no size at all, and an inset of an empty rectangle is
/// a null one, whose origin is far off screen.
final class TerminalContainer: NSView {
    private static let inset = (x: CGFloat(6), y: CGFloat(4))
    private(set) weak var terminal: PaneTerminalView?

    func show(_ view: PaneTerminalView) {
        if view.superview !== self {
            view.removeFromSuperview()
            addSubview(view)
        }
        terminal = view
        if registeredDraggedTypes.isEmpty { registerForDraggedTypes([.fileURL]) }
        place()
    }

    // A file dropped on a pane goes to its session. Anywhere else, the window takes a folder as a new project.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        terminal?.process.running == true && !PaneTerminalView.fileURLs(on: sender.draggingPasteboard).isEmpty ? .copy : []
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let terminal, terminal.insert(paths: PaneTerminalView.fileURLs(on: sender.draggingPasteboard).map(\.path)) else { return false }
        window?.makeFirstResponder(terminal)
        return true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        place()
    }

    private func place() {
        guard let terminal, bounds.width > Self.inset.x * 2, bounds.height > Self.inset.y * 2 else { return }
        terminal.frame = bounds.insetBy(dx: Self.inset.x, dy: Self.inset.y)
    }
}
