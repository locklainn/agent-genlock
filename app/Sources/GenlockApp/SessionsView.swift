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

/// Every session you have open, so you can move between them without the dashboard.
struct SessionBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let voice = model.voice
        HStack(spacing: 10) {
            Button { model.route = .dashboard } label: {
                HStack(spacing: 7) {
                    SignalMark(size: 18, animated: false)
                    Text("Dashboard")
                }
            }
            .buttonStyle(GlassButtonStyle())

            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(model.sessions.keys.sorted(), id: \.self) { id in
                        let shown = model.visible.contains(id)
                        let running = model.sessions[id]?.isRunning == true
                        Button {
                            if NSEvent.modifierFlags.contains(.shift) { model.toggleInSplit(id) }
                            else { model.visible = [id]; model.focus(id) }
                        } label: {
                            HStack(spacing: 6) {
                                let need = model.sessions[id]?.attention
                                let dot = need == .waiting ? Theme.red : (need == .done ? Theme.amber : (running ? Theme.green : Theme.textTertiary))
                                Circle().fill(dot).frame(width: 7, height: 7)
                                    .shadow(color: running || need != nil ? dot : .clear, radius: 4)
                                if let p = model.sessions[id].flatMap({ model.store.project($0.projectID) }) {
                                    ProjectIconView(project: p, size: 16)
                                }
                                Text(model.sessions[id]?.label ?? id).lineLimit(1)
                                Color.clear.frame(width: 12, height: 1) // room for the close button
                            }
                        }
                        .buttonStyle(GlassButtonStyle(active: shown))
                        .help("Click to show. Shift-click to add to the split.")
                        .contextMenu {
                            if model.sessions[id]?.spawn == nil {
                                Button("Start New Conversation") { model.restart(id, fresh: true); model.visible = [id]; model.focus(id) }
                            }
                            Button("End Session") { model.endSession(id) }
                        }
                        .overlay(alignment: .trailing) {
                            Button { model.endSession(id) } label: {
                                Image(systemName: "xmark").font(.system(size: 8.5, weight: .bold)).frame(width: 18, height: 18).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.trailing, 5)
                            .help("End this session. Opening the project again picks the conversation back up.")
                            .accessibilityLabel("End session \(model.sessions[id]?.label ?? "")")
                        }
                    }
                    newSessionMenu
                }
            }
            .scrollIndicators(.never)
            Spacer(minLength: 0)
            UpdatePill()
            Button { voice.speakReplies.toggle() } label: {
                Image(systemName: voice.speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill")
            }
            .buttonStyle(GlassButtonStyle(active: voice.speakReplies, compact: true))
            .help(voice.speakReplies
                  ? "Agents read short replies aloud after you dictate. Voice: \(voice.chosenVoice?.name ?? "system default"). Sessions started from now on follow this setting. \(VoiceOption.upgradeHint(for: voice.chosenVoice) ?? "")"
                  : "Spoken replies are off")
            .accessibilityLabel("Spoken replies")
        }
        .padding(.leading, 86).padding(.trailing, 14).padding(.top, 9).padding(.bottom, 9)
        .background(Color.black.opacity(0.25))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
    }
}

extension SessionBar {
    /// Opens another project beside what you have, without going back to the dashboard.
    private var newSessionMenu: some View {
        Menu {
            ForEach(model.projectsWithoutSession) { project in
                Button(project.name) { model.openSessions(model.visible + [project.id]) }
                    .disabled(model.visible.count >= DashSelection.maxPanes)
            }
            if !model.projectsWithoutSession.isEmpty { Divider() }
            Button("Add a Folder…") { model.chooseFolders() }
        } label: {
            Image(systemName: "plus").font(.system(size: 11, weight: .bold))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .padding(.horizontal, 6)
        .help("Open a session for another project")
        .accessibilityLabel("New session")
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

    private var inspectorHidden: Bool { model.hiddenInspectors.contains(sessionKey) }
    private var name: String { URL(fileURLWithPath: projectID).lastPathComponent }
    private var tier: Tier { model.store.project(projectID)?.tier ?? .soon }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.gradient(tier)).frame(height: 2)
            header
            GeometryReader { geo in
                // A narrow pane cannot give up the room, so there it slides over the terminal, closed until asked.
                let roomy = geo.size.width >= Self.pushBelow
                let showInspector = roomy ? !inspectorHidden : model.hiddenInspectors.contains("\(sessionKey)#open")
                HStack(spacing: 0) {
                    terminal
                    if roomy && showInspector {
                        InspectorView(projectID: projectID).frame(width: inspectorWidth(geo.size.width))
                            .transition(.move(edge: .trailing))
                    }
                }
                .overlay(alignment: .trailing) {
                    if !roomy && showInspector {
                        InspectorView(projectID: projectID)
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
        let snap = model.state(for: projectID).snapshot
        return HStack(spacing: 10) {
            if let p = model.store.project(projectID) { ProjectIconView(project: p, size: 20) }
            Text(name).font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Theme.gradient(tier)).lineLimit(1).fixedSize()
            if let phase = model.sessions[sessionKey]?.phase, model.sessions[sessionKey]?.isRunning == true {
                switch phase {
                case "working": WorkingIndicator()
                case "waiting": Pill(text: "Needs you", symbol: "bell.fill", color: Theme.red)
                default: Pill(text: "Done", symbol: "checkmark", color: Theme.green)
                }
            }
            if let spawn {
                Pill(text: "spin-off", symbol: "arrow.triangle.branch", color: Theme.cyan)
                Text(spawn.title).font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            } else if let goal = snap?.goal(snap?.currentGoal) {
                Text(goal.title).font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            MicButton(listening: listeningHere) { model.pressVoice(for: sessionKey) }
            Button { toggleInspector() } label: { Image(systemName: "sidebar.right") }
                .buttonStyle(IconButtonStyle()).help("Show or hide goals and tasks").accessibilityLabel("Goals and tasks")
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
            for key in [sessionKey, "\(sessionKey)#open"] {
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
