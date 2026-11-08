import AppKit
import GenlockCore
import SwiftUI

/// Builds the app from its own source whenever that changes, then offers a restart. Only a build
/// made by scripts/build.sh knows where its source is, so anything else leaves this off.
@MainActor @Observable
final class AppUpdater {
    enum State: Equatable { case idle, building, ready, failed(String) }

    private(set) var state = State.idle
    @ObservationIgnored private var lastAttempt: TimeInterval?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private let appFolder: URL?
    @ObservationIgnored private let builtAt: TimeInterval

    init() {
        let info = Bundle.main.infoDictionary
        appFolder = (info?["GenlockSourceRoot"] as? String).map { URL(fileURLWithPath: $0) }
        builtAt = info?["GenlockBuiltAt"] as? TimeInterval ?? 0
    }

    func start() {
        guard appFolder != nil else { return }
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            MainActor.assumeIsolated { AppModel.shared.updater.check() }
        }
    }

    private var builtApp: URL? { appFolder?.appendingPathComponent("build/Genlock.app") }

    private func check() {
        guard let appFolder, state != .building, let newest = Self.newestSource(in: appFolder) else { return }
        // Read from the file, because Bundle caches what it read the first time.
        let plist = builtApp.flatMap { NSDictionary(contentsOf: $0.appendingPathComponent("Contents/Info.plist")) }
        let available = plist?["GenlockBuiltAt"] as? TimeInterval
        switch AppUpdate.next(running: builtAt, available: available, newestSource: newest, lastAttempt: lastAttempt, now: Date().timeIntervalSince1970) {
        case .build: build(in: appFolder)
        case .offerRestart: state = .ready
        case .nothing: break
        }
    }

    private func build(in folder: URL) {
        state = .building
        lastAttempt = Date().timeIntervalSince1970
        let environment = AppModel.shared.tools?.environment
        Task.detached {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["scripts/build.sh"]
            p.currentDirectoryURL = folder
            if let environment { p.environment = environment }
            let log = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-build.log")
            FileManager.default.createFile(atPath: log.path, contents: nil)
            let handle = try? FileHandle(forWritingTo: log)
            p.standardOutput = handle
            p.standardError = handle
            var ok = false
            if (try? p.run()) != nil {
                p.waitUntilExit()
                ok = p.terminationStatus == 0
            }
            let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
            await MainActor.run {
                self.state = ok ? .idle : .failed(AppUpdate.failure(from: text))
                if ok { self.check() }
            }
        }
    }

    func restart() {
        guard state == .ready, let builtApp else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", AppUpdate.swapScript, "swap", "\(getpid())", builtApp.path, Bundle.main.bundlePath]
        guard (try? p.run()) != nil else {
            state = .failed("Could not start the update.")
            return
        }
        NSApp.terminate(nil)
    }

    private static func newestSource(in folder: URL) -> TimeInterval? {
        let fm = FileManager.default
        var newest: TimeInterval?
        func note(_ url: URL) {
            guard let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { return }
            newest = max(newest ?? 0, date.timeIntervalSince1970)
        }
        for name in ["Package.swift", "Package.resolved", "scripts/build.sh"] { note(folder.appendingPathComponent(name)) }
        // The app carries genlock, so a change to genlock is a change to the app.
        let repo = folder.deletingLastPathComponent()
        let watched = [folder.appendingPathComponent("Sources")] + ["bin", "lib", "agent", "skills", "docs"].map { repo.appendingPathComponent($0) }
        for root in watched {
            guard let files = fm.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for case let url as URL in files { note(url) }
        }
        note(repo.appendingPathComponent("install.mjs"))
        return newest
    }
}

