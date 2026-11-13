import Foundation

/// The sprint report: what got finished in one sprint (a week, from one Claude weekly reset to
/// the next) or a range of days. It is `genlock sprint --all --json`, the same document the phone
/// bridge sends, so the Mac and the phone show the same tasks for the same sprint.
public struct SprintReport: Decodable, Equatable {
    public struct Reset: Decodable, Equatable {
        public let text: String
        public let confirmed: Bool
        public let zone: String
    }
    public struct Range: Decodable, Equatable {
        public let id: String
        public let start: String
        public let end: String
        public let label: String
        public let offset: Int?
        public let kind: String
        public let current: Bool
    }
    public struct Totals: Decodable, Equatable { public let tasks: Int; public let goals: Int }
    public struct GoalRef: Decodable, Equatable { public let id: String; public let name: String; public let title: String }
    public struct Task: Decodable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let title: String
        public let closed: String
        public let goal: GoalRef?
    }
    public struct GoalDone: Decodable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let title: String
        public let completedAt: String
    }
    public struct Project: Decodable, Equatable, Identifiable {
        public let name: String
        public let path: String
        public let tasks: [Task]
        public let goalsDone: [GoalDone]
        public var id: String { path }
        /// Done tasks grouped under their goal's name, in the order the newest of each was finished.
        public var byGoal: [(goal: String, tasks: [Task])] {
            var order: [String] = []
            var groups: [String: [Task]] = [:]
            for t in tasks {
                let k = t.goal?.name ?? "No goal"
                if groups[k] == nil { order.append(k) }
                groups[k, default: []].append(t)
            }
            return order.map { ($0, groups[$0]!) }
        }
    }
    public struct Sprint: Decodable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let offset: Int
        public let done: Int
    }

    public let format: Int
    public let reset: Reset
    public let range: Range
    public let totals: Totals
    public let projects: [Project]
    public let sprints: [Sprint]

    public static func decode(_ data: Data) throws -> SprintReport {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return try d.decode(SprintReport.self, from: data)
    }
}

/// Which range to report on.
public enum SprintSelection: Equatable, Hashable {
    /// 0 is the current sprint, -1 the one before.
    case sprint(Int)
    /// Whole days, YYYY-MM-DD, inclusive.
    case days(from: String, to: String)

    var arguments: [String] {
        switch self {
        case .sprint(let off): return ["--sprint", off == 0 ? "current" : String(off)]
        case .days(let from, let to): return ["--from", from, "--to", to]
        }
    }
}

extension GenlockCLI {
    /// The report across every project in the app. FOLDER is only where the CLI runs from.
    public static func sprint(_ selection: SprintSelection, in folder: String = NSHomeDirectory(), tools: ToolEnvironment,
                              extraEnv: [String: String] = [:]) -> Result<SprintReport, SnapshotError> {
        let output: Output
        do {
            output = try run(["sprint", "--all", "--json"] + selection.arguments, in: folder, tools: tools, extraEnv: extraEnv, timeout: 60)
        } catch let e as SnapshotError {
            return .failure(e)
        } catch {
            return .failure(.failed("Could not run genlock: \(error.localizedDescription)"))
        }
        if output.stderr.contains("unknown command 'sprint'") { return .failure(.genlockTooOld) }
        guard output.status == 0 else { return .failure(.failed(output.stderr.trimmingCharacters(in: .whitespacesAndNewlines))) }
        do { return .success(try SprintReport.decode(output.stdout)) } catch {
            return .failure(.failed("The sprint report could not be read: \(error.localizedDescription)"))
        }
    }
}
