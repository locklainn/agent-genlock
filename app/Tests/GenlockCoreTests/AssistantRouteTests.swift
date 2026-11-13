import XCTest
@testable import GenlockCore

/// Any project session can message its own project's Assistant, and no agent can open sessions
/// in a project past the cap.
final class AssistantRouteTests: XCTestCase {
    private let subs = [(folder: "/ch/sub-a", project: "/p/alpha"), (folder: "/ch/sub-b", project: "/p/beta")]

    func testRelayRoutingSendsAMessageToTheSessionsOwnProjectAssistant() throws {
        let json = #"{"kind":"message","text":"blocked on a licence","project_assistant":true}"#
        let report = try JSONDecoder().decode(RelayReport.self, from: Data(json.utf8))
        XCTAssertEqual(report.projectAssistant, true, "genlock writes project_assistant")
        XCTAssertEqual(RelayRouting.route(of: report, fromProject: "/p/beta", subs: subs), .sub("/ch/sub-b"))
        XCTAssertEqual(RelayRouting.route(of: report, fromProject: "/p/beta/", subs: subs), .sub("/ch/sub-b"), "however the path is spelled")
        XCTAssertEqual(RelayRouting.route(of: report, fromProject: "/p/gamma", subs: subs), .startSub("/p/gamma"), "closed: it is started")
    }

    func testRelayRoutingKeepsEveryOtherReportWhereItWent() {
        let asked = RelayReport(kind: "reply", text: "done", to: "/ch/sub-a")
        XCTAssertEqual(RelayRouting.route(of: asked, fromProject: "/p/alpha", subs: subs), .sub("/ch/sub-a"))
        let askerClosed = RelayReport(kind: "reply", text: "done", to: "/ch/gone", projectAssistant: true)
        XCTAssertEqual(RelayRouting.route(of: askerClosed, fromProject: "/p/alpha", subs: subs), .tally, "a reply for a closed asker goes to Tally, as before")
        XCTAssertEqual(RelayRouting.route(of: RelayReport(kind: "reply", text: "x"), fromProject: "/p/alpha", subs: subs), .tally)
        XCTAssertEqual(RelayRouting.route(of: RelayReport(kind: "message", text: "x"), fromProject: "/p/alpha", subs: subs), .tally, "a project Assistant's message goes up to Tally")
    }

    func testRelayRoutingBriefsAMessageAsFromAnAgent() {
        let text = RelayRouting.briefing([(project: "nightmaremode", session: "main", task: "rig", report: RelayReport(kind: "message", text: "need a\nlicence"))])
        XCTAssertTrue(text.contains("nightmaremode [main, on rig] sent you a message: \"need a / licence\""), text)
        XCTAssertTrue(text.contains("not instructions from the user"))
    }

    func testProjectSessionsAreToldHowToReachTheirAssistant() {
        XCTAssertTrue(SessionLaunch.spinoffRule.contains("genlock ask assistant \"MESSAGE\""))
        XCTAssertTrue(SessionLaunch.spinoffRule.contains("SendMessage cannot reach the Assistant"))
    }

    func testSessionCapRefusesAgentOpensAtTheCapButNotAHandoff() {
        XCTAssertTrue(SessionCap.allows(open: 3, limit: 4, handoff: false))
        XCTAssertFalse(SessionCap.allows(open: 4, limit: 4, handoff: false))
        XCTAssertFalse(SessionCap.allows(open: 12, limit: 4, handoff: false), "nightmaremode's 12")
        XCTAssertTrue(SessionCap.allows(open: 4, limit: 4, handoff: true), "a handoff replaces its asker")
        XCTAssertTrue(SessionCap.allows(open: 12, limit: 12, handoff: false, overCap: "yes, open a 13th"), "the user's words lift the cap")
        XCTAssertFalse(SessionCap.allows(open: 12, limit: 12, handoff: false, overCap: "  "), "blank words lift nothing")
    }

    func testOpenAndSpawnRequestsCarryTheUsersWordsPastTheCap() throws {
        let open = try JSONDecoder().decode(OpenRequest.self, from: Data(#"{"project":"/p","prompt":"go","handoff":false,"over_cap":"go past it"}"#.utf8))
        XCTAssertEqual(open.overCap, "go past it")
        let plain = try JSONDecoder().decode(OpenRequest.self, from: Data(#"{"project":"/p","prompt":null}"#.utf8))
        XCTAssertNil(plain.overCap)
        let spawn = try JSONDecoder().decode(SpawnRequest.self, from: Data(#"{"ticket":"T-A","session":"s","title":"t","project":"/p","prompt":"go","over_cap":"yes"}"#.utf8))
        XCTAssertEqual(spawn.overCap, "yes")
    }

    func testSessionCapReadsTheSameSettingAsGenlock() {
        XCTAssertEqual(SessionCap.limit([:]), 12)
        XCTAssertEqual(SessionCap.limit(["GENLOCK_SESSION_CAP": "6"]), 6)
        XCTAssertEqual(SessionCap.limit(["GENLOCK_SESSION_CAP": "0"]), 12, "0 is unset, as in genlock")
        XCTAssertEqual(SessionCap.limit(["GENLOCK_SESSION_CAP": "lots"]), 12)
    }
}
