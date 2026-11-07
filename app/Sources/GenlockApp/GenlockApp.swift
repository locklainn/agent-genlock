import AppKit
import GenlockCore
import SwiftUI
import UserNotifications

@main
struct GenlockApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        Window("Genlock", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 980, minHeight: 620)
        }
        .defaultSize(width: 1360, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Add Project…") { model.chooseFolders() }.keyboardShortcut("o")
            }
            CommandMenu("Session") {
                Button("Show Dashboard") { model.route = .dashboard }.keyboardShortcut("0")
                Button("Focus on TODAY") { model.focusDashboard(.today) }.keyboardShortcut("1")
                Button("Focus on SOON") { model.focusDashboard(.soon) }.keyboardShortcut("2")
                Button("Focus on LATER") { model.focusDashboard(.later) }.keyboardShortcut("3")
                Button("Show All Tiers") { model.focusDashboard(.all) }.keyboardShortcut("4")
                Divider()
                Button("Talk to Agent") { model.pressVoice() }.keyboardShortcut("d", modifiers: [.command, .shift])
                Button(model.voice.speakReplies ? "Turn Spoken Replies Off" : "Turn Spoken Replies On") {
                    model.voice.speakReplies.toggle()
                }
                Button("Stop Speaking") { model.voice.stopSpeaking() }.keyboardShortcut(".", modifiers: [.command, .shift])
            }
        }

        MenuBarExtra {
            MenuBarMenu().environment(model)
        } label: {
            let count = model.alertCount
            HStack(spacing: 3) {
                Image(nsImage: MenuBarIcon.image(alert: count > 0))
                if count > 0 { Text("\(count)") }
            }
            .accessibilityLabel(count > 0 ? "Genlock, \(count) need you" : "Genlock")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var monitor: Any?
    private var shiftWasDown = false
    private var commandTap = CleanTap()
    private static let rightArrowKey: UInt16 = 124

    @MainActor func applicationDidFinishLaunching(_ note: Notification) {
        // A scripted test run stays in the background, so whoever is working is not interrupted.
        // Steps that post real clicks or keys need the front: GENLOCK_APP_FOREGROUND=1.
        if Driver.isActive && ProcessInfo.processInfo.environment["GENLOCK_APP_FOREGROUND"] == nil {
            NSApp.setActivationPolicy(.accessory)
        } else {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .flagsChanged, .keyDown, .keyUp]) { [weak self] event in
            nonisolated(unsafe) let event = event
            // A nil from handle means the event was used up, so it must not fall back to the event.
            return MainActor.assumeIsolated {
                guard let self else { return event }
                return self.handle(event)
            }
        }
        AppModel.shared.boot()
        // Only an app bundle can post notifications, and the center throws outside one.
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().delegate = self
            Notifier.requestPermission()
        }
        Driver.runIfRequested()
    }

    @MainActor private func handle(_ event: NSEvent) -> NSEvent? {
        let model = AppModel.shared
        switch event.type {
        case .leftMouseDown:
            commandTap.interrupted()
            model.lastClickHadShift = event.modifierFlags.contains(.shift)
        case .flagsChanged:
            let shift = event.modifierFlags.contains(.shift)
            if shiftWasDown && !shift { model.shiftReleased() }
            shiftWasDown = shift
            // A modifier's own flag says whether this event was it going down or coming up.
            let flag: NSEvent.ModifierFlags = event.keyCode == VoiceMachine.rightOptionKey ? .option : .command
            switch VoiceMachine.keyAction(keyCode: event.keyCode, isDown: event.modifierFlags.contains(flag), state: model.voice.machine.state) {
            case .press: model.pressVoice()
            case .cancel: model.voice.cancel()
            case .none: break
            }
            if event.keyCode == VoiceMachine.rightCommandKey {
                if event.modifierFlags.contains(.command) {
                    // Pressed to cancel dictation, it has done its job.
                    if model.voice.machine.state == .idle { commandTap.down() } else { commandTap.interrupted() }
                } else if commandTap.up() {
                    switch VoiceMachine.tapAction(waiting: model.voice.waitingReplies, isSpeaking: model.voice.isSpeaking, canReplay: model.voice.canReplay) {
                    case .hear: model.hearReplies()
                    case .stop: model.voice.stopSpeaking()
                    case .replay: model.voice.replayLast()
                    case .none: break
                    }
                }
            } else {
                commandTap.interrupted()
            }
        case .keyUp:
            if event.keyCode == Self.rightArrowKey && model.voice.speedHeld {
                model.voice.holdSpeed(false)
                return nil
            }
        case .keyDown:
            commandTap.interrupted()
            // Whatever was being typed should not land in a session unseen behind the celebration.
            if CelebrationPresenter.isShowing {
                CelebrationPresenter.dismiss()
                return nil
            }
            // While it talks the right arrow speeds it up, instead of reaching the terminal.
            if event.keyCode == Self.rightArrowKey && (model.voice.isSpeaking || model.voice.speedHeld) {
                model.voice.holdSpeed(true)
                return nil
            }
            if event.keyCode == 53 { // Esc
                switch VoiceMachine.escapeAction(state: model.voice.machine.state, isSpeaking: model.voice.isSpeaking,
                                                 waiting: model.voice.waitingReplies, hasReply: model.voice.replyTo != nil) {
                case .cancelDictation: model.voice.cancel(); return nil
                case .stopSpeaking: model.voice.stopSpeaking(); return nil
                case .dismissWaiting: model.dismissReplies(); return nil
                case .dismissReply: model.voice.dismissReply(); return nil
                case .none: break
                }
                if model.route == .dashboard && model.markedCount > 0 { model.clearMarks(); return nil }
            }
            if model.route == .dashboard, event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
               let id = model.hoveredCard, let chars = event.charactersIgnoringModifiers {
                let tier: Tier? = ["1": .today, "2": .soon, "3": .later][chars]
                if let tier { model.move(id, to: tier); return nil }
            }
        default:
            break
        }
        return event
    }

    /// Banners still show while Genlock is in front, for a session you are not looking at.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completion: @escaping () -> Void) {
        let key = response.notification.request.content.userInfo["session"] as? String
        DispatchQueue.main.async {
            MainActor.assumeIsolated { if let key { AppModel.shared.showSession(key) } }
            completion()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ZStack(alignment: .bottom) {
            Aurora(intensity: model.route == .dashboard ? 1 : 0.35)
            Group {
                if model.route == .dashboard {
                    DashboardView().transition(.opacity.combined(with: .scale(scale: 0.985)))
                } else {
                    SessionsView().transition(.opacity.combined(with: .scale(scale: 1.012)))
                }
            }
            .ignoresSafeArea(edges: .top)
            VStack(spacing: 10) {
                VoiceBanner()
                if let message = model.message { MessageBanner(text: message) { model.message = nil } }
            }
            .padding(.bottom, 20)
            if let id = model.setupTarget { SetupSheet(projectID: id) }
            if let completing = model.completingGoal { CompleteGoalSheet(completing: completing) }
            if model.showingCompleted { CompletedGoalsSheet() }
            if model.askingAssistantName { NameAssistantSheet() }
            if let id = model.iconTarget { IconPicker(projectID: id) }
        }
        .animation(.spring(duration: 0.34), value: model.route)
        .animation(.spring(duration: 0.3), value: model.setupTarget)
        .animation(.spring(duration: 0.3), value: model.iconTarget)
        .animation(.spring(duration: 0.3), value: model.voice.machine)
        .animation(.spring(duration: 0.3), value: model.voice.speakingText)
        .animation(.spring(duration: 0.3), value: model.voice.replyTo)
        .animation(.spring(duration: 0.3), value: model.voice.waitingReplies)
        .preferredColorScheme(.dark)
        .onAppear { model.openMainWindow = { openWindow(id: "main") } }
        .dropDestination(for: URL.self) { urls, _ in
            let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            for url in folders { model.addProject(path: url.path) }
            return !folders.isEmpty
        }
    }
}

