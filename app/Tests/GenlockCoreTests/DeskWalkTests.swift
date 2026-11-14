import XCTest
@testable import GenlockCore

/// The Mac Phone window walks items by the phone's rules: these mirror WalkPlanTest.kt.
final class DeskWalkTests: XCTestCase {
    private func item(_ id: String, _ project: String, _ task: String, q: Bool = false, at: Int64 = 0) -> DeskItem {
        DeskItem(id: id, project: project, task: task, kind: q ? "question" : "update", say: "say \(id)", ask: q ? "ask \(id)?" : nil, at: at)
    }
    private func ids(_ l: [DeskItem]) -> [String] { l.map { $0.id + ($0.late ? "*" : "") } }

    func testReplyIsOrderedOneProjectAtATimeQuestionsFirst() {
        let l = [item("a1", "genlock", "x"), item("b1", "budget", "y"), item("a2", "genlock", "z", q: true)]
        XCTAssertEqual(ids(DeskWalk.order(l)), ["a2", "a1", "b1"])
    }

    func testSameTaskStillAheadIsReplacedInPlace() {
        let ahead = [item("a1", "genlock", "x"), item("b1", "budget", "y")]
        XCTAssertEqual(ids(DeskWalk.merge(ahead, [item("b2", "Budget", "Y")], heard: [])), ["a1", "b2"])
    }

    func testSameProjectJoinsItsGroupQuestionsAheadOfUpdates() {
        let ahead = [item("a1", "genlock", "x", q: true), item("a2", "genlock", "w"), item("b1", "budget", "y")]
        let m = DeskWalk.merge(ahead, [item("a3", "genlock", "v"), item("a4", "genlock", "u", q: true)], heard: [])
        XCTAssertEqual(ids(m), ["a1", "a4", "a2", "a3", "b1"])
    }

    func testAlreadyHeardGoesLastMarkedLateAndNewProjectsGoAheadOfIt() {
        let heard: Set<String> = ["genlock/x"]
        let m1 = DeskWalk.merge([item("b1", "budget", "y")], [item("a9", "genlock", "x")], heard: heard)
        XCTAssertEqual(ids(m1), ["b1", "a9*"])
        let m2 = DeskWalk.merge(m1, [item("c1", "calendar", "z")], heard: heard)
        XCTAssertEqual(ids(m2), ["b1", "c1", "a9*"])
        XCTAssertEqual(ids(DeskWalk.merge(m2, [item("a10", "genlock", "x")], heard: heard)), ["b1", "c1", "a10*"])
    }

    func testItemsWithNoProjectNeverFoldIntoEachOther() {
        XCTAssertEqual(ids(DeskWalk.merge([item("p1", "", "")], [item("p2", "", "")], heard: [])), ["p1", "p2"])
    }

    func testSpokenFormNamesProjectAndTaskAndSkipsLinks() {
        XCTAssertEqual(DeskItem(id: "i", project: "genlock", task: "phone digest", kind: "question", say: "Built.", ask: "Ship it?").spoken,
                       "genlock, phone digest. Built. Ship it?")
        XCTAssertEqual(DeskItem(id: "j", project: "budget", say: "Done.", late: true).spoken, "Came in while we talked. budget. Done.")
        XCTAssertEqual(DeskItem(id: "k", project: "genlock", task: "review", say: "The plan is up at https://claude.ai/code/artifact/q.").spoken,
                       "genlock, review. The plan is up at.")
        XCTAssertEqual(DeskWalk.unlinked("Open the [review page](https://x.dev/a) now."), "Open the review page now.")
    }

    func testItemsFromBeforeTheMovedOnMarkAreDroppedButNotTheOneBeingHeard() {
        let q = [item("a", "genlock", "x", at: 100), item("b", "budget", "y", at: 200), item("c", "ghost", "z", at: 300)]
        XCTAssertEqual(ids(DeskWalk.current(q, mark: 250, keepHead: false)), ["c"])
        XCTAssertEqual(ids(DeskWalk.current(q, mark: 250, keepHead: true)), ["a", "c"])
        XCTAssertEqual(ids(DeskWalk.current(q, mark: 0, keepHead: false)), ["a", "b", "c"])
        XCTAssertEqual(ids(DeskWalk.current(q, mark: 200, keepHead: false)), ["b", "c"])
    }

    func testTheArrivalReadoutCountsUpdatesAndQuestions() {
        XCTAssertEqual(DeskWalk.arrivalLine(items: 4, questions: 1), "Three updates, one question.")
        XCTAssertEqual(DeskWalk.arrivalLine(items: 1, questions: 0), "One update.")
        XCTAssertEqual(DeskWalk.arrivalLine(items: 2, questions: 2), "Two questions.")
        XCTAssertEqual(DeskWalk.arrivalLine(items: 25, questions: 0), "25 updates.")
    }

