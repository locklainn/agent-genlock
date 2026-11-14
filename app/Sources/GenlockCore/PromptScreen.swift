import Foundation

/// Reads Claude Code's input line off a session's screen, so the app can tell whether the user has
/// a half-typed draft there. The app delivers a message by pasting it and pressing Return, and
/// Return submits everything on the input line: pasted into a draft, it would send the draft too.
public enum PromptScreen {
    public struct Row: Equatable, Sendable {
        public var text: String
        /// One per character of `text`: drawn dim. An empty input line shows a dim placeholder.
        public var dim: [Bool]
        /// One per character: its foreground colour, for diagnosis only.
        public var colors: [String]
        public init(text: String, dim: [Bool] = [], colors: [String] = []) {
            self.text = text
            self.dim = dim
            self.colors = colors
        }
    }

    /// The input line sits between two horizontal rules near the bottom of the screen.
    static func isRule(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        return t.count >= 10 && t.allSatisfy { "─━═-╭╮╰╯".contains($0) }
    }

    /// The input line's marker: ">" or "❯" normally, "!" in shell mode, "#" in memory mode.
    static let markers: [Character] = [">", "❯", "›", "!", "#"]

    /// What is typed on the input line: "" when it is empty (or shows only its dim placeholder),
    /// nil when no input line can be found on screen (a dialog, a session still starting).
    public static func draft(in rows: [Row]) -> String? {
        // The last pair of rules with a prompt marker between them.
        let rules = rows.indices.filter { isRule(rows[$0].text) }
        guard rules.count >= 2 else { return nil }
        for k in stride(from: rules.count - 1, to: 0, by: -1) {
            let top = rules[k - 1], bottom = rules[k]
            guard bottom - top >= 2 else { continue }
            let body = Array(rows[(top + 1)..<bottom])
            guard let first = body.first, let at = markerIndex(first) else { continue }
            var lines: [String] = []
            for (i, row) in body.enumerated() {
                lines.append(undimmed(row, from: i == 0 ? at + 1 : 0))
            }
            return lines.map { $0.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "│┃|"))) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n")
        }
        return nil
    }

    /// Where the prompt marker is: the first non-blank character, after any box border.
    static func markerIndex(_ row: Row) -> Int? {
        for (i, c) in row.text.enumerated() {
            if c == " " || c == "│" || c == "┃" || c == "\u{a0}" { continue }
            return markers.contains(c) ? i : nil
        }
        return nil
    }

    /// The row's text from `start`, without its dim cells.
    static func undimmed(_ row: Row, from start: Int) -> String {
        var out = ""
        for (i, c) in row.text.enumerated() where i >= start {
            let dim = i < row.dim.count ? row.dim[i] : false
            out.append(dim ? " " : c)
        }
        return out
    }
}
