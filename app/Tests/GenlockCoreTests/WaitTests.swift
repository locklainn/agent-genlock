import XCTest
@testable import GenlockCore

final class WaitTests: XCTestCase {
    typealias E = SessionWait.Entry
    let now: Double = 1_000_000

    func testShortCommandIsJustWork() {
        XCTAssertNil(SessionWait.pick(phase: "working", tool: E(label: "ls", since: now - 3_000), background: [], declared: [], nowMs: now))
    }

    func testLongCommandIsAWait() {
        let w = SessionWait.pick(phase: "working", tool: E(label: "Run the slow tests", since: now - 15_000), background: [], declared: [], nowMs: now)
        XCTAssertEqual(w?.kind, .tool)
        XCTAssertEqual(w?.headline, "Running: Run the slow tests")
    }

    func testDeclaredWaitWinsAndKnowsQueued() {
        let w = SessionWait.pick(phase: "working", tool: E(label: "testq", since: now - 60_000), background: [],
                                 declared: [E(label: "behind bikes-5", since: now - 5_000, kind: "queued")], nowMs: now)
        XCTAssertEqual(w?.kind, .queued)
        XCTAssertEqual(w?.headline, "Queued: behind bikes-5")
    }

    func testBackgroundShowsOnlyOnceTheAgentStops() {
        let bg = [E(label: "Watch the build", since: now - 1_000, id: "a"), E(label: "Render", since: now - 2_000, id: "b")]
        XCTAssertNil(SessionWait.pick(phase: "working", tool: nil, background: bg, declared: [], nowMs: now))
        let w = SessionWait.pick(phase: "holding", tool: nil, background: bg, declared: [], nowMs: now)
        XCTAssertEqual(w?.headline, "Background: Watch the build +1")
    }

    func testReadsTheHookFiles() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wait-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try #"{"label":"build queue","kind":"queued","since":1,"pid":5}"#.write(to: dir.appendingPathComponent("wait-decl-5.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(SessionWait.read(folder: dir, phase: "working")?.kind, .queued)
        XCTAssertEqual(SessionWait.duration(130), "2m10s")
    }
}