    func testLinksInTheReplyGoToTheItemWhoseTaskTheirParagraphNames() {
        let a = item("t-0", "genlock", "phone digest"), b = item("t-1", "budget", "minutes")
        let reply = "The phone digest is ready to review: [review page](https://claude.ai/code/artifact/abc).\n\nMinutes are filed, see https://example.com/m."
        XCTAssertEqual(DeskWalk.links(for: a, reply: reply, siblings: [a, b]), [DeskLinkRef(label: "review page", url: "https://claude.ai/code/artifact/abc")])
        XCTAssertEqual(DeskWalk.links(for: b, reply: reply, siblings: [a, b]), [DeskLinkRef(label: "example.com", url: "https://example.com/m")])
        let lone = "Here is everything: https://claude.ai/code/artifact/z"
        XCTAssertEqual(DeskWalk.links(for: a, reply: lone, siblings: [a, b]).count, 1)
        XCTAssertEqual(DeskWalk.links(for: b, reply: lone, siblings: [a, b]).count, 1)
    }

    func testAnswersGoAsOneBatchInThePhonesFormAndNothingWhenNothingWasAnswered() throws {
        let q = item("r-0", "genlock", "desk", q: true), u = item("r-1", "budget", "minutes")
        XCTAssertNil(DeskWalk.answersMessage([DeskAnswer(item: u, skipped: true)], left: 0))
        let m = try XCTUnwrap(DeskWalk.answersMessage([DeskAnswer(item: q, answer: "yes"), DeskAnswer(item: u, skipped: true)], left: 2))
        XCTAssertEqual(m["kind"] as? String, "say")
        XCTAssertEqual(m["left"] as? Int, 2)
        let arr = try XCTUnwrap(m["answers"] as? [[String: Any]])
        XCTAssertEqual(arr[0]["answer"] as? String, "yes")
        XCTAssertEqual(arr[0]["ask"] as? String, "ask r-0?")
        XCTAssertEqual(arr[1]["skipped"] as? Bool, true)
        XCTAssertEqual(m["text"] as? String, "genlock / desk: yes\nbudget / minutes: skipped")
    }

    func testAReplyWithoutItemsIsOneItemOfItsText() {
        let one = DeskWalk.items(fromReply: ["turn": "t9", "text": "**All** quiet."], at: 5, re: "news?")
        XCTAssertEqual(one.map(\.id), ["t9-0"])
        XCTAssertEqual(one[0].say, "All quiet.")
        XCTAssertEqual(one[0].re, "news?")
        let two = DeskWalk.items(fromReply: ["turn": "t1", "items": [
            ["id": "t1-0", "project": "genlock", "task": "x", "kind": "question", "say": "Built.", "ask": "Ship?", "options": ["Yes", "No"]],
            ["id": "t1-1", "say": ""],
        ]], at: 7, re: nil)
        XCTAssertEqual(two.count, 1)
        XCTAssertEqual(two[0].options, ["Yes", "No"])
        XCTAssertTrue(two[0].isQuestion)
    }

    func testAReviewInFocusModeSendsEachCommentTaggedWithItsImageLikeThePhone() {
        let m: [String: Any] = ["kind": "reply", "turn": "r", "items": [["id": "r-0", "project": "nightmaremode", "task": "doors", "say": "Four options.",
            "images": [["fid": "r-0-img0", "name": "a.png", "path": "/tmp/a.png"], ["fid": "r-0-img1", "name": "b.png", "caption": "the side door", "path": "/tmp/b.png"],
                       ["fid": "r-0-img2", "name": "c.png"], ["fid": "r-0-img3", "name": "d.png"], ["name": "no-fid.png"]]]]]
        let it = DeskWalk.items(fromReply: m, at: 0, re: nil)[0]
        XCTAssertEqual(it.images.count, 4)
        XCTAssertEqual(it.images[1].path, "/tmp/b.png")
        XCTAssertTrue(it.isQuestion)
        XCTAssertTrue(it.spoken.hasSuffix("4 images to look at."))
        XCTAssertEqual(DeskWalk.reviewAnswer(it.images, [1: "too dark", 2: " love it ", 3: "  "]),
                       "Image 2 of 4 (b.png, the side door): too dark\nImage 3 of 4 (c.png): love it")
        XCTAssertNil(DeskWalk.reviewAnswer(it.images, [0: " "]))
    }
}
