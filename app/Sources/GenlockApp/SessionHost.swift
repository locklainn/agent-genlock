import Foundation

/// The small program that keeps a session alive when the app is not. See Sources/GenlockHost.
enum SessionHost {
    static var executable: String? {
        let path = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("genlock-host").path
        return path.flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
    }

    static func socket(in folder: URL) -> String { folder.appendingPathComponent("host.sock").path }

    static func isAlive(socket: String) -> Bool { run("probe", socket) }

    /// Ends the program in the session. This is the only thing that does.
    static func end(socket: String) { _ = run("kill", socket) }

    private static func run(_ verb: String, _ socket: String) -> Bool {
        guard let executable, FileManager.default.fileExists(atPath: socket) else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = [verb, socket]
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
