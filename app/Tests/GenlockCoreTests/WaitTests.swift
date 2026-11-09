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
        XCTAssertEqual(w?.state, .queued)
        XCTAssertEqual(w?.headline, "behind bikes-5", "the script's own words; the state is shown by color and glyph")
    }

    func testDeclaredStateAndTextAreTheAgents() {
        let w = SessionWait.pick(phase: "working", tool: nil, background: [],
                                 declared: [E(label: "testing the town", since: now - 5_000, kind: "testing")], nowMs: now)
        XCTAssertEqual(w?.state, .testing)
        XCTAssertEqual(w?.headline, "testing the town")
        XCTAssertEqual(w?.gist, "testing")
        XCTAssertTrue(w?.state.isWork == true)
        let idle = SessionWait.pick(phase: "holding", tool: nil, background: [],
                                    declared: [E(label: "for the deploy lock", since: now, kind: "waiting")], nowMs: now)
        XCTAssertEqual(idle?.state, .waiting)
        XCTAssertFalse(idle?.state.isWork == true, "waiting is no work being done")
    }

    func testTheWordAndTheColorNeverDisagree() {
        // nightmaremode, 2026-11-09: a default-state declaration about a test queue said
        // "testing" in running's blue beside a real testing wait in green.
        let d = SessionWait.pick(phase: "holding", tool: nil, background: [],
                                 declared: [E(label: "truck_net4 (test queue)", since: now, kind: "running")], nowMs: now)
        XCTAssertEqual(d?.state, .testing, "a state nobody chose is guessed like any command")
        XCTAssertEqual(d?.gist, "testing")
        let chosen = SessionWait.pick(phase: "holding", tool: nil, background: [],
                                      declared: [E(label: "truck_net4 (test queue)", since: now, kind: "running", explicit: true)], nowMs: now)
        XCTAssertEqual(chosen?.state, .running, "a state the agent chose stands")
        XCTAssertEqual(chosen?.gist, "running", "and running never says testing")
        for label in ["Run net_test", "Build it", "Do the thing", "test queue"] {
            for kind in [SessionWait.Kind.tool, .background, .running] {
                for state in SessionWait.State.allCases {
                    let w = SessionWait(label: label, kind: kind, state: state, since: 0)
                    XCTAssertEqual(w.gist == "testing", w.state == .testing, "\(label) \(kind) \(state)")
                }
            }
        }
    }

    func testUndeclaredCommandsGuessTestingOrRunning() {
        let t = SessionWait.pick(phase: "working", tool: E(label: "Run the slow tests", since: now - 15_000), background: [], declared: [], nowMs: now)
        XCTAssertEqual(t?.state, .testing)
        let b = SessionWait.pick(phase: "working", tool: E(label: "Build the app", since: now - 15_000), background: [], declared: [], nowMs: now)
        XCTAssertEqual(b?.state, .running)
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
