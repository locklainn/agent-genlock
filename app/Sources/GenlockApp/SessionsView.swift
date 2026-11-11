import AppKit
import GenlockCore
import SwiftTerm
import SwiftUI

struct SessionsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            SessionBar()
            ProjectBar()
            // One flat list keyed by session, so a pane keeps its identity when the rows around it
            // change. Keyed by row, a swap or a new pane rebuilt every pane in that row, and the old
            // and new wrappers fought over the same terminal view; the loser left a blank pane.
            PaneGrid(rows: SplitLayout.rows(count: model.visible.count)) {
                ForEach(model.visible, id: \.self) { PaneView(sessionKey: $0) }
            }
            .background(Theme.hairline)
        }
    }
}

/// The top row: what acts on the whole app. Your projects are the row under it (ProjectBar),
/// and each project's sessions are in its pane header.
struct SessionBar: View {
    @Environment(AppModel.self) private var model
    @State private var showingSpeech = false
    @State private var showingSwitcher = false
    var body: some View {
        let voice = model.voice
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { model.route = .dashboard } label: {
                    HStack(spacing: 7) {
                        SignalMark(size: 18, animated: false)
                        Text("Dashboard")
                    }
                }
                .buttonStyle(GlassButtonStyle())
                .help("Dashboard")

                Spacer(minLength: 8)
                UsageMeter()
                UpdatePill()
                PaneModeToggle()
                Button { showEverything() } label: { Image(systemName: showingEverything ? "rectangle" : "square.grid.2x2") }
                    .buttonStyle(GlassButtonStyle(active: showingEverything, compact: true))
                    .help(showingEverything ? "Back to one session (⌘G)" : "Show every session in every project at once")
                    .accessibilityLabel("Show every session")
                Button { showingSwitcher = true } label: { Image(systemName: "magnifyingglass") }
                    .buttonStyle(GlassButtonStyle(compact: true))
                    .keyboardShortcut("k", modifiers: .command)
                    .help("Jump to any session (⌘K). Control-Tab goes back to the last one.")
                    .popover(isPresented: $showingSwitcher, arrowEdge: .bottom) { SessionSwitcher(close: { showingSwitcher = false }) }
                // ⌘G works on the project you are in, not on every project: see toggleProjectGrid.
                Button { model.toggleProjectGrid() } label: { EmptyView() }
                    .keyboardShortcut("g").frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
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
            .padding(.leading, 86).padding(.trailing, 14).padding(.top, 6).padding(.bottom, 6)
            .frame(minWidth: 0, maxWidth: .infinity)
        }
        .background(Color.black.opacity(0.25))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
    }
}

/// The second row: your projects as tabs, and at its right end what acts on the project you
/// are in: a new session in it, and its grid or back to one session. Shown on the dashboard
/// too, so the way into a project stays in one place.
struct ProjectBar: View {
    @Environment(AppModel.self) private var model
    /// The width the tabs have, measured, so they know how many fit.
    @State private var projectsWidth: CGFloat = 0

    var body: some View {
        let order = model.projectsWithTabs.filter { $0 != model.assistantFolder }
        if !order.isEmpty || model.route == .sessions {
            HStack(spacing: 8) {
                projectTabs(order)
                if model.route == .sessions { projectControls }
            }
            .padding(.leading, 14).padding(.trailing, 14).padding(.vertical, 5)
            .background(Color.black.opacity(0.15))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
        }
    }

