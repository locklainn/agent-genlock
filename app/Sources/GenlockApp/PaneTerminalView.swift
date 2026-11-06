import AppKit
import GenlockCore
import SwiftTerm

/// The terminal in a pane. SwiftTerm only pastes text, so this adds files and images.
final class PaneTerminalView: LocalProcessTerminalView {
    override func paste(_ sender: Any) {
        if !pasteAttachment(from: .general) { super.paste(sender) }
    }

    /// Pastes the clipboard's files or image as paths. False if it holds text, which SwiftTerm handles.
    func pasteAttachment(from board: NSPasteboard) -> Bool {
        let files = Self.fileURLs(on: board)
        let hasText = board.string(forType: .string) != nil
        let hasImage = board.canReadObject(forClasses: [NSImage.self], options: nil)
        switch TerminalInput.pasteKind(hasFiles: !files.isEmpty, hasText: hasText, hasImage: hasImage) {
        case .text:
            return false
        case .files:
            _ = insert(paths: files.map(\.path))
        case .image:
            do {
                _ = insert(paths: [try Self.saveImage(from: board).path])
            } catch {
                AppModel.shared.message = "Could not save the pasted image: \(error.localizedDescription)"
            }
        }
        return true
    }

    /// Types the paths at the prompt. False if they cannot be typed or nothing is running to take them.
    func insert(paths: [String]) -> Bool {
        guard process.running, let text = TerminalInput.text(forPaths: paths) else { return false }
        send(txt: TerminalInput.bracketed(text, enabled: terminalStateSnapshot().bracketedPasteMode))
        return true
    }

    static func fileURLs(on board: NSPasteboard) -> [URL] {
        board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    }

    private static func saveImage(from board: NSPasteboard) throws -> URL {
        guard let png = board.data(forType: .png) ?? pngData(from: board) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let folder = TerminalInput.pastedImagesFolder
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("pasted-\(UUID().uuidString.prefix(8)).png")
        try png.write(to: file)
        return file
    }

    private static func pngData(from board: NSPasteboard) -> Data? {
        guard let tiff = NSImage(pasteboard: board)?.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }
}
