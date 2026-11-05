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
            let count = model.needingAttention.count
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
    private var rightOptionWasDown = false
    private static let rightOptionKey: UInt16 = 61

    @MainActor func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .flagsChanged, .keyDown]) { [weak self] event in
            nonisolated(unsafe) let event = event
            return MainActor.assumeIsolated { self?.handle(event) ?? event }
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
            model.lastClickHadShift = event.modifierFlags.contains(.shift)
        case .flagsChanged:
            let shift = event.modifierFlags.contains(.shift)
            if shiftWasDown && !shift { model.shiftReleased() }
            shiftWasDown = shift
            if event.keyCode == Self.rightOptionKey {
                let down = event.modifierFlags.contains(.option)
                if down && !rightOptionWasDown { model.pressVoice() }
                rightOptionWasDown = down
            }
        case .keyDown:
            if event.keyCode == 53 { // Esc
                if model.voice.machine.state != .idle { model.voice.cancel(); return nil }
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

    @MainActor func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let running = AppModel.shared.sessions.values.filter(\.isRunning).count
        guard running > 0, !Driver.isActive else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = running == 1 ? "1 session is still running" : "\(running) sessions are still running"
        alert.informativeText = "Quitting ends them. You can resume a conversation later from a project's menu."
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
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
            if let id = model.iconTarget { IconPicker(projectID: id) }
        }
        .animation(.spring(duration: 0.34), value: model.route)
        .animation(.spring(duration: 0.3), value: model.setupTarget)
        .animation(.spring(duration: 0.3), value: model.iconTarget)
        .animation(.spring(duration: 0.3), value: model.voice.machine)
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

/// What the microphone is hearing, drawn as sound, with a way out of it.
struct VoiceBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let voice = model.voice
        if voice.machine.state != .idle {
            HStack(spacing: 16) {
                Waveform(level: voice.isListening ? voice.level : 0.2, bars: 20, height: 34)
                Text(voice.partial.isEmpty ? (voice.isListening ? "Listening…" : "Sending…") : voice.partial)
                    .lineLimit(3).font(.system(size: 15, weight: .medium))
                    .foregroundStyle(voice.partial.isEmpty ? Theme.textSecondary : Theme.textPrimary)
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Right Option to send").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.textSecondary)
                    Text("Esc to cancel").font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
                }
                .fixedSize()
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .frame(maxWidth: 760)
            .background(Color(hex: 0x14162A).opacity(0.97), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.hot, lineWidth: 1.5))
            .shadow(color: Color(hex: 0xFF4D6D).opacity(0.45), radius: 26, y: 6)
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
