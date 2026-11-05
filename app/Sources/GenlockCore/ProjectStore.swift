import Foundation

public enum Tier: String, Codable, CaseIterable, Identifiable {
    case today, soon, later
    public var id: String { rawValue }
    public var title: String { rawValue.uppercased() }
}

public struct Project: Codable, Equatable, Identifiable {
    public var path: String
    public var tier: Tier
    public var id: String { path }
    public var name: String { URL(fileURLWithPath: path).lastPathComponent }
    public var exists: Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    public init(path: String, tier: Tier) {
        self.path = path
        self.tier = tier
    }
}

/// Your projects and how much each matters. Stored on this Mac and never in a repository,
/// because a priority belongs to you rather than to the project.
public struct ProjectStore: Equatable {
    public static let defaultTier = Tier.soon

    /// Array order is display order within a tier.
    public private(set) var projects: [Project] = []
    public let file: URL

    public static var defaultFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Genlock/projects.json")
    }

    public init(file: URL = ProjectStore.defaultFile) {
        self.file = file
        if let data = try? Data(contentsOf: file),
           let saved = try? JSONDecoder().decode([Project].self, from: data) {
            projects = saved
        }
    }

    public func save() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        try e.encode(projects).write(to: file, options: .atomic)
    }

    public func inTier(_ tier: Tier) -> [Project] { projects.filter { $0.tier == tier } }
    public func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    @discardableResult
    public mutating func add(path: String, tier: Tier = ProjectStore.defaultTier) -> Project {
        let clean = URL(fileURLWithPath: path).standardizedFileURL.path
        if let existing = project(clean) { return existing }
        let p = Project(path: clean, tier: tier)
        projects.append(p)
        return p
    }

    public mutating func remove(_ id: String) {
        projects.removeAll { $0.id == id }
    }

    /// Put a project in a tier, in front of another card or at the end of the column.
    public mutating func move(_ id: String, to tier: Tier, before other: String? = nil) {
        guard id != other, var moving = project(id) else { return }
        projects.removeAll { $0.id == id }
        moving.tier = tier
        if let other, let i = projects.firstIndex(where: { $0.id == other }) {
            projects.insert(moving, at: i)
        } else {
            projects.append(moving)
        }
    }

    /// Folders that already use genlock. Skips the folders macOS asks permission for, so
    /// offering suggestions cannot trigger a privacy prompt.
    public static func discover(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [String] {
        let skip: Set<String> = ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications"]
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: home, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return [] }
        return entries
            .filter { !skip.contains($0.lastPathComponent) }
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .filter { fm.fileExists(atPath: $0.appendingPathComponent(".genlock/records").path) }
            .map(\.standardizedFileURL.path)
            .sorted()
    }
}

/// Shift-click to mark several cards; letting go of Shift opens them together.
public struct DashSelection: Equatable {
    public static let maxPanes = 6
    public private(set) var marked: [String] = []
    /// True when the last Shift-click was refused because the split is full.
    public private(set) var overflowed = false

    public init() {}

    /// Returns the projects to open now, or nil if this click only marked one.
    public mutating func click(_ id: String, shift: Bool) -> [String]? {
        overflowed = false
        if !shift {
            marked = []
            return [id]
        }
        if let i = marked.firstIndex(of: id) {
            marked.remove(at: i)
        } else if marked.count < Self.maxPanes {
            marked.append(id)
        } else {
            overflowed = true
        }
        return nil
    }

    /// Returns the projects to open when Shift comes up, or nil if nothing was marked.
    public mutating func shiftReleased() -> [String]? {
        guard !marked.isEmpty else { return nil }
        defer { marked = [] }
        return marked
    }

    public mutating func clear() {
        marked = []
        overflowed = false
    }
}

public enum SplitLayout {
    /// How many panes go in each row.
    public static func rows(count: Int) -> [Int] {
        switch count {
        case ...0: return []
        case 1: return [1]
        case 2: return [2]
        case 3: return [3]
        case 4: return [2, 2]
        case 5: return [3, 2]
        default: return [3, 3]
        }
    }

    /// The same panes, grouped into those rows.
    public static func arrange<T>(_ items: [T]) -> [[T]] {
        var out: [[T]] = []
        var i = 0
        for n in rows(count: items.count) {
            out.append(Array(items[i..<min(i + n, items.count)]))
            i += n
        }
        return out
    }
}
