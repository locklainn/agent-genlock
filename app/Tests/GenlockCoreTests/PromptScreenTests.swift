import XCTest
@testable import GenlockCore

/// The app holds a message while the user has a draft on Claude Code's input line, because the
/// Return that delivers it would submit the draft too. Screens copied from a real session
/// (Claude Code v2.1.325) in a driven Genlock app, 14 November 2026.
final class PromptScreenTests: XCTestCase {
    private let rule = String(repeating: "─", count: 60)

    private func row(_ text: String, dimFrom: Int? = nil) -> PromptScreen.Row {
        let n = text.count
        return PromptScreen.Row(text: text, dim: (0..<n).map { i in dimFrom.map { i >= $0 } ?? false })
    }

    private func screen(_ input: [PromptScreen.Row]) -> [PromptScreen.Row] {
        [row("❯ earlier prompt"), row("⏺ PINEAPPLE"), row("")] + [row(rule)] + input + [row(rule), row("  ⏵⏵ auto mode on (shift+tab to cycle)")]
    }

    func testDraftEmptyLineIsNoDraft() {
        XCTAssertEqual(PromptScreen.draft(in: screen([row("❯ ")])), "")
    }

    func testDraftDimPlaceholderIsNoDraft() {
        XCTAssertEqual(PromptScreen.draft(in: screen([row(#"❯ Try "write a test for <filepath>""#, dimFrom: 2)])), "")
    }

    func testDraftTypedTextIsTheDraft() {
        XCTAssertEqual(PromptScreen.draft(in: screen([row("❯ half typed thought about the lam   ")])), "half typed thought about the lam")
    }

    func testDraftSpanningRows() {
        XCTAssertEqual(PromptScreen.draft(in: screen([row("❯ first line"), row("  second line")])), "first line\nsecond line")
    }

    func testDraftInsideABoxAndInShellMode() {
        XCTAssertEqual(PromptScreen.draft(in: screen([row("│ > boxed draft      │")])), "boxed draft")
        XCTAssertEqual(PromptScreen.draft(in: screen([row("! ls")])), "ls")
    }

    func testDraftOnlyTheLastInputBoxCounts() {
        // An earlier prompt echoed in the conversation, then the live, empty input line.
        let rows = [row(rule), row("❯ an old draft"), row(rule), row("output")] + screen([row("❯ ")])
        XCTAssertEqual(PromptScreen.draft(in: rows), "")
    }

    func testDraftUnknownWithoutAnInputLine() {
        // The folder-trust dialog: one rule, a selection marker, no input line.
        let trust = [row(rule), row("  Accessing workspace:"), row("  ❯ No, exit"), row("    Yes, I trust this folder")]
        XCTAssertNil(PromptScreen.draft(in: trust))
        XCTAssertNil(PromptScreen.draft(in: []))
    }
}
