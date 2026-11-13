import XCTest
@testable import GenlockCore

final class PhoneThreadTests: XCTestCase {
    private func json(_ obj: [String: Any]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
    }
    private func user(_ text: String, at: String, uuid: String = UUID().uuidString) -> String {
        json(["type": "user", "uuid": uuid, "timestamp": at, "message": ["role": "user", "content": text]])
    }
    private func reply(_ text: String, at: String, id: String, end: Bool = true) -> String {
        json(["type": "assistant", "timestamp": at, "message": ["id": id, "role": "assistant",
              "content": [["type": "text", "text": text]], "stop_reason": end ? "end_turn" : "tool_use"]])
    }

    func testPhonePromptGetsTheReplyThatEndsItsTurn() {
        let t = [
            user("[phone] Status update please", at: "2026-11-12T20:31:29.000Z", uuid: "p1"),
            reply("Checking.", at: "2026-11-12T20:31:30.000Z", id: "m1", end: false),
            reply("Here's where things stand.", at: "2026-11-12T20:32:11.000Z", id: "m2"),
        ].joined(separator: "\n")
        let x = PhoneThread.parse(t)
        XCTAssertEqual(x.count, 1)
        XCTAssertEqual(x[0].id, "p1")
        XCTAssertEqual(x[0].said, "Status update please")
        XCTAssertEqual(x[0].reply, "Here's where things stand.")
        XCTAssertNotNil(x[0].repliedAt)
    }

    func testLaptopAndRelayPromptsAreNotThePhones() {
        let t = [
            user("[phone] first", at: "2026-11-12T20:00:00Z"),
            user("[relay] 1 report from project sessions", at: "2026-11-12T20:00:01Z"),
            reply("answers the relay", at: "2026-11-12T20:00:02Z", id: "a"),
            user("typed at the laptop", at: "2026-11-12T20:01:00Z"),
            reply("answers the laptop", at: "2026-11-12T20:01:01Z", id: "b"),
        ].joined(separator: "\n")
        let x = PhoneThread.parse(t)
        XCTAssertEqual(x.map(\.said), ["first"])
        XCTAssertNil(x[0].reply, "the reply answered the relay, which came last")
    }

    func testSystemTextKeepsThePhoneTurnAndWrappedVoiceIsUnwrapped() {
        let t = [
            user("<pasted_content id=\"1\">\n[phone] [voice] a long one\n</pasted_content>", at: "2026-11-12T20:00:00Z"),
            user("<task-notification>done</task-notification>", at: "2026-11-12T20:00:01Z"),
            reply("got it", at: "2026-11-12T20:00:02Z", id: "a"),
        ].joined(separator: "\n")
        let x = PhoneThread.parse(t)
        XCTAssertEqual(x.map(\.said), ["a long one"])
        XCTAssertEqual(x[0].reply, "got it")
    }

    func testQueuedCommandCountsAsAPrompt() {
        let queued = json(["type": "attachment", "timestamp": "2026-11-12T20:00:00Z", "uuid": "q",
                           "attachment": ["type": "queued_command", "prompt": "[phone] while busy"]])
        let x = PhoneThread.parse([queued, reply("ok", at: "2026-11-12T20:00:03Z", id: "a")].joined(separator: "\n"))
        XCTAssertEqual(x.map(\.said), ["while busy"])
        XCTAssertEqual(x[0].reply, "ok")
    }

    func testLoadReadsEveryConversationOldestFirst() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("phonethread-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try [user("[phone] second", at: "2026-11-12T20:31:00Z"), reply("b", at: "2026-11-12T20:31:05Z", id: "b")]
            .joined(separator: "\n").write(to: dir.appendingPathComponent("new.jsonl"), atomically: true, encoding: .utf8)
        try [user("[phone] first", at: "2026-11-12T20:14:00Z"), reply("a", at: "2026-11-12T20:14:05Z", id: "a")]
            .joined(separator: "\n").write(to: dir.appendingPathComponent("old.jsonl"), atomically: true, encoding: .utf8)
        XCTAssertEqual(PhoneThread.load(folder: dir).map(\.said), ["first", "second"])
    }

    func testTranscriptFolderMatchesClaudeCodes() {
        let f = PhoneThread.transcriptFolder(for: "/Users/tj/Library/Application Support/Genlock/Assistant", home: URL(fileURLWithPath: "/Users/tj"))
        XCTAssertEqual(f.path, "/Users/tj/.claude/projects/-Users-tj-Library-Application-Support-Genlock-Assistant")
    }
}

/// Against the real Assistant's transcripts, when asked: GENLOCK_REAL_PHONE_THREAD=1 swift test --filter RealPhoneThread
final class RealPhoneThreadTests: XCTestCase {
    func testRealTranscripts() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["GENLOCK_REAL_PHONE_THREAD"] == "1")
        let folder = PhoneThread.transcriptFolder(for: NSHomeDirectory() + "/Library/Application Support/Genlock/Assistant")
        let all = PhoneThread.load(folder: folder)
        for x in all.suffix(8) { print("PT", x.at, x.said.prefix(60), "->", x.reply?.prefix(50) ?? "(no reply)") }
        print("PT total", all.count, "replied", all.filter { $0.reply != nil }.count)
        XCTAssertFalse(all.isEmpty)
    }
}

final class PhoneThreadReaderTests: XCTestCase {
    func testReaderPicksUpAnAnswerWrittenLater() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("phonereader-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("c.jsonl")
        let prompt = #"{"type":"user","uuid":"p","timestamp":"2026-11-12T20:00:00Z","message":{"role":"user","content":"[phone] hi"}}"#
        try prompt.write(to: file, atomically: true, encoding: .utf8)
        let reader = PhoneThread.Reader(folder: dir)
        XCTAssertNil(reader.read().first?.reply)
        let answer = #"{"type":"assistant","timestamp":"2026-11-12T20:00:05Z","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}}"#
        try (prompt + "\n" + answer).write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(reader.read().first?.reply, "hello")
    }
}

final class PhoneThreadItemsTests: XCTestCase {
    func testItemsBlockIsCutFromTheReply() {
        let r = "Got it.\n\n```items\n[{\"project\":\"x\",\"say\":\"hi\"}]\n```\n"
        XCTAssertEqual(PhoneThread.withoutItems(r), "Got it.")
        XCTAssertEqual(PhoneThread.withoutItems("no block"), "no block")
    }
}
