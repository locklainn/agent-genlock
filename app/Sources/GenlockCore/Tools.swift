import Foundation

/// How to find and run `genlock` and `claude`. An app opened from Finder gets a minimal
/// PATH, and these usually live under nvm, so the environment comes from a login shell.
public struct ToolEnvironment: Equatable {
    public var environment: [String: String]
    public var genlockArgv: [String]?
    public var claudePath: String?

    public init(environment: [String: String], genlockArgv: [String]?, claudePath: String?) {
        self.environment = environment
        self.genlockArgv = genlockArgv
        self.claudePath = claudePath
    }

    /// Set by agents and test harnesses, none of which should leak into a session you open here.
    static let scrubbed: Set<String> = ["GENLOCK_SESSION", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
                                        "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ATTENDED",
                                        "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_EFFORT", "__CFBundleIdentifier", "XPC_SERVICE_NAME"]

    public static func resolve(base: [String: String] = ProcessInfo.processInfo.environment,
                               shell: String? = nil) -> ToolEnvironment {
        let loginShell = shell ?? base["SHELL"] ?? "/bin/zsh"
        var env = captureLoginEnvironment(shell: loginShell) ?? base
        for key in scrubbed { env[key] = nil }
        // A shell that printed no PATH still leaves the usual places to look.
        let fallback = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let existing = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        env["PATH"] = (existing + fallback.filter { !existing.contains($0) }).joined(separator: ":")
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        env["TERM_PROGRAM"] = "Genlock"

        var genlock: [String]?
        if let override = base["GENLOCK_APP_CLI"] {
            genlock = override.hasSuffix(".mjs") ? [which("node", path: env["PATH"]) ?? "node", override] : [override]
        } else if let found = which("genlock", path: env["PATH"]) {
            genlock = [found]
        }
        let claude = base["GENLOCK_APP_CLAUDE_CMD"] ?? which("claude", path: env["PATH"])
        return ToolEnvironment(environment: env, genlockArgv: genlock, claudePath: claude)
    }

    public static func which(_ name: String, path: String?) -> String? {
        for dir in (path ?? "").split(separator: ":") {
            let candidate = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Runs an interactive login shell once. Interactive, because nvm is usually set up in
    /// .zshrc. Startup files can print anything, so the output is taken after a marker.
    static func captureLoginEnvironment(shell: String, timeout: TimeInterval = 10) -> [String: String]? {
        let marker = "__GENLOCK_ENV_\(UUID().uuidString)__"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-ilc", "printf '%s\\0' '\(marker)'; /usr/bin/env -0"]
        p.environment = ["HOME": NSHomeDirectory(), "USER": NSUserName(), "SHELL": shell, "TERM": "dumb"]
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let out = Pipe()
        p.standardOutput = out
        do { try p.run() } catch { return nil }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        let fields = data.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }
        guard let i = fields.lastIndex(where: { $0.hasSuffix(marker) }) else { return nil }
        var env: [String: String] = [:]
        for field in fields[(i + 1)...] {
            guard let eq = field.firstIndex(of: "=") else { continue }
            env[String(field[..<eq])] = String(field[field.index(after: eq)...])
        }
        return env.isEmpty ? nil : env
    }
}

public enum SnapshotError: Error, Equatable, CustomStringConvertible {
    case genlockMissing
    case genlockTooOld
    case folderMissing
    case failed(String)

    public static let upgradeCommand = "npm install -g github:locklainn/agent-genlock"

    public var description: String {
        switch self {
        case .genlockMissing: return "genlock is not installed. Run: \(Self.upgradeCommand)"
        case .genlockTooOld: return "This version of genlock is too old for the app. Run: \(Self.upgradeCommand)"
        case .folderMissing: return "This folder no longer exists."
        case .failed(let message): return message
        }
    }
}

public enum GenlockCLI {
    public struct Output {
        public var status: Int32
        public var stdout: Data
        public var stderr: String
    }

    public static func run(_ args: [String], in folder: String, tools: ToolEnvironment,
                           extraEnv: [String: String] = [:], timeout: TimeInterval = 20) throws -> Output {
        guard let argv = tools.genlockArgv else { throw SnapshotError.genlockMissing }
        guard FileManager.default.fileExists(atPath: folder) else { throw SnapshotError.folderMissing }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst()) + args
        p.currentDirectoryURL = URL(fileURLWithPath: folder)
        p.environment = tools.environment.merging(extraEnv) { _, new in new }
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        try p.run()
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        // Drain both pipes together, because a large snapshot would otherwise fill one and stall.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        killer.cancel()
        return Output(status: p.terminationStatus, stdout: outData, stderr: String(decoding: errData, as: UTF8.self))
    }

    public static func snapshot(of folder: String, tools: ToolEnvironment) -> Result<Snapshot, SnapshotError> {
        let output: Output
        do {
            output = try run(["snapshot"], in: folder, tools: tools)
        } catch let e as SnapshotError {
            return .failure(e)
        } catch {
            return .failure(.failed("Could not run genlock: \(error.localizedDescription)"))
        }
        if output.stderr.contains("unknown command 'snapshot'") { return .failure(.genlockTooOld) }
        guard output.status == 0 else {
            return .failure(.failed(output.stderr.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        do {
            let s = try Snapshot.decode(output.stdout)
            guard s.format == Snapshot.supportedFormat else { return .failure(.genlockTooOld) }
            return .success(s)
        } catch {
            return .failure(.failed("genlock printed something the app could not read: \(error)"))
        }
    }
}