/// Appears only when there is something to know.
struct UpdatePill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.updater.state {
        case .idle:
            EmptyView()
        case .building:
            EmptyView() // Building is quiet; only a finished update asks for anything.
        case .ready:
            Button("Restart to update") { model.updater.restart() }
                .buttonStyle(GlowButtonStyle())
                .help("Your sessions keep running and reappear when Genlock reopens.")
        case .failed(let why):
            Button { model.message = "The update did not build: \(why)" } label: {
                Label("Update did not build", systemImage: "exclamationmark.triangle.fill")
            }
            .buttonStyle(GlassButtonStyle())
            .help(why)
        }
    }
}

/// The plan's usage, always in sight: the five-hour session bar and the weekly bar with a tick
/// where even pace would put it. Sessions in the app print no status line, so this replaces it.
struct UsageMeter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let usage = model.usage {
                content(usage, now: context.date)
            }
        }
    }

    /// Two short rows in one capsule: the five-hour bar, then the week with a tick at even pace.
    @ViewBuilder
    private func content(_ usage: UsageReading, now: Date) -> some View {
        let session = usage.isCurrent(usage.session, now: now) ? usage.session : nil
        let weekly = usage.isCurrent(usage.weekly, now: now) ? usage.weekly : nil
        let pace = usage.pace(now: now)
        Grid(alignment: .leading, horizontalSpacing: 5, verticalSpacing: 2) {
            if let session { line("5h", session.used, mark: nil, color: sessionColor(session.used), pace: nil) }
            if let weekly {
                let over = usage.overPace(now: now)
                line("wk", weekly.used, mark: pace, color: weeklyColor(over ?? 0), pace: over)
            }
            if session == nil && weekly == nil {
                GridRow { Text("usage –").font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary) }
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(Color.white.opacity(0.05), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
        .fixedSize()
        .help(detail(usage, session: session, weekly: weekly, pace: pace, now: now))
        .accessibilityElement(children: .combine)
    }

    private func line(_ label: String, _ used: Double, mark: Int?, color: Color, pace over: Int?) -> some View {
        GridRow {
            Text(label).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.textTertiary)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(color).frame(width: 40 * min(1, max(0, used / 100)))
                if let mark { Rectangle().fill(Theme.textPrimary).frame(width: 1.5, height: 7).offset(x: 40 * Double(mark) / 100 - 0.75) }
            }
            .frame(width: 40, height: 4)
            Text("\(Int(used.rounded()))%").font(.system(size: 10.5, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(color)
                .gridColumnAlignment(.trailing)
            // Pacing against an even week: "+6 pace" is ahead of even use, "−4 pace" under it.
            if let over {
                Text("\(over > 0 ? "+" : over < 0 ? "−" : "±")\(abs(over)) pace")
                    .font(.system(size: 9.5, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(over > 5 ? weeklyColor(over) : Theme.textSecondary)
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        }
    }

    private func sessionColor(_ used: Double) -> Color { used >= 85 ? Theme.red : used >= 60 ? Theme.amber : Theme.green }
    private func weeklyColor(_ over: Int) -> Color { over > 15 ? Theme.red : over > 5 ? Theme.amber : Theme.green }

    private func detail(_ usage: UsageReading, session: UsageReading.Bar?, weekly: UsageReading.Bar?, pace: Int?, now: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "EEE MMM d, h:mma"
        var lines: [String] = []
        if let session {
            lines.append("Session (5-hour window): \(Int(session.used.rounded()))% used" + (session.resetsAt.map { ", resets \(f.string(from: $0))" } ?? ""))
        }
        if let weekly {
            lines.append("Weekly: \(Int(weekly.used.rounded()))% used" + (weekly.resetsAt.map { ", resets \(f.string(from: $0))" } ?? ""))
        }
        if let pace, let over = usage.overPace(now: now) {
            lines.append("Even pace would be \(pace)% by now: \(over > 0 ? "\(over) points ahead of it" : over < 0 ? "\(-over) points under it" : "right on it"). The white tick marks it.")
        }
        let age = Int(now.timeIntervalSince(usage.at) / 60)
        lines.append(age < 1 ? "Read just now." : "Read \(age) min ago.")
        return lines.joined(separator: "\n")
    }
}