    /// New session, and the grid toggle, for the project you are in. Nothing project-wide for Tally.
    @ViewBuilder
    private var projectControls: some View {
        let key = model.focusedProject ?? model.visible.first
        let project = key.flatMap { model.sessions[$0]?.projectID }
        let gridded = model.visible.count > 1
        if let project, project != model.assistantFolder {
            let count = model.gridKeys(project, start: false).count
            if gridded {
                Text(model.showingProjectGrid(project) ? "\(model.visible.count) sessions" : "\(model.visible.count) sessions, every project")
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                    .lineLimit(1).fixedSize()
            }
            Button { model.newSession(in: project) } label: {
                Label("New session", systemImage: "plus").font(.system(size: 11.5, weight: .semibold))
            }
            .buttonStyle(GlassButtonStyle(compact: true))
            .fixedSize()
            .help("A new session in \(model.projectName(project))\(gridded ? ", added to this grid" : "") (⌘N)")
            if gridded {
                oneSessionButton
            } else if count > 1 {
                Button { model.toggleProjectGrid() } label: {
                    Label("All \(count)", systemImage: "square.grid.2x2").font(.system(size: 11.5, weight: .semibold))
                }
                .buttonStyle(GlassButtonStyle(compact: true))
                .fixedSize()
                .help("\(model.projectName(project))'s \(count) sessions side by side (⌘G)")
            }
        } else if gridded {
            Text("\(model.visible.count) sessions").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.textSecondary).fixedSize()
            oneSessionButton
        }
    }

    private var oneSessionButton: some View {
        Button { model.toggleProjectGrid() } label: {
            Label("One session", systemImage: "rectangle").font(.system(size: 11.5, weight: .semibold))
        }
        .buttonStyle(GlassButtonStyle(compact: true))
        .fixedSize()
        .help("Back to the session you are in, alone (⌘G)")
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
    /// Every session with a tab, grouped by project, as many as a split holds.
    private var everySession: [String] {
        model.projectsWithTabs.flatMap { model.gridKeys($0, start: false) }
    }

    private var showingEverything: Bool {
        model.visible.count > 1 && Set(model.visible) == Set(everySession.prefix(SplitLayout.maxPanes))
    }

    private func showEverything() {
        if showingEverything {
            if let first = model.visible.first { model.show(first) }
            return
        }
        let all = everySession
        if all.count > SplitLayout.maxPanes {
            model.message = "Showing \(SplitLayout.maxPanes) of \(all.count) sessions; a split holds \(SplitLayout.maxPanes)."
        }
        // No animation: panes and their strips sliding into place reads as the layout lurching.
        model.openSessions(Array(all.prefix(SplitLayout.maxPanes)))
    }
}

