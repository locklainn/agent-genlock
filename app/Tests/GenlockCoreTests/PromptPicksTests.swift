import XCTest
@testable import GenlockCore

final class PromptPicksTests: XCTestCase {
    let refund = PromptPick(kind: .task, id: "T-AAAAA", short: "refund-button")
    let payroll = PromptPick(kind: .goal, id: "G-BBBBB", short: "payroll")
    let unnamed = PromptPick(kind: .task, id: "T-CCCCC", short: nil)

    func testAClickTypesOneAtOnce() {
        var picks = PromptPicks()
        XCTAssertEqual(picks.click(refund, shift: false), [refund])
        XCTAssertTrue(picks.marked.isEmpty)
    }

    func testShiftClicksWaitForShiftToComeUpInTheOrderClicked() {
        var picks = PromptPicks()
        XCTAssertNil(picks.click(payroll, shift: true))
        XCTAssertNil(picks.click(refund, shift: true))
        XCTAssertEqual(picks.order(of: refund), 2)
        XCTAssertEqual(picks.shiftReleased(), [payroll, refund])
        XCTAssertNil(picks.shiftReleased(), "once typed, nothing is left marked")
    }

    func testShiftClickingAgainUnmarks() {
        var picks = PromptPicks()
        _ = picks.click(refund, shift: true)
        _ = picks.click(refund, shift: true)
        XCTAssertNil(picks.shiftReleased())
    }

    func testAPlainClickAfterShiftClicksTypesThemAll() {
        var picks = PromptPicks()
        _ = picks.click(payroll, shift: true)
        XCTAssertEqual(picks.click(refund, shift: false), [payroll, refund])
    }

    func testTextIsShortNamesNeverSubmitted() {
        let text = PromptPicks.text(for: [payroll, refund, unnamed])
        XCTAssertEqual(text, "goal payroll, task refund-button, task T-CCCCC ")
        XCTAssertFalse(text.contains("\r") || text.contains("\n"))
        XCTAssertEqual(PromptPicks.text(for: []), "")
    }

    func testPicksGoToThePanelsSessionElseTheOneShownLast() {
        XCTAssertEqual(PromptPicks.target(from: "/p#+a", lastShown: "/p", open: ["/p", "/p#+a"]), "/p#+a")
        XCTAssertEqual(PromptPicks.target(from: nil, lastShown: "/p#+a", open: ["/p", "/p#+a"]), "/p#+a")
        XCTAssertEqual(PromptPicks.target(from: "/gone", lastShown: nil, open: ["/p"]), "/p")
        XCTAssertNil(PromptPicks.target(from: nil, lastShown: nil, open: []), "no session: a new one starts")
    }

    /// The names typed are ones genlock itself resolves.
    func testShortNamesResolveWithGenlock() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("picks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cli = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("bin/genlock.mjs").path
        let g = "node \"\(cli)\""
        let cmd = "git init -q && \(g) init --private >/dev/null && \(g) goal add 'Everyone gets paid on time' --user-said yes --short payroll >/dev/null"
            + " && \(g) goal show payroll | head -1"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", cmd]
        p.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["GENLOCK_SESSION"] = "picker"
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        p.waitUntilExit()
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertTrue(text.contains("Everyone gets paid on time"), text)
    }
}
