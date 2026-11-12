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

/// A message typed into a session counts as delivered only when the transcript shows all of it.
final class DeliveryTests: XCTestCase {
    private func line(_ content: Any) -> String {
        let obj: [String: Any] = ["type": "user", "message": ["role": "user", "content": content]]
        return String(decoding: try! JSONSerialization.data(withJSONObject: obj), as: UTF8.self)
    }
    private let sent = "[from Tally] For nightmaremode: build the takeover system.\nTake on that task, and report back."

    func testAWholeMessageIsFoundThroughPasteWrappersAndLineBreaks() {
        let wrapped = "\n\n<pasted_content id=\"4481\">\n[from Tally] For nightmaremode: build the takeover\n</pasted_content id=\"4481\">\n\n<pasted_content id=\"4481\">\n system.\nTake on that task, and report back.\n</pasted_content id=\"4481\">"
        XCTAssertTrue(Delivery.arrived(sent, inTranscript: [line("earlier"), line(wrapped)].joined(separator: "\n")))
        XCTAssertTrue(Delivery.arrived(sent, inTranscript: line([["type": "text", "text": sent]])), "content given as parts")
    }

    func testOnlyTheTailOfAMessageIsNotDelivered() {
        XCTAssertFalse(Delivery.arrived(sent, inTranscript: line("k, and report back.")))
        XCTAssertFalse(Delivery.arrived(sent, inTranscript: ""), "an empty transcript")
        let reply = String(decoding: try! JSONSerialization.data(withJSONObject: ["type": "assistant", "message": ["content": sent]]), as: UTF8.self)
        XCTAssertFalse(Delivery.arrived(sent, inTranscript: reply), "the agent quoting it is not receiving it")
    }

    func testItIsTypedOnceMoreWhenIdleThenReportedLost() {
        let t0 = Date()
        let p = Delivery.Pending(text: sent, at: t0)
        XCTAssertEqual(Delivery.verdict(p, arrived: true, phase: "done", now: t0), .arrived)
        XCTAssertEqual(Delivery.verdict(p, arrived: false, phase: "done", now: t0.addingTimeInterval(5)), .wait, "within the grace period")
        XCTAssertEqual(Delivery.verdict(p, arrived: false, phase: "working", now: t0.addingTimeInterval(60)), .wait, "a busy session takes it when its turn ends")
        XCTAssertEqual(Delivery.verdict(p, arrived: false, phase: "done", now: t0.addingTimeInterval(30)), .retype)
        var again = p; again.tries = 2
        XCTAssertEqual(Delivery.verdict(again, arrived: false, phase: "done", now: t0.addingTimeInterval(30)), .lost)
        XCTAssertEqual(Delivery.verdict(p, arrived: false, phase: "working", now: t0.addingTimeInterval(2000)), .lost, "half an hour on, the sender hears")
    }

    func testTheSenderIsToldAMessageWasLostAndStopsWaiting() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-\(UUID().uuidString)")
        let sub = base.appendingPathComponent("tok-sub")
        let channel = VoiceChannel(session: "tok-a", base: base)
        try FileManager.default.createDirectory(at: channel.folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try Data(#"{"at":1,"from":"\#(sub.path)"}"#.utf8).write(to: channel.folder.appendingPathComponent("awaiting-reply.json"))
        try Data("1".utf8).write(to: sub.appendingPathComponent("owed-tok-a"))
        try channel.reportUndelivered(sent)
        let relays = channel.peekRelays()
        XCTAssertEqual(relays.count, 1)
        XCTAssertEqual(relays.first?.report.kind, "undelivered")
        XCTAssertEqual(relays.first?.report.to, sub.path, "back to the project's Assistant that passed it on")
        XCTAssertFalse(channel.owesReply)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sub.appendingPathComponent("owed-tok-a").path), "it is not held waiting for a reply that cannot come")
        let text = RelayRouting.briefing([(project: "nightmaremode", session: "main", task: "ice cream talk", report: relays[0].report)])
        XCTAssertTrue(text.contains("never received a message") && text.contains("[from Tally] For nightmaremode"), text)
    }

    func testAReplyThatDoesNotSayWhetherItStartedIsFlagged() {
        let none = RelayReport(kind: "reply", text: "No. The talk's camera is in the truck's code.", ack: "none")
        XCTAssertTrue(RelayRouting.briefing([(project: "n", session: "main", task: "", report: none)]).contains("WITHOUT saying whether it started"))
        let started = RelayReport(kind: "reply", text: "STARTED. Building it now.", ack: "started")
        XCTAssertFalse(RelayRouting.briefing([(project: "n", session: "main", task: "", report: started)]).contains("WITHOUT"))
    }
}
