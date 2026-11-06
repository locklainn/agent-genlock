import AppKit
import GenlockCore
import SwiftUI
import UserNotifications

/// macOS notifications for sessions that are done or need you. Each session has one at most,
/// which clears itself once you have seen that session.
enum Notifier {
    static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    @MainActor static func post(session: TerminalSession, attention: Attention) {
        // Only an app bundle can post notifications, and the center throws outside one.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(session.label) \(attention.headline)"
        let goal = AppModel.shared.state(for: session.projectID).snapshot.flatMap { CardSummary($0).goalTitle }
        content.body = session.attentionMessage.isEmpty ? (goal ?? "Click to go to this session.") : session.attentionMessage
        content.sound = .default
        content.userInfo = ["session": session.key]
        let request = UNNotificationRequest(identifier: session.key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            guard error != nil else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    AppModel.shared.message = "Genlock could not show a notification. Allow it in System Settings, Notifications, Genlock."
                }
            }
        }
    }

    static func clear(_ key: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
    }
}

/// The menu bar icon: the genlock signal, with a red dot when a session needs you.
enum MenuBarIcon {
    static func image(alert: Bool) -> NSImage {
        let size = NSSize(width: 20, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            NSColor.labelColor.setStroke()
            for row in 0..<3 {
                let y = 2.75 + CGFloat(row) * 4.0
                let path = NSBezierPath()
                path.lineWidth = 1.3
                path.lineJoinStyle = .round
                path.move(to: NSPoint(x: 1, y: y))
                for k in 0..<2 {
                    let x = 1 + CGFloat(k) * 7
                    path.line(to: NSPoint(x: x + 3.5, y: y))
                    path.line(to: NSPoint(x: x + 3.5, y: y + 2.5))
                    path.line(to: NSPoint(x: x + 7, y: y + 2.5))
                    path.line(to: NSPoint(x: x + 7, y: y))
                }
                path.stroke()
            }
            if alert {
                NSColor.systemRed.setFill()
                NSBezierPath(ovalIn: NSRect(x: 13, y: 8.5, width: 7, height: 7)).fill()
            }
            return true
        }
        // A red dot cannot be a template, and a drawn label colour follows the menu bar's appearance either way.
        image.isTemplate = !alert
        return image
    }
}

/// What the menu bar icon opens: who needs you first, then everything else running.
struct MenuBarMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let needing = model.needingAttention
        if needing.isEmpty {
            Text("No session needs you")
        } else {
            Text(needing.count == 1 ? "1 session needs you" : "\(needing.count) sessions need you")
            ForEach(needing, id: \.key) { session in
                Button("\(session.label) \(session.attention?.headline ?? "")") { model.showSession(session.key) }
            }
        }
        let others = model.sessions.values.filter { $0.isRunning && $0.attention == nil }.sorted { $0.key < $1.key }
        if !others.isEmpty {
            Divider()
            ForEach(others, id: \.key) { session in
                Button(session.label) { model.showSession(session.key) }
            }
        }
        Divider()
        Button("Open Genlock") {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "main")
            model.route = .dashboard
        }
        Button("Quit Genlock") { NSApp.terminate(nil) }
    }
}
