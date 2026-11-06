import AppKit
import GenlockCore
import SwiftUI

struct Celebration: Equatable {
    let title: String
    let project: String
    let summary: String
    let tier: Tier

    init(goal: Snapshot.Goal, project: String, tier: Tier) {
        title = goal.title
        self.project = project
        summary = GoalCompletion.summary(goal)
        self.tier = tier
    }
}

/// Covers the screen you are looking at, without taking the keyboard from whatever you are in. It
/// lives in its own window for that: a view inside the app would only cover the app.
@MainActor
enum CelebrationPresenter {
    private static let showFor: TimeInterval = 8
    private static var panel: CelebrationPanel?
    private static var waiting: [Celebration] = []
    private static var timer: DispatchWorkItem?
    private(set) static var current: Celebration?
    private(set) static var shownTitles: [String] = []

    static var isShowing: Bool { panel != nil }
    static var frameDescription: String { panel.map { "\($0.frame)" } ?? "" }

    static func show(_ celebration: Celebration) {
        if panel == nil { present(celebration) } else { waiting.append(celebration) }
    }

    private static func present(_ celebration: Celebration) {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let window = CelebrationPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: CelebrationView(celebration: celebration, waiting: waiting.count))
        window.setFrame(screen.frame, display: true)
        window.alphaValue = 0
        window.orderFrontRegardless()
        // A test run still goes through all of this, without covering the screen of whoever is here.
        if !Driver.isActive {
            NSAnimationContext.runAnimationGroup { $0.duration = 0.25; window.animator().alphaValue = 1 }
            NSSound(named: "Hero")?.play()
        }
        panel = window
        current = celebration
        shownTitles.append(celebration.title)
        let close = DispatchWorkItem { MainActor.assumeIsolated { dismiss() } }
        timer = close
        DispatchQueue.main.asyncAfter(deadline: .now() + showFor, execute: close)
    }

    static func dismiss() {
        guard let window = panel else { return }
        timer?.cancel()
        panel = nil
        current = nil
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; window.animator().alphaValue = 0 }, completionHandler: {
            MainActor.assumeIsolated {
                window.orderOut(nil)
                if panel == nil, !waiting.isEmpty { present(waiting.removeFirst()) }
            }
        })
    }

    /// A click through the path a mouse takes, for testing.
    static func clickForTest() {
        guard let window = panel, let e = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 200, y: 200), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                             windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
        window.sendEvent(e)
    }

    static func capture(to path: String) {
        guard let view = panel?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}

/// Any click ends it. Never key or main, so keystrokes stay with the app you are using.
final class CelebrationPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown || event.type == .rightMouseDown {
            MainActor.assumeIsolated { CelebrationPresenter.dismiss() }
        } else {
            super.sendEvent(event)
        }
    }
}

struct CelebrationView: View {
    let celebration: Celebration
    let waiting: Int
    @State private var arrived = false
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    var body: some View {
        let tint = Theme.tint(celebration.tier)
        ZStack {
            Theme.canvas.opacity(0.94)
            RadialGradient(colors: [tint[0].opacity(0.45), tint[1].opacity(0.16), .clear], center: .center, startRadius: 40, endRadius: 760)
            if !reduceMotion { ConfettiView() }
            VStack(spacing: 22) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 112, weight: .semibold))
                    .foregroundStyle(LinearGradient(colors: tint, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .shadow(color: tint[0].opacity(0.8), radius: 34)
                    .scaleEffect(arrived || reduceMotion ? 1 : 0.3)
                Text("GOAL COMPLETE").font(.system(size: 20, weight: .heavy)).tracking(6).foregroundStyle(Theme.textSecondary)
                Text(celebration.title)
                    .font(.system(size: 66, weight: .heavy, design: .rounded)).foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.center).lineLimit(3).minimumScaleFactor(0.5)
                    .frame(maxWidth: 1100)
                Text([celebration.project, celebration.summary].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 22, weight: .medium)).foregroundStyle(Theme.textSecondary)
            }
            .padding(60)
            .opacity(arrived || reduceMotion ? 1 : 0)
            VStack {
                Spacer()
                Text(waiting > 0 ? "Click to see the next one" : "Click anywhere to carry on")
                    .font(.system(size: 14)).foregroundStyle(Theme.textTertiary).padding(.bottom, 44)
            }
        }
        .ignoresSafeArea()
        .onAppear { withAnimation(.spring(duration: 0.55, bounce: 0.45)) { arrived = true } }
    }
}

/// Bursts from both bottom corners, then a fall from the top. Drawn rather than animated view by
/// view, because this is hundreds of pieces at the frame rate.
private struct ConfettiView: View {
    private struct Piece {
        var fromLeft: Bool?
        var x: Double, speedX: Double, speedY: Double, delay: Double
        var spin: Double, flutter: Double, width: Double, height: Double
        var color: Color
    }

    private static let colors: [Color] = [Theme.cyan, Theme.violet, Theme.green, Theme.amber, Theme.red, .white]
    private static let gravity = 900.0
    private static let lasts = 7.5

    private let start = Date()
    private let pieces: [Piece] = (0..<320).map { i in
        let cannon = i < 150
        return Piece(fromLeft: cannon ? i % 2 == 0 : nil,
                     x: .random(in: 0...1),
                     speedX: cannon ? .random(in: 150...850) : .random(in: -30...30),
                     speedY: cannon ? .random(in: 700...1500) : .random(in: 160...360),
                     delay: cannon ? .random(in: 0...0.35) : .random(in: 0.3...4.5),
                     spin: .random(in: -7...7), flutter: .random(in: 4...11),
                     width: .random(in: 7...14), height: .random(in: 10...20),
                     color: colors[i % colors.count])
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSince(start)
                let fade = min(1, max(0, (Self.lasts - t) / 1.2))
                guard fade > 0 else { return }
                context.opacity = fade
                for piece in pieces {
                    let age = t - piece.delay
                    guard age > 0 else { continue }
                    let x, y: Double
                    if let left = piece.fromLeft {
                        x = left ? piece.speedX * age : size.width - piece.speedX * age
                        y = size.height - piece.speedY * age + 0.5 * Self.gravity * age * age
                    } else {
                        x = piece.x * size.width + piece.speedX * age + sin(age * 2 + piece.spin) * 26
                        y = -24 + piece.speedY * age
                    }
                    guard y < size.height + 30, x > -30, x < size.width + 30 else { continue }
                    var c = context
                    c.translateBy(x: x, y: y)
                    c.rotate(by: .radians(piece.spin * age))
                    c.scaleBy(x: cos(age * piece.flutter), y: 1)
                    c.fill(Path(CGRect(x: -piece.width / 2, y: -piece.height / 2, width: piece.width, height: piece.height)), with: .color(piece.color))
                }
            }
        }
        .allowsHitTesting(false)
    }
}