struct MessageBanner: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(text).font(.system(size: 13)).foregroundStyle(Theme.textPrimary).textSelection(.enabled)
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle()).accessibilityLabel("Dismiss")
        }
        .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
        .background(Color(hex: 0x171A28), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.5), radius: 14, y: 4)
        .frame(maxWidth: 680)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// An update you can answer from here, without opening its project.
struct ReplyBanner: View {
    let reply: ReplyTarget
    let voice: VoiceController
    let from: String
    @State private var typed = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                if voice.isSpeaking {
                    Waveform(level: 0.7, bars: 14, height: 30, colors: [Theme.cyan, Color(hex: 0x7C5CFF)])
                } else {
                    Image(systemName: "bubble.left.fill").font(.system(size: 18)).foregroundStyle(Theme.cyan).frame(height: 30)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(from).font(.system(size: 11.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.cyan)
                    Text(reply.text.hasPrefix("\(from). ") ? String(reply.text.dropFirst(from.count + 2)) : reply.text)
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                Spacer(minLength: 8)
                Button {
                    if voice.isSpeaking { voice.stopSpeaking() } else { voice.dismissReply() }
                } label: { Image(systemName: voice.isSpeaking ? "stop.fill" : "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .help(voice.isSpeaking ? "Stop speaking" : "Dismiss")
                    .accessibilityLabel(voice.isSpeaking ? "Stop speaking" : "Dismiss this update")
            }
            HStack(spacing: 10) {
                TextField("Type a reply to \(from), or press right ⌥ to talk", text: $typed)
                    .textFieldStyle(.plain).font(.system(size: 13))
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Color.white.opacity(0.07), in: Capsule())
                    .onSubmit { send() }
                Text(voice.isSpeaking ? (voice.speedHeld ? "Faster" : "Esc to stop · Hold → for faster") : (voice.canReplay ? "Right ⌘ to replay · Esc to close" : "Esc to close"))
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(voice.speedHeld ? Theme.cyan : Theme.textSecondary).fixedSize()
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .frame(maxWidth: 760)
        .background(Color(hex: 0x14162A).opacity(0.97), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.cyan, lineWidth: 1.5))
        .shadow(color: Theme.cyan.opacity(0.35), radius: 26, y: 6)
    }

    private func send() {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { voice.sendReply(text) }
    }
}

/// What the microphone is hearing, drawn as sound, with a way out of it.
struct VoiceBanner: View {
    @Environment(AppModel.self) private var model

