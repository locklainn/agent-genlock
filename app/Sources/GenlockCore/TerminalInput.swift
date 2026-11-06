import Foundation

/// How files reach a session: as their paths, typed at the prompt. The agent is on this Mac and
/// reads them from there.
public enum TerminalInput {
    public enum PasteKind: Equatable { case files, text, image }

    /// Files win because a copied file also carries its name as text. Text beats an image because
    /// a spreadsheet or document copies both, and it is the text you meant.
    public static func pasteKind(hasFiles: Bool, hasText: Bool, hasImage: Bool) -> PasteKind {
        if hasFiles { return .files }
        if hasImage && !hasText { return .image }
        return .text
    }

    /// Escapes a path the way Terminal does when a file is dropped on it.
    public static func escaped(path: String) -> String {
        let special = Set(" !\"#$&'()*,:;<=>?[\\]^`{|}~")
        return path.reduce(into: "") { out, c in
            if special.contains(c) { out.append("\\") }
            out.append(c)
        }
    }

    /// What to type for these paths, with a trailing space so you can carry on typing. Nil if none
    /// can be typed: a line break in a file name would press Return.
    public static func text(forPaths paths: [String]) -> String? {
        let usable = paths.filter { !$0.isEmpty && !$0.contains(where: \.isNewline) && !$0.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F } }
        return usable.isEmpty ? nil : usable.map(escaped).joined(separator: " ") + " "
    }

    /// Marked as a paste when the program asked for that, as it would be from any terminal.
    public static func bracketed(_ text: String, enabled: Bool) -> String {
        enabled ? "\u{1b}[200~\(text)\u{1b}[201~" : text
    }

    /// Where a pasted image is kept, so the agent can read it. Temporary, and outside any project.
    public static var pastedImagesFolder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("GenlockPastes", isDirectory: true)
    }
}
