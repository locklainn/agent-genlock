import XCTest
@testable import GenlockCore

/// A project's own Assistant: told its job for one project, and handed the replies it asked for.
final class SubassistantTests: XCTestCase {
    private func rule(_ args: [String]) -> String { args[args.firstIndex(of: "--append-system-prompt")! + 1] }

    func testAProjectAssistantIsToldItsJobForThatProjectOnly() {
        let args = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock", reportsState: true, subassistantOf: "alpha")
        let text = rule(args)
        XCTAssertTrue(text.contains("You are alpha's Assistant"))
        XCTAssertTrue(text.contains("Work from the records only. Never read or change the project's files"), "records only, like Tally")
        XCTAssertTrue(text.contains("[from Tally]"), "it knows Tally delegates to it")
        XCTAssertTrue(text.contains("genlock sweep") && text.contains("genlock tell TASK"))
        XCTAssertFalse(text.contains("You are the Genlock Assistant"), "it is not the main Assistant")
        XCTAssertFalse(args.contains("--remote-control"), "Remote Control is the main Assistant's only")
        XCTAssertEqual(args[args.firstIndex(of: "--allowedTools")! + 1], "Bash(genlock:*)")
        XCTAssertFalse(text.contains("genlock spinoff propose"), "it coordinates; it does not spin work off")
    }

    func testItOpensOnAProjectStatus() {
        XCTAssertTrue(SessionLaunch.subassistantOpening.contains("genlock sweep"))
        XCTAssertTrue(SessionLaunch.subassistantOpening.contains("this project"))
    }

    func testAReportGoesToTheProjectAssistantThatAskedElseTheMainOne() throws {
        let named = try JSONDecoder().decode(RelayReport.self, from: Data(#"{"kind":"reply","text":"done","to":"/ch/sub-a/"}"#.utf8))
        XCTAssertEqual(RelayRouting.recipient(of: named, among: ["/ch/sub-b", "/ch/sub-a"]), "/ch/sub-a", "matched however the path is spelled")
        XCTAssertNil(RelayRouting.recipient(of: named, among: ["/ch/sub-b"]), "a closed one: the main Assistant hears it instead")
        let plain = try JSONDecoder().decode(RelayReport.self, from: Data(#"{"kind":"reply","text":"done"}"#.utf8))
        XCTAssertNil(plain.to)
        XCTAssertNil(RelayRouting.recipient(of: plain, among: ["/ch/sub-a"]), "no name: the main Assistant")
    }
}