    /// A reply that came from nowhere you can answer, such as trying out the speed.
    @ViewBuilder private func speakingBanner(_ spoken: String, voice: VoiceController) -> some View {
        HStack(spacing: 16) {
            Waveform(level: 0.7, bars: 14, height: 30, colors: [Theme.cyan, Color(hex: 0x7C5CFF)])
            Text(spoken).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text("Right ⌘ or Esc to stop").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textSecondary)
                Text(voice.speedHeld ? "Faster" : "Hold → for faster").font(.system(size: 11)).foregroundStyle(voice.speedHeld ? Theme.cyan : Theme.textTertiary)
            }
            .fixedSize()
            Button { voice.stopSpeaking() } label: { Image(systemName: "stop.fill") }
                .buttonStyle(IconButtonStyle())
                .help("Stop speaking")
                .accessibilityLabel("Stop speaking")
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .frame(maxWidth: 760)
        .background(Color(hex: 0x14162A).opacity(0.97), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.cyan, lineWidth: 1.5))
        .shadow(color: Theme.cyan.opacity(0.35), radius: 26, y: 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    var body: some View {
        let voice = model.voice
        if voice.machine.state != .idle {
            VStack(alignment: .leading, spacing: 10) {
            if let reply = voice.replyTo, reply.session == voice.target {
                let from = model.sessions[reply.session]?.label ?? "That session"
                VStack(alignment: .leading, spacing: 2) {
                    Text(from).font(.system(size: 11.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.cyan)
                    Text(reply.text.hasPrefix("\(from). ") ? String(reply.text.dropFirst(from.count + 2)) : reply.text)
                        .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                Rectangle().fill(Theme.hairline).frame(height: 1)
            }
            HStack(spacing: 16) {
                Waveform(level: voice.isListening ? voice.level : 0.2, bars: 20, height: 34)
                if let target = voice.target, target != model.focusedProject, let label = model.sessions[target]?.label {
                    Text("To \(label)").font(.system(size: 11.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.cyan).fixedSize()
                }
                Text(voice.partial.isEmpty ? (voice.isListening ? "Listening…" : "Sending…") : VoiceTranscript.latest(voice.partial))
                    .lineLimit(3).truncationMode(.head).font(.system(size: 15, weight: .medium))
                    .foregroundStyle(voice.partial.isEmpty ? Theme.textSecondary : Theme.textPrimary)
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Right ⌥ to send").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textSecondary)
                    Text("Right ⌘ to cancel").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                }
                .fixedSize()
                Button { voice.cancel() } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .help("Cancel without sending (right ⌘ or Esc)")
                    .accessibilityLabel("Cancel dictation")
            }
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .frame(maxWidth: 760)
            .background(Color(hex: 0x14162A).opacity(0.97), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.hot, lineWidth: 1.5))
            .shadow(color: Color(hex: 0xFF4D6D).opacity(0.45), radius: 26, y: 6)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let spoken = voice.speakingText, voice.replyTo == nil {
            speakingBanner(spoken, voice: voice)
        } else if voice.waitingReplies > 0 && !voice.isSpeaking {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge.fill").font(.system(size: 16)).foregroundStyle(Theme.cyan)
                Text(VoiceMachine.updateNotice(from: voice.waitingFrom, count: voice.waitingReplies))
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Text("Right ⌘ to hear · Esc to dismiss").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textSecondary).fixedSize()
                Button { model.hearReplies() } label: { Image(systemName: "play.fill") }
                    .buttonStyle(IconButtonStyle())
                    .help("Hear it")
                    .accessibilityLabel("Hear the update")
                Button { model.dismissReplies() } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .help("Dismiss without hearing it (Esc). Right ⌘ can still replay it.")
                    .accessibilityLabel("Dismiss the update")
            }
            .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 8)
            .background(Color(hex: 0x14162A).opacity(0.97), in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.cyan.opacity(0.8), lineWidth: 1.5))
            .shadow(color: Theme.cyan.opacity(0.3), radius: 18, y: 4)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let reply = voice.replyTo {
            ReplyBanner(reply: reply, voice: voice, from: model.sessions[reply.session]?.label ?? "That session")
                .id(reply.text)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let problem = voice.problem {
            VStack(spacing: 8) {
                MessageBanner(text: problem) { voice.problem = nil }
                if voice.needsDictationSetting {
                    Button("Open Keyboard Settings") { voice.openDictationSettings() }.buttonStyle(GlowButtonStyle())
                }
            }
        }
    }
}

enum Status {
    static func label(_ status: String) -> String {
        switch status {
        case "in_progress": return "In progress"
        default: return status.prefix(1).uppercased() + status.dropFirst()
        }
    }
}
