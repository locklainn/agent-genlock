import Foundation

public enum Tier: String, Codable, CaseIterable, Identifiable {
    case today, soon, later
    public var id: String { rawValue }
    public var title: String { rawValue.uppercased() }
}

/// What the dashboard is looking at: one tier, or the whole board.
public enum DashFocus: String, CaseIterable, Identifiable {
    case today, soon, later, all
    public var id: String { rawValue }
    public var title: String { self == .all ? "All" : rawValue.uppercased() }
    public var tier: Tier? { Tier(rawValue: rawValue) }
    /// A new project lands where you are looking, so adding one is always visible.
    public var tierForNewProject: Tier { tier ?? ProjectStore.defaultTier }
    /// Opens on what matters now, or wherever you left it.
    public init(saved: String?) { self = saved.flatMap(DashFocus.init(rawValue:)) ?? .today }
}

/// How a project looks in the app. Stored with your projects, never in the repository.
public enum ProjectIcon: Codable, Equatable {
    case emoji(String)
    case symbol(String)
    /// A file in the app's own icon folder, so the original can move or go away.
    case image(String)
}

public struct Project: Codable, Equatable, Identifiable {
    public var path: String
    public var tier: Tier
    public var icon: ProjectIcon?
    public var id: String { path }
    public var name: String { URL(fileURLWithPath: path).lastPathComponent }
    /// What stands in until you choose an icon.
    public var initial: String { name.first { $0.isLetter || $0.isNumber }.map { String($0).uppercased() } ?? "?" }
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

    public var iconFolder: URL { file.deletingLastPathComponent().appendingPathComponent("icons") }

    /// Takes a private copy of an image, because the file you picked may later move.
    public mutating func setIcon(_ id: String, imageAt source: URL) throws {
        try FileManager.default.createDirectory(at: iconFolder, withIntermediateDirectories: true)
        let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension
        let copy = iconFolder.appendingPathComponent("\(UUID().uuidString).\(ext)")
        try FileManager.default.copyItem(at: source, to: copy)
        setIcon(id, .image(copy.path))
    }

    public mutating func setIcon(_ id: String, _ icon: ProjectIcon?) {
        guard let i = projects.firstIndex(where: { $0.id == id }) else { return }
        if case .image(let old)? = projects[i].icon, old.hasPrefix(iconFolder.path) {
            try? FileManager.default.removeItem(atPath: old)
        }
        projects[i].icon = icon
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
        setIcon(id, nil)
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

/// Rows of cards that fill the width, so every card in a row can share one height.
public enum CardGrid {
    public static let minCardWidth: Double = 400
    public static let spacing: Double = 16

    public static func columns(forWidth width: Double) -> Int {
        max(1, Int((width + spacing) / (minCardWidth + spacing)))
    }

    public static func rows<T>(_ items: [T], columns: Int) -> [[T]] {
        stride(from: 0, to: items.count, by: max(1, columns)).map { Array(items[$0..<min($0 + max(1, columns), items.count)]) }
    }
}

public enum SplitLayout {
    /// Showing every session at once fills up to this many panes. Marking cards by hand stops at six.
    public static let maxPanes = 12

    /// Terminal text size with this many panes on screen: smaller as each pane gets less room.
    public static func fontSize(panes: Int) -> Double {
        switch panes {
        case ...1: return 13
        case 2...3: return 12
        case 4...6: return 11
        default: return 10
        }
    }

    /// How many panes go in each row.
    public static func rows(count: Int) -> [Int] {
        switch count {
        case ...0: return []
        case 1: return [1]
        case 2: return [2]
        case 3: return [3]
        case 4: return [2, 2]
        case 5: return [3, 2]
        case 6: return [3, 3]
        default:
            // Past six, a grid at most four across, so each terminal keeps enough columns to read.
            let across = count <= 9 ? (count <= 8 ? 4 : 3) : 4
            var left = count
            var rows: [Int] = []
            let lines = Int((Double(count) / Double(across)).rounded(.up))
            for line in 0..<lines {
                let n = Int((Double(left) / Double(lines - line)).rounded(.up))
                rows.append(n)
                left -= n
            }
            return rows
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