extension ProjectBar {
    private func measured(_ width: Binding<CGFloat>) -> some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { width.wrappedValue = geo.size.width }
                .onChange(of: geo.size.width) { _, w in width.wrappedValue = w }
        }
    }

    /// One tab per project. Its dot is the most urgent of its sessions.
    /// No tab for Tally: its button sits at the top right of every screen already.
    private func projectTabs(_ order: [String]) -> some View {
        let natural: (String) -> CGFloat = { TabOverflow.width(of: TabOverflow.short(model.projectName($0))) + 14 }
        var layout = TabOverflow.layout(order: order, priority: model.currentProject.map { [$0] } ?? [], room: projectsWidth - 40, natural: natural)
        if !layout.hidden.isEmpty {
            layout = TabOverflow.layout(order: order, priority: model.currentProject.map { [$0] } ?? [], room: projectsWidth - 160, natural: natural)
        }
        return HStack(spacing: 6) {
            ForEach(layout.shown, id: \.self) { project in
                ProjectTab(project: project, width: layout.width, dot: projectDot(project), active: model.route == .sessions && model.currentProject == project)
            }
            moreProjects(layout.hidden)
            openProjectMenu
        }
        // minWidth 0: the tabs take the room that is left and fit themselves to it. Without it their
        // own width set the room they measured, and a crowded bar pushed the window's content off screen.
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .clipped()
        .background(measured($projectsWidth))
    }

    private func projectDot(_ project: String) -> SwiftUI.Color {
        let keys = model.sessionKeys(in: project)
        let needs = keys.compactMap { model.sessions[$0]?.attention }
        if needs.contains(.waiting) { return Theme.red }
        if needs.contains(.done) { return Theme.amber }
        return keys.contains { model.sessions[$0]?.isRunning == true } ? Theme.green : Theme.textTertiary
    }

    /// Projects with no room in the bar. Only projects: sessions live in each pane's header.
    @ViewBuilder
    private func moreProjects(_ hidden: [String]) -> some View {
        if !hidden.isEmpty {
            let urgent = hidden.map(projectDot).first { $0 == Theme.red } ?? hidden.map(projectDot).first { $0 == Theme.amber }
            Menu {
                ForEach(hidden, id: \.self) { project in
                    Button {
            // In a split that already shows this project, go to its pane rather than collapse the split.
            if let onScreen = model.visible.first(where: { model.sessions[$0]?.projectID == project }), model.visible.count > 1 {
                model.focus(onScreen)
            } else {
                model.showProject(project)
            }
        } label: {
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

extension ProjectBar {
    /// Opens another project beside what you have, without going back to the dashboard.
    /// Projects with no session yet, and adding a folder.
    private var openProjectMenu: some View {
        Menu {
            Section("Projects") {
                ForEach(model.store.projects.filter(\.exists)) { project in
                    Button {
                        model.openProject(project.id)
                    } label: {
                        Image(nsImage: TabOverflow.dot(NSColor(projectDot(project.id))))
                        Text(project.name)
                    }
                }
            }
            let shownProjects = Set(model.projectsWithTabs)
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
        let layout = TabOverflow.layout(order: order, priority: [paneKey], room: room - 90 - SubassistantTab.width, natural: natural)
        let ended = model.recentlyEnded.filter { $0.project == projectID && model.sessions[$0.key] == nil && $0.slot != AppModel.subSlot }
        HStack(spacing: 2) {
            SubassistantTab(projectID: projectID, paneKey: paneKey).padding(.trailing, 4)
            ForEach(layout.shown, id: \.self) { key in
                SessionStripTab(key: key, paneKey: paneKey, width: layout.width)
            }
            if !layout.hidden.isEmpty || !ended.isEmpty {
                Menu {
                    if !layout.hidden.isEmpty {
                        Section("No room here") { ForEach(layout.hidden, id: \.self) { key in Button(model.tabLabel(key)) { model.showInPane(key, replacing: paneKey) } } }
                    }
                    if !ended.isEmpty {
                        Section("Recently ended") {
                            ForEach(ended, id: \.key) { open in Button("Reopen \(model.label(project: open.project, spawn: open.spawn) ?? "session")") { model.reopen(open) } }
                        }
                    }
                } label: {
                    Text(layout.hidden.isEmpty ? "\(ended.count) closed" : "+\(layout.hidden.count)")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.textTertiary)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Sessions in this project without a tab here")
            }
            if !order.isEmpty {
                let inGrid = model.showingProjectGrid(projectID)
                Button {
                    if inGrid { model.show(paneKey) } else { model.openProjectGrid(projectID) }
                } label: {
                    Image(systemName: inGrid ? "rectangle" : "square.grid.2x2").font(.system(size: 10.5, weight: .semibold)).frame(width: 22, height: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(Theme.textSecondary)
                .help(inGrid ? "Back to this session alone, with \(model.projectName(projectID))'s tabs (⌘G)"
                             : "Show all of \(model.projectName(projectID))'s sessions side by side, its Assistant first if open (⌘G)")
                .accessibilityLabel(inGrid ? "Back to one session" : "Show all sessions in this project")
            }
            Button { model.newSession(in: projectID) } label: {
                Image(systemName: "plus").font(.system(size: 10.5, weight: .bold)).frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.textSecondary)
            .help("New session in \(model.projectName(projectID)), with its own conversation (⌘N)")
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
        let dot = need == .waiting ? Theme.red : (need == .done ? Theme.amber : (session?.wait.map { $0.state.color } ?? (session?.isRunning == true ? Theme.green : Theme.textTertiary)))
        let label = model.tabLabel(key)
        Button { model.showInPane(key, replacing: paneKey) } label: {
            HStack(spacing: 5) {
                if let wait = session?.wait, need == nil {
                    HStack(spacing: 3) {
                        WaitGlyph(state: wait.state, size: 8).frame(width: 8, height: 8)
                        Text(wait.gist).font(.system(size: 10, weight: .semibold)).foregroundStyle(wait.state.color).fixedSize()
                    }
                } else {
                    Circle().fill(dot).frame(width: 6, height: 6)
                }
                Text(width == nil ? TabOverflow.short(label) : label)
                    .font(.system(size: 12, weight: current ? .semibold : .regular))
                    .foregroundStyle(current ? Theme.textPrimary : (hovering ? Theme.textPrimary.opacity(0.85) : Theme.textSecondary))
                    .lineLimit(1).truncationMode(.tail)
                    .fixedSize(horizontal: width == nil, vertical: false)
                if hovering || current {
                    TabCloseButton { model.requestClose([key]) }
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
            Button("Close Session…") { model.requestClose([key]) }
        }
    }
}

/// The x on a tab. The glyph stays small, but the click lands anywhere in a 22pt square, which
/// lights up under the pointer so you can see where it counts. Negative padding keeps the tab's
/// height and width where they were, so the row does not jump when it appears.
struct TabCloseButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                .frame(width: 22, height: 22)
                .background(Circle().fill(hovering ? Theme.textPrimary.opacity(0.12) : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
        .padding(.vertical, -6).padding(.trailing, -7)
        .onHover { hovering = $0 }
        .help("Close this session. Its conversation stays under Recently ended.")
        .accessibilityLabel("Close session")
    }
}

/// A project's own Assistant, pinned first among its sessions. A tinted capsule with the project's
/// icon and a sparkle badge, so it reads as this project's Assistant and never as one more session.
struct SubassistantTab: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    let paneKey: String
    static let width: CGFloat = 112

    var body: some View {
        let key = model.subKey(projectID)
        let current = key == paneKey
        let session = model.sessions[key]
        let need = session?.attention
        let shape = Capsule(style: .continuous)
        Button { model.openSubassistant(projectID, replacing: paneKey) } label: {
            HStack(spacing: 5) {
                ZStack(alignment: .bottomTrailing) {
                    if let p = model.store.project(projectID) { ProjectIconView(project: p, size: 14) }
                    Image(systemName: "sparkles").font(.system(size: 7, weight: .black)).foregroundStyle(.white)
                        .padding(1.5).background(Theme.violet, in: Circle()).offset(x: 4, y: 3)
                }
                Text("Assistant").font(.system(size: 12, weight: current ? .bold : .semibold)).foregroundStyle(current ? Theme.textPrimary : Theme.violet)
                    .lineLimit(1).fixedSize()
                if let need {
                    Circle().fill(need == .waiting ? Theme.red : Theme.amber).frame(width: 6, height: 6)
                } else if session?.phase == "working" {
                    Circle().fill(Theme.violet).frame(width: 6, height: 6).shadow(color: Theme.violet, radius: 3)
                }
            }
            .padding(.leading, 7).padding(.trailing, 9).padding(.vertical, 3)
            .background(Theme.violet.opacity(current ? 0.28 : 0.12), in: shape)
            .overlay(shape.strokeBorder(Theme.violet.opacity(current ? 0.9 : 0.45), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .help("\(model.projectName(projectID))'s Assistant: works through every session and goal in this project with you")
        .accessibilityLabel("\(model.projectName(projectID)) Assistant")
        .contextMenu {
            Button("Status Update") { model.projectStatus(projectID, replacing: paneKey) }
            if session != nil { Button("Close Assistant") { model.endSession(key) } }
        }
    }
}

/// A project in the top row. Clicking it shows the session you were last in there.
struct ProjectTab: View {
    @Environment(AppModel.self) private var model
    let project: String
    let width: CGFloat?
    let dot: SwiftUI.Color
    let active: Bool

    var body: some View {
        let count = model.sessionKeys(in: project).count
        let name = model.projectName(project)
        Button { project == model.assistantFolder ? model.showProject(project) : model.openProjectHub(project) } label: {
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
            if count > 0 {
                Button("Show All Its Sessions") { model.openProjectGrid(project) }
            }
            Button("New Session in \(name)") { model.newSession(in: project) }
            Button("Close All Its Sessions…") { model.requestClose(model.sessionKeys(in: project)) }
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
    @State private var hovering = false

    /// In a grid, only the pane you are in, or the one under the pointer, shows its buttons.
    /// The rest fade but keep their room, so names do not shift as the pointer passes.
    private var showsControls: Bool {
        guard isSplit else { return true }
        let key = model.keyPane.flatMap { model.visible.contains($0) ? $0 : nil } ?? model.visible.first
        return hovering || key == sessionKey
    }

    var body: some View {
        VStack(spacing: 0) {
            // An Assistant's pane is violet from the top, so it never reads as an ordinary session.
            Rectangle().fill(isAssistantPane ? AnyShapeStyle(Theme.violet) : AnyShapeStyle(Theme.gradient(tier))).frame(height: isAssistantPane ? 3 : 2)
            header
            if model.paneMode == .tasks {
                tasks
            } else {
                cli
            }
        }
        .onHover { over in withAnimation(.easeOut(duration: 0.15)) { hovering = over } }
    }

    /// Tasks mode: the Assistant sees every project, a project's Assistant its project, a session its own work.
    @ViewBuilder private var tasks: some View {
        if projectID == model.assistantFolder {
            TaskBoardView(projectID: nil)
        } else if model.isSubassistant(sessionKey) {
            TaskBoardView(projectID: projectID)
        } else if let session = model.sessions[sessionKey] {
            TaskPaneView(session: session, tier: tier)
        }
    }

    @ViewBuilder private var cli: some View {
        VStack(spacing: 0) {
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

    /// Tally's pane, or a project's Assistant.
    private var isAssistantPane: Bool { projectID == model.assistantFolder || model.isSubassistant(sessionKey) }

    private var header: some View {
        let voice = model.voice
        let listeningHere = voice.isListening && voice.target == sessionKey
        return HStack(spacing: 10) {
            if let p = model.store.project(projectID) { ProjectIconView(project: p, size: 20).help(name) }
            if isSplit {
                // Several panes: each says only which session it is. Switching is the bar's job.
                Circle().fill(paneDot).frame(width: 7, height: 7)
                Button { model.breakOut(sessionKey) } label: {
                    Text(model.tabLabel(sessionKey)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                        .lineLimit(1).truncationMode(.tail).contentShape(Rectangle())
                }
                .buttonStyle(.plain).onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
                .help("\(name): \(model.tabLabel(sessionKey)). Click to open it alone, with its terminal.")
                if let wait = model.sessions[sessionKey]?.wait, model.sessions[sessionKey]?.attention == nil { WaitPill(wait: wait, compact: true) }
            } else {
                Text(name).font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Theme.gradient(tier)).lineLimit(1).fixedSize()
                Rectangle().fill(Theme.hairline).frame(width: 1, height: 16)
                HeaderSessionTabs(projectID: projectID, paneKey: sessionKey)
            }
            if !isSplit, let wait = model.sessions[sessionKey]?.wait, model.sessions[sessionKey]?.isRunning == true,
               model.sessions[sessionKey]?.phase != "waiting" {
                WaitPill(wait: wait)
            } else if !isSplit, let phase = model.sessions[sessionKey]?.phase, model.sessions[sessionKey]?.isRunning == true {
                switch phase {
                case "working": WorkingIndicator()
                case "waiting": Pill(text: "Needs you", symbol: "bell.fill", color: Theme.red)
                default: Pill(text: "Your turn", symbol: "person.fill", color: Theme.green)
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 10) {
            if model.isSubassistant(sessionKey) {
                Button { model.projectStatus(projectID, replacing: sessionKey) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checklist")
                        if !isSplit { Text("Status update").font(.system(size: 12, weight: .semibold)).fixedSize() }
                    }
                }
                .buttonStyle(GlassButtonStyle(compact: isSplit))
                .help("Start \(name)'s Assistant fresh, go through every session in this project, and suggest what to close or finish")
            }
            if projectID == model.assistantFolder {
                Button { model.statusSweep() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checklist")
                        if !isSplit { Text("Status update").font(.system(size: 12, weight: .semibold)).fixedSize() }
                    }
                }
                .buttonStyle(GlassButtonStyle(compact: isSplit))
                .help("Go through every session in every project, say where each stands, and suggest what to close or finish")
                Button { model.remoteControl.toggle() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: model.remoteControl ? "iphone.radiowaves.left.and.right" : "iphone")
                        if !isSplit { Text(model.remoteControl ? "Remote on" : "Remote").font(.system(size: 12, weight: .semibold)).fixedSize() }
                    }
                    .foregroundStyle(model.remoteControl ? Theme.green : Theme.textPrimary)
                }
                .buttonStyle(GlassButtonStyle(compact: isSplit))
                .help(model.remoteControl
                      ? "Remote Control is on: reach \(model.assistantName) from the Claude Code app or claude.ai/code. Click to turn it off."
                      : "Turn on Remote Control, to reach \(model.assistantName) from the Claude Code app on your phone or claude.ai/code. It restarts on the same conversation.")
                .accessibilityLabel("Remote Control")
            }
            MicButton(listening: listeningHere, compact: isSplit) { model.pressVoice(for: sessionKey) }
            if projectID != model.assistantFolder {
                Button { toggleInspector() } label: { Image(systemName: "sidebar.right") }
                    .buttonStyle(IconButtonStyle()).help("Show or hide goals and tasks").accessibilityLabel("Goals and tasks")
            }
            if isSplit {
                Button { model.hidePane(sessionKey) } label: { Image(systemName: "rectangle.split.2x1.slash") }
                    .buttonStyle(IconButtonStyle()).help("Take this pane out of the split. The session keeps running in its tab.").accessibilityLabel("Hide from split")
            }
            Button { model.requestClose([sessionKey]) } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle()).help("Close this session. Asks first; its conversation stays under Recently ended.").accessibilityLabel("Close session")
            }
            // Listening keeps Talk lit wherever the pointer is: Send must stay pressable.
            .opacity(showsControls || listeningHere ? 1 : 0)
            .allowsHitTesting(showsControls || listeningHere)
            .animation(.easeOut(duration: 0.15), value: showsControls)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(isAssistantPane ? Theme.violet.opacity(0.16) : Color.white.opacity(0.03))
        .contentShape(Rectangle())
        .onTapGesture { model.focus(sessionKey) }
    }

    /// The pane's status in split view, where there is no room for the pill.
    private var paneDot: SwiftUI.Color {
        let session = model.sessions[sessionKey]
        if session?.isRunning == true, let wait = session?.wait, session?.phase != "waiting" { return wait.state.color }
        switch session?.isRunning == true ? session?.phase : nil {
        case "working": return Theme.cyan
        case "waiting": return Theme.red
        case .some: return Theme.green
        default: return Theme.textTertiary
        }
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
                TerminalHost(session: session, fontSize: SplitLayout.fontSize(panes: model.visible.count))
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
    /// Icon only, for a narrow pane.
    var compact = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: listening ? "stop.fill" : "mic.fill").font(.system(size: 11, weight: .bold))
                if !compact { Text(listening ? "Send" : "Talk").font(.system(size: 12, weight: .semibold)).fixedSize() }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 8 : 11).padding(.vertical, 5)
            .background(listening ? AnyShapeStyle(Theme.hot) : AnyShapeStyle(hovering ? Theme.brand : LinearGradient(colors: [Color.white.opacity(0.14)], startPoint: .leading, endPoint: .trailing)), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 1))
            .shadow(color: listening ? Color(hex: 0xFF4D6D).opacity(0.8) : .clear, radius: 10)
        }
        .buttonStyle(.plain)
        .fixedSize()
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

/// Every row an equal share of the height, every pane in a row an equal share of the width.
struct PaneGrid: Layout {
    let rows: [Int]
    var spacing: CGFloat = 1

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions(by: CGSize(width: 800, height: 600))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let counts = rows.isEmpty ? [subviews.count] : rows
        let height = (bounds.height - spacing * CGFloat(counts.count - 1)) / CGFloat(counts.count)
        var index = 0
        for (r, n) in counts.enumerated() where n > 0 {
            let width = (bounds.width - spacing * CGFloat(n - 1)) / CGFloat(n)
            for c in 0..<n where index < subviews.count {
                let origin = CGPoint(x: bounds.minX + CGFloat(c) * (width + spacing), y: bounds.minY + CGFloat(r) * (height + spacing))
                subviews[index].place(at: origin, proposal: ProposedViewSize(width: width, height: height))
                index += 1
            }
        }
    }
}

/// Puts the session's own terminal view on screen. The view outlives this wrapper, which is
/// what keeps scrollback and the running process intact when the layout changes.
struct TerminalHost: NSViewRepresentable {
    let session: TerminalSession
    let fontSize: Double

    func makeNSView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        container.wantsLayer = true
        container.layer?.backgroundColor = Theme.terminal.cgColor
        container.show(session.view)
        resize(session.view)
        return container
    }

    func updateNSView(_ container: TerminalContainer, context: Context) {
        container.show(session.view)
        resize(session.view)
    }

    /// Only on a real change: a new font reflows the whole terminal.
    private func resize(_ view: PaneTerminalView) {
        guard abs(view.font.pointSize - fontSize) > 0.01 else { return }
        view.font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
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
