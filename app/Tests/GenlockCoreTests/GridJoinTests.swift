import XCTest
@testable import GenlockCore

/// A session an agent opens shows up in the panes on screen without clicking its project.
final class GridJoinTests: XCTestCase {
    private let owner = ["a1": "A", "a2": "A", "b1": "B", "new": "A"]
    private func join(_ visible: [String], beside: Bool) -> Int? {
        SplitLayout.joinIndex(visible: visible, project: { self.owner[$0] }, newProject: "A", key: "new", beside: beside)
    }

    func testAgentOpenJoinsTheOnePaneOfItsProject() {
        XCTAssertEqual(join(["a1"], beside: true), 1)
    }

    func testCommandNWithOnePaneStillOpensAlone() {
        XCTAssertNil(join(["a1"], beside: false))
    }

    func testJoinsAfterItsProjectsLastPaneInAMixedGrid() {
        XCTAssertEqual(join(["a1", "a2", "b1"], beside: true), 2)
        XCTAssertEqual(join(["a1", "a2", "b1"], beside: false), 2)
    }

    func testLeavesAnotherProjectAlone() {
        XCTAssertNil(join(["b1"], beside: true))
        XCTAssertNil(join([], beside: true))
    }

    func testAGridOfSixOrMoreStillTakesIt() {
        let six = (1...6).map { "a\($0)" }
        let p: (String) -> String? = { $0.hasPrefix("a") || $0 == "new" ? "A" : nil }
        XCTAssertEqual(SplitLayout.joinIndex(visible: six, project: p, newProject: "A", key: "new", beside: true), 6)
        let full = (1...SplitLayout.maxPanes).map { "a\($0)" }
        XCTAssertNil(SplitLayout.joinIndex(visible: full, project: p, newProject: "A", key: "new", beside: true))
    }

    func testAlreadyOnScreenIsNotAddedTwice() {
        XCTAssertNil(join(["a1", "new"], beside: true))
    }
}
