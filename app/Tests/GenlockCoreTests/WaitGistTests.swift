@testable import GenlockCore
import XCTest

final class WaitGistTests: XCTestCase {
    private func gist(_ label: String, _ kind: SessionWait.Kind = .tool, _ state: SessionWait.State = .running) -> String {
        SessionWait(label: label, kind: kind, state: state, since: 0).gist
    }

    func testWaitGistNamesTheWorkInOneWord() {
        XCTAssertEqual(SessionWait.guess("Run the slow tests"), .testing)
        XCTAssertEqual(SessionWait.guess("cd app && swift test --filter CoreTests"), .testing)
        XCTAssertEqual(gist("Run the slow tests", .tool, .testing), "testing")
        XCTAssertEqual(gist("Build the Mac app"), "building")
        XCTAssertEqual(gist("Install package dependencies"), "installing")
        XCTAssertEqual(gist("Deploy to Vercel"), "deploying")
        XCTAssertEqual(gist("godot test queue", .queued, .queued), "queued")
    }

    func testWaitGistFallsBackToTheKind() {
        XCTAssertEqual(gist("Do the thing"), "running")
        XCTAssertEqual(gist("Do the thing", .background), "background")
        // A keyword must start a word: "latest" is not a test.
        XCTAssertEqual(gist("Show the latest status"), "running")
    }
}
