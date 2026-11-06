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
        if let files = fm.enumerator(at: folder.appendingPathComponent("Sources"), includingPropertiesForKeys: [.contentModificationDateKey]) {
            for case let url as URL in files { note(url) }
        }
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
            WorkingIndicator(label: "Building update").help("Your sessions are not affected.")
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
