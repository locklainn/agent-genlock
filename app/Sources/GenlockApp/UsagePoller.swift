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
    nonisolated static let backoff: TimeInterval = 600

    private var timer: Timer?
    /// Kept across relaunches: a restart used to poll at once and walk straight back into the limit.
    private var quietUntil = Date(timeIntervalSince1970: UserDefaults.standard.double(forKey: "usageQuietUntil")) {
        didSet { UserDefaults.standard.set(quietUntil.timeIntervalSince1970, forKey: "usageQuietUntil") }
    }
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
                case .refused(let retryAfter):
                    // The server's own Retry-After when it gives one; never sooner than our backoff.
                    poller.quietUntil = Date().addingTimeInterval(max(Self.backoff, retryAfter ?? 0))
                case .failed:
                    break
                }
            }
        }
    }

    private enum Result { case reading(UsageReading), refused(retryAfter: TimeInterval?), failed }

    /// The last attempt's outcome, never the token: Genlock/usage-poll.txt. Without it a failing
    /// poll is silent, and the meter just vanishes.
    private nonisolated static func note(_ what: String) {
        let url = UsageReading.file().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("usage-poll.txt")
        try? "\(ISO8601DateFormatter().string(from: Date())) \(what)\n".write(to: url, atomically: true, encoding: .utf8)
    }

    private nonisolated static func fetch() async -> Result {
        guard let token = keychainToken() else { note("no token from the keychain"); return .failed }
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("claude-cli", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: req) else { note("no answer from the server"); return .failed }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 429 {
            let http = response as? HTTPURLResponse
            let retry = (http?.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            let body = String(decoding: data.prefix(300), as: UTF8.self)
            note("HTTP 429, Retry-After \(retry.map { "\(Int($0))s" } ?? "none"); quiet for \(Int(max(Self.backoff, retry ?? 0) / 60)) min. Body: \(body)")
            return .refused(retryAfter: retry)
        }
        guard status == 200, let reading = UsageReading.fromServer(data) else {
            note("HTTP \(status)" + (status == 200 ? ", reply not understood" : ""))
            return .failed
        }
        note("HTTP 200, reading saved")
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
