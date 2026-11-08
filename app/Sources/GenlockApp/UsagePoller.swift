import Foundation
import GenlockCore

/// Asks the server for the plan's usage bars, the same endpoint /usage reads, with the token
/// Claude Code keeps in the keychain. Sessions in the app print no status line, because even an
/// empty one keeps a blank row under the input box, so this is where the meter's numbers come from.
///
/// The endpoint answers 429 when polled every minute (measured 7 October 2026 by the budget
/// repo's usage governor), so it is asked every 150 seconds and not at all for 10 minutes after
/// a refusal. A failure writes nothing: the meter keeps the last reading rather than a guess.
/// An expired token is not renewed here; the next model call in any session renews it.
@MainActor
final class UsagePoller {
    static let every: TimeInterval = 150
    static let backoff: TimeInterval = 600

    private var timer: Timer?
    private var quietUntil = Date.distantPast
    private var inFlight = false

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: Self.every, repeats: true) { _ in
            MainActor.assumeIsolated { AppModel.shared.usagePoller.poll() }
        }
    }

    func poll() {
        guard !inFlight, Date() >= quietUntil else { return }
        inFlight = true
        Task.detached(priority: .utility) {
            let result = await Self.fetch()
            await MainActor.run {
                let poller = AppModel.shared.usagePoller
                poller.inFlight = false
                switch result {
                case .reading(let r):
                    try? r.save()
                    if r != AppModel.shared.usage { AppModel.shared.usage = r }
                case .refused:
                    poller.quietUntil = Date().addingTimeInterval(Self.backoff)
                case .failed:
                    break
                }
            }
        }
    }

    private enum Result { case reading(UsageReading), refused, failed }

    private nonisolated static func fetch() async -> Result {
        guard let token = keychainToken() else { return .failed }
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("claude-cli", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: req) else { return .failed }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 429 { return .refused }
        guard status == 200, let reading = UsageReading.fromServer(data) else { return .failed }
        return .reading(reading)
    }

    /// Claude Code's own access token. Never logged, never written anywhere.
    private nonisolated static func keychainToken() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        p.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-w"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = json["claudeAiOauth"] as? [String: Any] else { return nil }
        return oauth["accessToken"] as? String
    }
}
