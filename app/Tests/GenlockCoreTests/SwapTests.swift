import XCTest
@testable import GenlockCore

/// A session giving way to a fresh one on a goal: what the app reads, when it acts, and what
/// it keeps so the swap can be undone.
final class SwapTests: XCTestCase {
    var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-swap-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var cli: String {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("bin/genlock.mjs").path
    }

    private func sh(_ cmd: String, in dir: URL, env: [String: String] = [:]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", cmd]
        p.currentDirectoryURL = dir
        var e = ProcessInfo.processInfo.environment
        for k in ["GENLOCK_APP_CHANNEL", "GENLOCK_APP_PROJECTS", "CLAUDE_CODE_SESSION_ID"] { e[k] = nil }
        e["GENLOCK_SESSION"] = "swapper"
        p.environment = e.merging(env) { _, n in n }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
    }

    /// The contract with the CLI: what `genlock swap` writes is what the app reads.
    func testReadsTheRequestTheCLIWrites() throws {
        let repo = root.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let channel = VoiceChannel(session: "tok", base: root.appendingPathComponent("channels"))
        let g = "node \"\(cli)\""
        try sh("git init -q && \(g) init --private && \(g) goal add 'Refunds settle within two days' --user-said yes --short refunds && \(g) goal next refunds 'Wire the button'", in: repo)
        XCTAssertNil(channel.requestedSwap, "nothing is asked until the CLI asks")
        try sh("\(g) swap refunds --user-said 'yes swap' --uncommitted none", in: repo, env: ["GENLOCK_APP_CHANNEL": channel.folder.path])
        let swap = try XCTUnwrap(channel.requestedSwap)
        XCTAssertEqual(swap.title, "Refunds settle within two days")
        XCTAssertTrue(swap.prompt.contains("genlock continue \(swap.goal)"))
        XCTAssertEqual(swap.user_said, "yes swap")
    }

    func testWaitsForTheTurnToEndAndTheReplyToBeHeard() {
        XCTAssertFalse(SessionSwap.ready(phase: "working", repliesWaiting: 0, dictating: false))
        XCTAssertFalse(SessionSwap.ready(phase: "done", repliesWaiting: 1, dictating: false))
        XCTAssertFalse(SessionSwap.ready(phase: "done", repliesWaiting: 0, dictating: true))
        XCTAssertTrue(SessionSwap.ready(phase: "done", repliesWaiting: 0, dictating: false))
    }

    /// The main session stays the main session; its old conversation is kept under a key of its
    /// own, or reopening it would land on the fresh one.
    func testMainSessionKeepsItsPlaceAndItsOldConversation() {
        let fresh = SessionSwap.freshSlot(spawn: nil, slot: nil, newSlot: "new111")
        XCTAssertNil(fresh)
        let ended = SessionSwap.ended(project: "/p", spawn: nil, slot: nil, conversation: "conv-old", keptSlot: "old222")
        XCTAssertEqual(ended.conversation, "conv-old")
        XCTAssertNotEqual(ended.key, SessionMemory.key(project: "/p", ticket: nil, slot: fresh))
    }

    func testSpinOffBecomesAnOrdinarySession() {
        let spawn = SpawnRequest(ticket: "T-AAAAA", session: "s-1", title: "x", project: "/p", prompt: "go")
        XCTAssertEqual(SessionSwap.freshSlot(spawn: spawn, slot: nil, newSlot: "new111"), "new111")
        let ended = SessionSwap.ended(project: "/p", spawn: spawn, slot: nil, conversation: "s-1", keptSlot: "zzz")
        XCTAssertEqual(ended.spawn, spawn, "reopening it resumes the spin-off's own conversation")
        XCTAssertNotEqual(ended.key, SessionMemory.key(project: "/p", ticket: nil, slot: "new111"))
    }

    func testAnotherSessionGetsANewSlot() {
        XCTAssertEqual(SessionSwap.freshSlot(spawn: nil, slot: "abc123", newSlot: "new111"), "new111")
        XCTAssertEqual(SessionSwap.ended(project: "/p", spawn: nil, slot: "abc123", conversation: "c", keptSlot: "zzz").slot, "abc123")
    }

    func testProjectSessionsAreToldToOfferTheSwapAndTheAssistantIsNot() {
        let project = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock", spinoffs: true, reportsState: true)
        let told = project.joined(separator: " ")
        XCTAssertTrue(told.contains("genlock swap GOAL with the goal you are on"))
        XCTAssertTrue(told.contains("genlock open --handoff"))
        XCTAssertTrue(told.contains("No yes is needed"))
        let assistant = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock", reportsState: true, assistant: true)
        XCTAssertFalse(assistant.joined(separator: " ").contains("genlock swap"))
    }
}
