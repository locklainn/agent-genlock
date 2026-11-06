import XCTest
@testable import GenlockCore

/// These run the real genlock CLI in real repositories, because the contract between the
/// two is the thing most likely to drift.
final class CoreTests: XCTestCase {
    var root: URL!
    var repo: String!
    lazy var cli: String = {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("bin/genlock.mjs").path
    }()
    lazy var tools: ToolEnvironment = {
        let base = ProcessInfo.processInfo.environment.merging(["GENLOCK_APP_CLI": cli]) { _, n in n }
        return ToolEnvironment.resolve(base: base)
    }()

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-core-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        repo = try makeRepo("demo")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    func shell(_ cmd: String, in dir: String? = nil) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", cmd]
        p.currentDirectoryURL = URL(fileURLWithPath: dir ?? repo)
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    func makeRepo(_ name: String) throws -> String {
        let dir = root.appendingPathComponent(name).path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try shell("git init -q -b main && git config user.email t@e.co && git config user.name t && echo x > seed && git add . && git commit -qm i", in: dir)
        return dir
    }

    func g(_ args: String..., in dir: String? = nil) throws -> String {
        let out = try GenlockCLI.run(args, in: dir ?? repo, tools: tools, extraEnv: ["GENLOCK_SESSION": "test"])
        return String(decoding: out.stdout, as: UTF8.self)
    }

    func id(_ prefix: String, _ text: String) -> String? {
        (try? NSRegularExpression(pattern: "\\b\(prefix)-[0-9A-Z]{5}\\b")).flatMap { re in
            re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)).flatMap { Range($0.range, in: text).map { String(text[$0]) } }
        }
    }

    func snap(_ dir: String? = nil) throws -> Snapshot { try GenlockCLI.snapshot(of: dir ?? repo, tools: tools).get() }

    // MARK: Contract with the CLI

    func testAFolderWithNoGenlockStillWorks() throws { // P1
        let s = try snap()
        XCTAssertFalse(s.initialized)
        let card = CardSummary(s)
        XCTAssertTrue(card.needsSetup)
        XCTAssertNil(card.goalTitle)
    }

    func testViewingWritesNothing() throws { // G1
        _ = try snap()
        XCTAssertEqual(try shell("git status --porcelain"), "")
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo + "/.git/genlock"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo + "/.genlock"))
    }

    func testAFullSnapshotDecodesIntoACard() throws { // D2, D7, R2
        let goal = id("G", try g("goal", "add", "Ship the report", "--user-said", "ship it"))!
        let ticket = id("T", try g("new", "The report renders every table", "-r", "the build exits zero on 12 tables", "-c", "node build.mjs", "--goal", goal, "--quiet"))!
        _ = try g("update", ticket, "9 of 12 tables render")
        let soon = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3 * 86400)).prefix(10)
        _ = try g("goal", "next", goal, "Send it to the board", "--due", String(soon))
        _ = try g("ask", "user", "Include the appendix?", "--about", goal)
        _ = try g("forbid", goal, "Do not deploy", "--lifted-by", "TJ")
        _ = try g("hazard", ticket, "A stray build is running", "--verify", "pgrep build")
        _ = try g("review", "seed", "--why", "Is this right?")

        let s = try snap()
        XCTAssertEqual(s.format, Snapshot.supportedFormat)
        let card = CardSummary(s)
        XCTAssertEqual(card.goalTitle, "Ship the report")
        XCTAssertEqual(card.goalProgress, "0 of 1")
        XCTAssertEqual(card.nextThing, "Send it to the board")
        XCTAssertEqual(card.lastTaskTitle, "The report renders every table")
        XCTAssertEqual(card.waitingOnYou, 1)
        XCTAssertEqual(card.toReview, 1)
        XCTAssertEqual(card.deadline?.daysUntil, 3)
        XCTAssertEqual(card.deadline?.label, "due in 3d")
        XCTAssertNotNil(card.lastTaskUpdated)
        XCTAssertEqual(s.ticket(ticket)?.latest?.text, "9 of 12 tables render")
        XCTAssertEqual(s.ticket(ticket)?.hazards.count, 1)
        XCTAssertEqual(s.goal(goal)?.forbids.first?.text, "Do not deploy")
    }

    func testADistantDeadlineStaysOffTheCardButAnOverdueOneShows() throws { // D7
        let goal = id("G", try g("goal", "add", "Far off goal here", "--user-said", "x"))!
        let far = String(ISO8601DateFormatter().string(from: Date().addingTimeInterval(30 * 86400)).prefix(10))
        _ = try g("goal", "next", goal, "Far away", "--due", far)
        XCTAssertNil(CardSummary(try snap()).deadline)
        let past = String(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-2 * 86400)).prefix(10))
        _ = try g("goal", "next", goal, "Missed", "--due", past)
        let d = CardSummary(try snap()).deadline
        XCTAssertEqual(d?.isOverdue, true)
        XCTAssertEqual(d?.label, "overdue by 2d")
    }

    func testAReviewKnowsWhereItsFileIs() throws { // R3, R4
        _ = try g("review", "seed", "--why", "Check")
        _ = try g("review", "https://example.com/x", "--why", "Read")
        let s = try snap()
        let file = s.reviews.first { !$0.isURL }!
        let web = s.reviews.first { $0.isURL }!
        XCTAssertEqual(web.url(root: s.root)?.absoluteString, "https://example.com/x")
        XCTAssertTrue(file.exists(root: s.root))
        XCTAssertEqual(file.url(root: s.root)?.lastPathComponent, "seed")
        try FileManager.default.removeItem(atPath: repo + "/seed")
        XCTAssertFalse(file.exists(root: s.root))
    }

    func testBadToolsGiveTheFixNotACrash() throws { // G2, G3
        var none = tools
        none.genlockArgv = nil
        XCTAssertEqual(GenlockCLI.snapshot(of: repo, tools: none), .failure(.genlockMissing))
        XCTAssertTrue(SnapshotError.genlockMissing.description.contains("npm install -g"))

        XCTAssertEqual(GenlockCLI.snapshot(of: repo + "/gone", tools: tools), .failure(.folderMissing))

        let old = root.appendingPathComponent("old-genlock").path
        try "#!/bin/sh\necho \"genlock: unknown command 'snapshot'. \" >&2\nexit 1\n".write(toFile: old, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: old)
        var stale = tools
        stale.genlockArgv = [old]
        XCTAssertEqual(GenlockCLI.snapshot(of: repo, tools: stale), .failure(.genlockTooOld))

        let future = root.appendingPathComponent("new-genlock").path
        try "#!/bin/sh\necho '{\"format\":99,\"root\":\"/\",\"initialized\":true,\"goals\":[],\"tickets\":[],\"open_tickets\":[],\"questions_for_user\":[],\"reviews\":[],\"claims\":[]}'\n".write(toFile: future, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: future)
        var ahead = tools
        ahead.genlockArgv = [future]
        XCTAssertNotEqual(GenlockCLI.snapshot(of: repo, tools: ahead), .failure(.genlockTooOld), "newer only adds to the format")
    }

    func testToolsAreFoundWithAMinimalPath() { // S5
        // What Finder gives an app: no nvm, no shell setup. The login shell has to supply the rest.
        let env = ToolEnvironment.resolve(base: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        XCTAssertNotNil(env.claudePath, "PATH was \(env.environment["PATH"] ?? "")")
        XCTAssertNotNil(env.genlockArgv)
        XCTAssertEqual(env.environment["TERM"], "xterm-256color")
    }

    func testAgentVariablesDoNotLeakIntoANewSession() {
        let env = ToolEnvironment.resolve(base: ["GENLOCK_SESSION": "leak", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "leak", "PATH": "/usr/bin:/bin"], shell: "/nonexistent")
        XCTAssertNil(env.environment["GENLOCK_SESSION"])
        XCTAssertNil(env.environment["CLAUDECODE"])
        XCTAssertNil(env.environment["CLAUDE_CODE_SESSION_ID"])
    }

    // MARK: Live updates

    func testAChangeByAnAgentIsSeenWithinTwoSeconds() throws { // D3, I5
        _ = try g("goal", "add", "Watch me change", "--user-said", "x")
        let seen = expectation(description: "watcher fired")
        seen.assertForOverFulfill = false
        let w = ProjectWatcher(folder: repo) { seen.fulfill() }
        defer { w.stop() }
        Thread.sleep(forTimeInterval: 0.5) // FSEvents needs a moment to attach.
        let start = Date()
        _ = try g("goal", "add", "A second goal arrives", "--user-said", "x")
        wait(for: [seen], timeout: 2)
        let s = try snap()
        XCTAssertEqual(s.goals.count, 2)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }

    func testAClaimCreatedInAFreshRepositoryIsSeen() throws { // the folders did not exist when watching began
        let seen = expectation(description: "watcher fired")
        seen.assertForOverFulfill = false
        let w = ProjectWatcher(folder: repo) { seen.fulfill() }
        defer { w.stop() }
        Thread.sleep(forTimeInterval: 0.5)
        _ = try g("claim", "work", "--path", "src")
        wait(for: [seen], timeout: 2)
    }

    func testBusyWorkInARepositoryTriggersNothing() throws { // G4
        let noise = expectation(description: "must not fire")
        noise.isInverted = true
        let w = ProjectWatcher(folder: repo) { noise.fulfill() }
        defer { w.stop() }
        Thread.sleep(forTimeInterval: 0.5)
        try FileManager.default.createDirectory(atPath: repo + "/dist", withIntermediateDirectories: true)
        for i in 0..<200 { try "x".write(toFile: repo + "/dist/\(i).js", atomically: false, encoding: .utf8) }
        _ = try shell("git status")
        wait(for: [noise], timeout: 1)
    }

    func testWatcherPathFilter() { // G4
        XCTAssertTrue(ProjectWatcher.isRelevant("/r/.genlock/records/T-AAAAA.jsonl"))
        XCTAssertTrue(ProjectWatcher.isRelevant("/r/.git/genlock/claims/x.json"))
        XCTAssertFalse(ProjectWatcher.isRelevant("/r/.git/genlock/lock"))
        XCTAssertFalse(ProjectWatcher.isRelevant("/r/src/records/a.jsonl"))
        XCTAssertFalse(ProjectWatcher.isRelevant("/r/.git/index.lock"))
    }

    func testDiffPointsAtWhatChanged() throws { // I5
        let goal = id("G", try g("goal", "add", "Goal under diff", "--user-said", "x"))!
        let ticket = id("T", try g("new", "Ticket under diff here", "-r", "the diff check exits zero", "-c", "node d.mjs", "--goal", goal, "--quiet"))!
        let before = try snap()
        XCTAssertTrue(SnapshotDiff.changedIDs(old: nil, new: before).isEmpty, "the first load highlights nothing")
        XCTAssertTrue(SnapshotDiff.changedIDs(old: before, new: before).isEmpty)
        _ = try g("update", ticket, "moved")
        let after = try snap()
        XCTAssertEqual(SnapshotDiff.changedIDs(old: before, new: after), [ticket])
    }

    // MARK: Projects and tiers

    func testProjectsAndTiersSurviveARestart() throws { // P4, D5, D6
        let file = root.appendingPathComponent("s/projects.json")
        var store = ProjectStore(file: file)
        store.add(path: "/a"); store.add(path: "/b"); store.add(path: "/c")
        XCTAssertEqual(store.inTier(.soon).map(\.path), ["/a", "/b", "/c"], "new projects go to SOON")
        store.move("/c", to: .today)
        store.move("/a", to: .today, before: "/c")
        try store.save()
        let reloaded = ProjectStore(file: file)
        XCTAssertEqual(reloaded.inTier(.today).map(\.path), ["/a", "/c"])
        XCTAssertEqual(reloaded.inTier(.soon).map(\.path), ["/b"])
    }

    func testTheDashboardOpensOnTodayOrWhereYouLeftIt() { // D1
        XCTAssertEqual(DashFocus(saved: nil), .today)
        XCTAssertEqual(DashFocus(saved: "nonsense"), .today)
        XCTAssertEqual(DashFocus(saved: "later"), .later)
        XCTAssertEqual(DashFocus(saved: "all"), .all)
        XCTAssertEqual(DashFocus.today.tierForNewProject, .today, "a new project lands where you are looking")
        XCTAssertEqual(DashFocus.later.tierForNewProject, .later)
        XCTAssertEqual(DashFocus.all.tierForNewProject, .soon)
        XCTAssertNil(DashFocus.all.tier)
        XCTAssertEqual(DashFocus.soon.tier, .soon)
    }

    func testProjectIconsSurviveARestartAndOlderFilesStillLoad() throws { // D9
        let file = root.appendingPathComponent("i/projects.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try #"[{"path":"/old","tier":"today"}]"#.write(to: file, atomically: true, encoding: .utf8)
        var store = ProjectStore(file: file)
        XCTAssertEqual(store.project("/old")?.tier, .today, "a list saved before icons existed still loads")
        XCTAssertNil(store.project("/old")?.icon)
        XCTAssertEqual(store.project("/old")?.initial, "O")
        store.setIcon("/old", .emoji("🚀"))
        store.add(path: "/sym")
        store.setIcon("/sym", .symbol("bolt.fill"))
        try store.save()
        let back = ProjectStore(file: file)
        XCTAssertEqual(back.project("/old")?.icon, .emoji("🚀"))
        XCTAssertEqual(back.project("/sym")?.icon, .symbol("bolt.fill"))
    }

    func testAnImageIconIsAPrivateCopyAndIsCleanedUp() throws { // D9
        let file = root.appendingPathComponent("j/projects.json")
        var store = ProjectStore(file: file)
        store.add(path: repo)
        let source = root.appendingPathComponent("logo.png")
        try "fake".write(to: source, atomically: true, encoding: .utf8)
        try store.setIcon(repo, imageAt: source)
        guard case .image(let copy)? = store.project(repo)?.icon else { return XCTFail("no image icon") }
        try FileManager.default.removeItem(at: source)
        XCTAssertTrue(FileManager.default.fileExists(atPath: copy), "survives the original going away")
        XCTAssertEqual(try shell("git status --porcelain"), "", "nothing is written to the project")
        store.setIcon(repo, .emoji("🌿"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy), "a replaced image is removed")
    }

    func testEveryProjectIsInExactlyOneTier() { // D1
        var store = ProjectStore(file: root.appendingPathComponent("x.json"))
        store.add(path: "/a"); store.add(path: "/b")
        store.move("/a", to: .later)
        store.move("/a", to: .later)
        store.move("/a", to: .later, before: "/a")
        let shown = Tier.allCases.flatMap { store.inTier($0).map(\.path) }
        XCTAssertEqual(shown.sorted(), ["/a", "/b"])
    }

    func testAddingTheSameFolderTwiceKeepsOne() {
        var store = ProjectStore(file: root.appendingPathComponent("x.json"))
        store.add(path: "/a/b")
        store.add(path: "/a/./c/../b/")
        XCTAssertEqual(store.projects.count, 1)
    }

    func testRemovingAProjectLeavesTheFolderAlone() throws { // P5
        var store = ProjectStore(file: root.appendingPathComponent("x.json"))
        store.add(path: repo)
        _ = try g("goal", "add", "Stays on disk", "--user-said", "x")
        let before = try shell("git status --porcelain -uall")
        store.remove(repo)
        XCTAssertTrue(store.projects.isEmpty)
        XCTAssertEqual(try shell("git status --porcelain -uall"), before)
        XCTAssertEqual(try snap().goals.count, 1)
    }

    func testAMissingFolderIsReported() throws { // P6
        var store = ProjectStore(file: root.appendingPathComponent("x.json"))
        let p = store.add(path: root.appendingPathComponent("gone").path)
        XCTAssertFalse(p.exists)
        XCTAssertEqual(store.projects.count, 1, "it stays listed")
    }

    func testACorruptStoreStartsEmptyInsteadOfCrashing() throws {
        let file = root.appendingPathComponent("bad.json")
        try "not json".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertTrue(ProjectStore(file: file).projects.isEmpty)
    }

    func testDiscoverySkipsProtectedFolders() throws { // P3
        let home = root.appendingPathComponent("home")
        for name in ["usesit", "Documents", "Desktop", "plain"] {
            try FileManager.default.createDirectory(at: home.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        for name in ["usesit", "Documents", "Desktop"] {
            try FileManager.default.createDirectory(at: home.appendingPathComponent("\(name)/.genlock/records"), withIntermediateDirectories: true)
        }
        XCTAssertEqual(ProjectStore.discover(home: home).map { URL(fileURLWithPath: $0).lastPathComponent }, ["usesit"])
    }

    // MARK: Selection and split

    func testPlainClickOpensOne() { // S1
        var s = DashSelection()
        XCTAssertEqual(s.click("a", shift: false), ["a"])
        XCTAssertTrue(s.marked.isEmpty)
    }

    func testShiftClicksOpenTogetherOnRelease() { // S2
        var s = DashSelection()
        XCTAssertNil(s.click("a", shift: true))
        XCTAssertNil(s.click("b", shift: true))
        XCTAssertNil(s.click("c", shift: true))
        XCTAssertEqual(s.marked, ["a", "b", "c"])
        XCTAssertEqual(s.shiftReleased(), ["a", "b", "c"])
        XCTAssertTrue(s.marked.isEmpty)
        XCTAssertNil(s.shiftReleased(), "releasing Shift again opens nothing")
    }

    func testShiftClickingAgainUnmarks() { // S2
        var s = DashSelection()
        _ = s.click("a", shift: true); _ = s.click("b", shift: true); _ = s.click("a", shift: true)
        XCTAssertEqual(s.shiftReleased(), ["b"])
    }

    func testReleasingShiftWithNothingMarkedDoesNothing() { // typing a capital letter must not open anything
        var s = DashSelection()
        XCTAssertNil(s.shiftReleased())
    }

    func testAPlainClickAbandonsMarks() {
        var s = DashSelection()
        _ = s.click("a", shift: true)
        XCTAssertEqual(s.click("b", shift: false), ["b"])
        XCTAssertNil(s.shiftReleased())
    }

    func testASeventhPaneIsRefused() { // S8
        var s = DashSelection()
        for name in ["a", "b", "c", "d", "e", "f"] { _ = s.click(name, shift: true) }
        XCTAssertFalse(s.overflowed)
        _ = s.click("g", shift: true)
        XCTAssertTrue(s.overflowed)
        XCTAssertEqual(s.shiftReleased()?.count, 6)
    }

    func testCardsFillTheWidthInRows() { // D11
        XCTAssertEqual(CardGrid.columns(forWidth: 300), 1)
        XCTAssertEqual(CardGrid.columns(forWidth: 816), 2)
        XCTAssertEqual(CardGrid.columns(forWidth: 1272), 3)
        XCTAssertEqual(CardGrid.rows(["a", "b", "c", "d"], columns: 3), [["a", "b", "c"], ["d"]])
        XCTAssertEqual(CardGrid.rows([String](), columns: 3), [])
    }

    func testSplitLayouts() { // S8
        XCTAssertEqual(SplitLayout.rows(count: 1), [1])
        XCTAssertEqual(SplitLayout.rows(count: 2), [2])
        XCTAssertEqual(SplitLayout.rows(count: 3), [3])
        XCTAssertEqual(SplitLayout.rows(count: 4), [2, 2])
        XCTAssertEqual(SplitLayout.rows(count: 5), [3, 2])
        XCTAssertEqual(SplitLayout.rows(count: 6), [3, 3])
        XCTAssertEqual(SplitLayout.arrange(["a", "b", "c", "d", "e"]), [["a", "b", "c"], ["d", "e"]])
        XCTAssertEqual(SplitLayout.arrange([String]()), [])
    }

    // MARK: Voice

    func testPressToStartPressToSend() { // V1
        var v = VoiceMachine()
        XCTAssertEqual(v.press(), .startListening)
        XCTAssertEqual(v.state, .listening)
        XCTAssertEqual(v.press(), .finishListening)
        XCTAssertEqual(v.press(), .none, "a third press while sending does nothing")
        v.reset()
        XCTAssertEqual(v.press(), .startListening)
    }

    func testRightCommandCancelsOnlyWhileDictating() { // V2
        typealias V = VoiceMachine
        XCTAssertEqual(V.keyAction(keyCode: V.rightOptionKey, isDown: true, state: .idle), .press)
        XCTAssertEqual(V.keyAction(keyCode: V.rightOptionKey, isDown: true, state: .listening), .press)
        XCTAssertEqual(V.keyAction(keyCode: V.rightOptionKey, isDown: false, state: .listening), .none, "only on the way down")
        XCTAssertEqual(V.keyAction(keyCode: V.rightCommandKey, isDown: true, state: .listening), .cancel)
        XCTAssertEqual(V.keyAction(keyCode: V.rightCommandKey, isDown: true, state: .sending), .cancel)
        XCTAssertEqual(V.keyAction(keyCode: V.rightCommandKey, isDown: true, state: .idle), .none, "an ordinary key otherwise")
        XCTAssertEqual(V.keyAction(keyCode: 55, isDown: true, state: .listening), .none, "left Command is left alone")
    }

    // These sequences are what the on-device recognizer really delivered, on macOS 26.5.
    func testStoppingAfterAPauseKeepsTheWords() { // V13
        var t = VoiceTranscript()
        t.receive("Dictation keep saying", endsUtterance: false)
        t.receive("Dictation keeps saying nothing was heard", endsUtterance: true)
        t.receive("", endsUtterance: false) // the final result
        XCTAssertEqual(t.text, "Dictation keeps saying nothing was heard")
    }

    func testAPauseMidSentenceKeepsWhatCameBefore() { // V13
        var t = VoiceTranscript()
        t.receive("The first part", endsUtterance: false)
        t.receive("The first part is about the red bicycle", endsUtterance: true)
        XCTAssertEqual(t.text, "The first part is about the red bicycle")
        t.receive("The", endsUtterance: false)
        XCTAssertEqual(t.text, "The first part is about the red bicycle The", "the new words follow, they do not replace")
        t.receive("The second part", endsUtterance: false)
        t.receive("The second part is about the blue kitchen", endsUtterance: true)
        XCTAssertEqual(t.text, "The first part is about the red bicycle The second part is about the blue kitchen")
    }

    func testAnEmptyResultDoesNotEraseWordsStillBeingRevised() { // V13
        var t = VoiceTranscript()
        t.receive("Maybe", endsUtterance: false)
        t.receive("", endsUtterance: true)
        XCTAssertEqual(t.text, "Maybe")
    }

    func testALongDictationShowsItsNewestWords() { // V2
        XCTAssertEqual(VoiceTranscript.latest("short and sweet"), "short and sweet")
        let long = (1...100).map { "word\($0)" }.joined(separator: " ")
        let shown = VoiceTranscript.latest(long)
        XCTAssertTrue(shown.hasSuffix("word100"), "the newest words")
        XCTAssertTrue(shown.hasPrefix("…word"), "starts on a whole word, and says it is cut")
        XCTAssertLessThanOrEqual(shown.count, 171)
    }

    func testRankAndDueReachTheApp() throws { // S20 S21
        let json = #"""
        {"format":3,"root":"/r","initialized":true,"goals_declined":false,"current_goal":null,"last_ticket":null,
         "goals":[
          {"rank":2,"due":null,"days_until":null,"id":"G-B","title":"Second","status":"active","progress":{"done":0,"total":0,"blocked":0},"next":[],"forbids":[],"decisions":[],"refs":[]},
          {"rank":1,"due":"2099-01-01","days_until":3,"id":"G-A","title":"First","status":"active","progress":{"done":0,"total":0,"blocked":0},"next":[],"forbids":[],"decisions":[],"refs":[]},
          {"rank":null,"due":null,"days_until":null,"id":"G-C","title":"Closed","status":"done","progress":{"done":0,"total":0,"blocked":0},"next":[],"forbids":[],"decisions":[],"refs":[]}],
         "tickets":[
          {"rank":2,"due":null,"days_until":null,"id":"T-B","title":"B","status":"open","updated":"2026-01-02T00:00:00Z","summary":"","requirements":[],"hazards":[],"forbids":[]},
          {"rank":1,"due":"2099-01-01","days_until":1,"id":"T-A","title":"A","status":"open","updated":"2026-01-01T00:00:00Z","summary":"","requirements":[],"hazards":[],"forbids":[]}],
         "open_tickets":["T-B","T-A"],"questions_for_user":[],"reviews":[],"claims":[]}
        """#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let s = try d.decode(Snapshot.self, from: Data(json.utf8))
        XCTAssertEqual(s.rankedTasks.map(\.id), ["T-A", "T-B"], "by rank, not by recent activity")
        XCTAssertEqual(s.rankedGoals.map(\.id), ["G-A", "G-B"], "closed goals have no place")
        XCTAssertEqual(CardSummary(s).deadline?.text, "A", "a task's own date counts, and the nearest wins")
    }

    func testACleanTapOfRightCommandAsksForReplies() { // V15
        typealias V = VoiceMachine
        XCTAssertEqual(V.tapAction(waiting: 2, isSpeaking: false, canReplay: true), .hear, "new comes before old")
        XCTAssertEqual(V.tapAction(waiting: 0, isSpeaking: true, canReplay: true), .stop)
        XCTAssertEqual(V.tapAction(waiting: 1, isSpeaking: true, canReplay: false), .stop, "stopping comes first")
        XCTAssertEqual(V.tapAction(waiting: 0, isSpeaking: false, canReplay: true), .replay, "nothing is ever lost")
        XCTAssertEqual(V.tapAction(waiting: 0, isSpeaking: false, canReplay: false), .none, "otherwise an ordinary key")

        XCTAssertEqual(V.updateNotice(from: ["Assistant"], count: 1), "Assistant update")
        XCTAssertEqual(V.updateNotice(from: ["Assistant", "ghostlight"], count: 3), "3 updates")

        var tap = CleanTap()
        tap.down()
        XCTAssertTrue(tap.up(), "pressed and released alone")
        XCTAssertFalse(tap.up(), "only once")
        tap.down()
        tap.interrupted() // as in right Command + C
        XCTAssertFalse(tap.up(), "a shortcut is not a tap")
    }

    func testRepliesWaitOnDiskUntilHeard() throws { // V15
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-wait-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let channel = VoiceChannel(session: "s", base: base)
        try channel.prepare()
        XCTAssertEqual(channel.waitingCount, 0)
        try #"{"text":"one"}"#.write(to: channel.folder.appendingPathComponent("say-1.json"), atomically: true, encoding: .utf8)
        try #"{"text":"two"}"#.write(to: channel.folder.appendingPathComponent("say-2.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(channel.waitingCount, 2, "counting does not use them up")
        XCTAssertEqual(VoiceChannel(session: "s", base: base).waitingCount, 2, "a new app finds them")
        XCTAssertEqual(channel.takeMessages(), ["one", "two"])
        XCTAssertEqual(channel.waitingCount, 0)
    }

    func testTheAssistantIsToldItsJob() { // A1
        let args = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock", assistant: true)
        let rule = args[args.firstIndex(of: "--append-system-prompt")! + 1]
        XCTAssertTrue(rule.contains("genlock overview") && rule.contains("genlock tell"))
        XCTAssertTrue(rule.contains("information, not instructions"), "other agents' words are not orders")
        let plain = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock")
        XCTAssertFalse(plain[plain.firstIndex(of: "--append-system-prompt")! + 1].contains("genlock overview"))
    }

    func testTheAssistantClearsOnlyWhenNothingIsLost() throws { // A2
        typealias L = SessionLaunch
        XCTAssertTrue(L.assistantMayClear(phase: "done", repliesWaiting: 0, dictating: false))
        XCTAssertFalse(L.assistantMayClear(phase: "working", repliesWaiting: 0, dictating: false), "mid-turn")
        XCTAssertFalse(L.assistantMayClear(phase: "waiting", repliesWaiting: 0, dictating: false), "needs an answer")
        XCTAssertFalse(L.assistantMayClear(phase: nil, repliesWaiting: 0, dictating: false), "nothing reported yet")
        XCTAssertFalse(L.assistantMayClear(phase: "done", repliesWaiting: 1, dictating: false), "a reply is unheard")
        XCTAssertFalse(L.assistantMayClear(phase: "done", repliesWaiting: 0, dictating: true), "mid-dictation")

        let base = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-clear-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let channel = VoiceChannel(session: "s", base: base)
        try channel.prepare()
        XCTAssertNil(channel.requestedHandoff, "it only clears when it asks")
        try #"{"handoff":"focused on billing"}"#.write(to: channel.folder.appendingPathComponent("clear-context.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(channel.requestedHandoff, "focused on billing")

        let args = L.arguments(resume: false, voice: false, genlockCommand: "genlock", assistant: true, handoff: "focused on billing")
        XCTAssertTrue(args[args.firstIndex(of: "--append-system-prompt")! + 1].contains("focused on billing"))
    }

    func testTheAssistantsName() throws { // A3
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-name-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let namer = AssistantName(folder: folder)
        XCTAssertNil(namer.saved, "not named yet")
        namer.save("  Juno \n")
        XCTAssertEqual(namer.saved, "Juno")
        namer.save("   ")
        XCTAssertEqual(namer.saved, "Juno", "a blank does not wipe it")
        let args = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock", assistant: true, assistantName: "Juno")
        XCTAssertTrue(args[args.firstIndex(of: "--append-system-prompt")! + 1].contains("Your name is Juno"))
    }

    func testAppSessionsAreToldToUseShortNames() { // S22
        let args = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock")
        XCTAssertTrue(args[args.firstIndex(of: "--append-system-prompt")! + 1].contains("short names"))
    }

    func testReadingSpeed() { // V16
        typealias S = SpeechSpeed
        XCTAssertEqual(S.rate(forSpeed: 1), 0.5, accuracy: 0.001)
        XCTAssertEqual(S.rate(forSpeed: 2.03), 0.65, accuracy: 0.001, "as measured")
        XCTAssertEqual(S.rate(forSpeed: 0.5), 0.5, accuracy: 0.001, "no slower than normal")
        XCTAssertEqual(S.rate(forSpeed: 99), 1, accuracy: 0.001, "no faster than it can go")
        for (slow, fast) in zip(S.options, S.options.dropFirst()) {
            XCTAssertLessThan(S.rate(forSpeed: slow), S.rate(forSpeed: fast), "each choice is faster than the last")
        }
        XCTAssertGreaterThan(S.rate(speed: 1.5, held: true), S.rate(speed: 1.5, held: false))
        XCTAssertLessThanOrEqual(S.rate(speed: 3, held: true), S.rate(forSpeed: S.fastest), "holding has a ceiling")
        XCTAssertEqual(S.label(1.5), "1.5×")
        XCTAssertEqual(S.label(2), "2×")
        XCTAssertEqual(S.remainder(of: "one two", from: 4), "two")
        XCTAssertEqual(S.remainder(of: "😀 two", from: 3), "two", "counted as the synthesizer counts")
        XCTAssertEqual(S.remainder(of: "one", from: 99), "", "never past the end")
    }

    func testTheTalkKeyAnswersTheUpdateInFrontOfYou() { // V17
        typealias R = ReplyTarget
        let update = R(session: "/other", text: "Done.")
        XCTAssertEqual(R.dictationTarget(pane: nil, reply: update, focused: "/here"), "/other", "the update, wherever you are")
        XCTAssertEqual(R.dictationTarget(pane: nil, reply: nil, focused: "/here"), "/here", "otherwise what is in front of you")
        XCTAssertEqual(R.dictationTarget(pane: "/pane", reply: update, focused: "/here"), "/pane", "a pane's own button means that pane")
    }

    func testThePanelFocusesOnWhatIsGoingOn() throws { // S23
        func ticket(_ id: String, _ status: String, _ updated: String, rank: Int?) -> String {
            #"{"rank":\#(rank.map(String.init) ?? "null"),"id":"\#(id)","title":"\#(id)","status":"\#(status)","updated":"\#(updated)","summary":"","requirements":[],"hazards":[],"forbids":[]}"#
        }
        let now = ISODate.parse("2026-11-06T12:00:00Z")!
        let tickets = [
            ticket("old-top", "open", "2026-10-01T00:00:00Z", rank: 1),
            ticket("started-long-ago", "in_progress", "2026-10-02T00:00:00Z", rank: 2),
            ticket("touched-today", "open", "2026-11-06T11:00:00Z", rank: 3),
            ticket("stuck", "blocked", "2026-10-03T00:00:00Z", rank: 4),
            ticket("old-bottom", "open", "2026-10-01T00:00:00Z", rank: 5),
            ticket("done-today", "done", "2026-11-06T10:00:00Z", rank: nil),
            ticket("done-long-ago", "done", "2026-10-01T00:00:00Z", rank: nil),
        ].joined(separator: ",")
        let json = #"{"format":3,"root":"/r","initialized":true,"goals":[],"tickets":[\#(tickets)],"open_tickets":["old-top","started-long-ago","touched-today","stuck","old-bottom"],"questions_for_user":[],"reviews":[],"claims":[]}"#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let focus = try d.decode(Snapshot.self, from: Data(json.utf8)).taskFocus(now: now)
        XCTAssertEqual(focus.active.map(\.id), ["started-long-ago", "stuck", "touched-today"], "started first, however long ago, then stuck, then recent")
        XCTAssertEqual(focus.justFinished.map(\.id), ["done-today"])
        XCTAssertEqual(focus.backlog.map(\.id), ["old-top", "old-bottom"], "the rest, still in rank order")
    }

    func testPassedMessagesArriveOnce() throws { // A1
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-tell-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let channel = VoiceChannel(session: "s", base: base)
        try channel.prepare()
        try #"{"text":"run the tests"}"#.write(to: channel.folder.appendingPathComponent("tell-1.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(channel.takeTells(), ["run the tests"])
        XCTAssertEqual(channel.takeTells(), [])
    }

    func testRevisionsReplaceTheCurrentUtterance() { // V13
        var t = VoiceTranscript()
        t.receive("Nothing was her", endsUtterance: false)
        t.receive("Nothing was heard", endsUtterance: false)
        XCTAssertEqual(t.text, "Nothing was heard")
        XCTAssertNil(VoiceMachine.message(from: VoiceTranscript().text), "silence still sends nothing")
    }

    func testPathsAreEscapedAsTerminalDoes() { // S16
        XCTAssertEqual(TerminalInput.escaped(path: "/Users/tj/My Shots (1)/a&b.png"), #"/Users/tj/My\ Shots\ \(1\)/a\&b.png"#)
        XCTAssertEqual(TerminalInput.escaped(path: "/tmp/café-😀_v1.2+x.png"), "/tmp/café-😀_v1.2+x.png", "ordinary characters stay readable")
        XCTAssertEqual(TerminalInput.text(forPaths: ["/a b", "/c"]), #"/a\ b /c "#, "separated, with room to keep typing")
    }

    func testAPathThatWouldPressReturnIsNotTyped() { // S16
        XCTAssertNil(TerminalInput.text(forPaths: ["/tmp/a\nb.png"]))
        XCTAssertNil(TerminalInput.text(forPaths: ["/tmp/a\u{1b}b.png"]))
        XCTAssertEqual(TerminalInput.text(forPaths: ["/tmp/a\nb.png", "/ok"]), "/ok ")
        XCTAssertNil(TerminalInput.text(forPaths: []))
    }

    func testWhatAPasteMeans() { // S17
        typealias T = TerminalInput
        XCTAssertEqual(T.pasteKind(hasFiles: true, hasText: true, hasImage: true), .files, "a copied file also carries its name")
        XCTAssertEqual(T.pasteKind(hasFiles: false, hasText: false, hasImage: true), .image, "a screenshot")
        XCTAssertEqual(T.pasteKind(hasFiles: false, hasText: true, hasImage: true), .text, "a copied spreadsheet")
        XCTAssertEqual(T.pasteKind(hasFiles: false, hasText: true, hasImage: false), .text)
        XCTAssertEqual(T.pasteKind(hasFiles: false, hasText: false, hasImage: false), .text, "left to SwiftTerm, which does nothing")
    }

    func testPastedPathsAreMarkedOnlyWhenAsked() { // S16
        XCTAssertEqual(TerminalInput.bracketed("/a ", enabled: true), "\u{1b}[200~/a \u{1b}[201~")
        XCTAssertEqual(TerminalInput.bracketed("/a ", enabled: false), "/a ")
    }

    func testWhenTheAppRebuildsItself() { // S19
        typealias U = AppUpdate
        let t: TimeInterval = 1000
        XCTAssertEqual(U.next(running: t, available: t, newestSource: t - 5, lastAttempt: nil, now: t + 60), .nothing, "nothing changed")
        XCTAssertEqual(U.next(running: t, available: t, newestSource: t + 50, lastAttempt: nil, now: t + 60), .nothing, "still being edited")
        XCTAssertEqual(U.next(running: t, available: t, newestSource: t + 30, lastAttempt: nil, now: t + 60), .build, "gone quiet")
        XCTAssertEqual(U.next(running: t, available: t + 40, newestSource: t + 30, lastAttempt: t + 40, now: t + 90), .offerRestart, "built")
        XCTAssertEqual(U.next(running: t, available: t, newestSource: t + 30, lastAttempt: t + 40, now: t + 90), .nothing, "failed: wait for a change")
        XCTAssertEqual(U.next(running: t, available: t, newestSource: t + 50, lastAttempt: t + 40, now: t + 90), .build, "changed since it failed")
        XCTAssertEqual(U.next(running: t, available: t + 40, newestSource: t + 50, lastAttempt: t + 40, now: t + 90), .build, "newer than the build on offer")
        XCTAssertEqual(U.next(running: t, available: nil, newestSource: t - 5, lastAttempt: nil, now: t + 60), .nothing)
    }

    func testABuildFailureShowsTheError() { // S19
        XCTAssertEqual(AppUpdate.failure(from: "Building\n/x.swift:3:1: error: nope\nmore"), "/x.swift:3:1: error: nope")
        XCTAssertEqual(AppUpdate.failure(from: "only this"), "only this")
    }

    func testOlderMemoryWithoutTokensStillLoads() throws { // S7
        let json = #"{"open":[{"project":"/p"}],"visible":["/p"],"conversations":{}}"#
        let m = try JSONDecoder().decode(SessionMemory.self, from: Data(json.utf8))
        XCTAssertEqual(m.open.first?.project, "/p")
        XCTAssertNil(m.open.first?.token)
    }

    // MARK: The session host

    private func hostTool() -> String {
        Bundle(for: CoreTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("genlock-host").path
    }

    /// One attached end, as the app would be: the host's output arrives on `out`.
    private func attachHost(_ tool: String, socket: String, folder: String, command: [String]) throws -> (p: Process, stdin: Pipe, out: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = ["run", socket, folder, "--"] + command
        let stdin = Pipe()
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("host-\(UUID().uuidString).out")
        FileManager.default.createFile(atPath: out.path, contents: nil)
        p.standardInput = stdin
        p.standardOutput = try FileHandle(forWritingTo: out)
        try p.run()
        return (p, stdin, out)
    }

    private func wait(for what: String, timeout: Double = 8, until done: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !done() && Date() < end { usleep(50_000) }
        XCTAssertTrue(done(), "timed out waiting for \(what)")
    }

    private func probe(_ tool: String, _ socket: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = ["probe", socket]
        try? p.run()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    func testASessionOutlivesWhatIsAttachedToIt() throws { // S7
        let tool = hostTool()
        // Deep on purpose: a socket's own path may be no longer than about 100 bytes.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("genlock-host-\(UUID().uuidString)/\(String(repeating: "deep-", count: 30))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir.deletingLastPathComponent()) }
        let socket = dir.appendingPathComponent("host.sock").path
        let beat = dir.appendingPathComponent("beat").path
        // Says it started, then counts for as long as it lives, and answers whatever it reads.
        let script = #"printf '\033[?2004h'; echo started; (while :; do echo x >> "$0"; sleep 0.1; done) & while read line; do echo "got:$line"; if [ "$line" = quit ]; then kill $!; exit 7; fi; done"#
        let first = try attachHost(tool, socket: socket, folder: dir.path, command: ["/bin/sh", "-c", script, beat])
        wait(for: "the first output") { (try? String(contentsOf: first.out, encoding: .utf8))?.contains("started") == true }

        // Killed outright, as a crash or a quit would.
        kill(first.p.processIdentifier, SIGKILL)
        first.p.waitUntilExit()
        XCTAssertTrue(probe(tool, socket), "the host outlives the attached end")
        let before = (try? String(contentsOfFile: beat, encoding: .utf8))?.count ?? 0
        wait(for: "the program to keep running") { ((try? String(contentsOfFile: beat, encoding: .utf8))?.count ?? 0) > before }

        // Back again: what it said is replayed, its bracketed-paste mode is restored, and it still listens.
        let second = try attachHost(tool, socket: socket, folder: dir.path, command: ["/usr/bin/false"])
        wait(for: "the replay") { (try? String(contentsOf: second.out, encoding: .utf8))?.contains("started") == true }
        XCTAssertTrue((try? String(contentsOf: second.out, encoding: .utf8))?.hasPrefix("\u{1b}[?2004h") == true)
        usleep(500_000) // past the moment answers to replayed questions are thrown away
        second.stdin.fileHandleForWriting.write(Data("hello\n".utf8))
        wait(for: "the reply") { (try? String(contentsOf: second.out, encoding: .utf8))?.contains("got:hello") == true }

        // A probe leaves the attached end alone.
        XCTAssertTrue(probe(tool, socket))
        usleep(200_000)
        XCTAssertTrue(second.p.isRunning)

        // The program's own exit code comes back, and the host leaves nothing behind.
        second.stdin.fileHandleForWriting.write(Data("quit\n".utf8))
        second.p.waitUntilExit()
        XCTAssertEqual(second.p.terminationStatus, 7)
        wait(for: "the socket to go") { !FileManager.default.fileExists(atPath: socket) }
    }

    func testEndingASessionReachesTheHost() throws { // S7
        let tool = hostTool()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("genlock-host-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let socket = dir.appendingPathComponent("host.sock").path
        let attached = try attachHost(tool, socket: socket, folder: dir.path, command: ["/bin/sh", "-c", "echo up; sleep 60"])
        wait(for: "it to start") { (try? String(contentsOf: attached.out, encoding: .utf8))?.contains("up") == true }
        let k = Process()
        k.executableURL = URL(fileURLWithPath: tool)
        k.arguments = ["kill", socket]
        try k.run()
        k.waitUntilExit()
        attached.p.waitUntilExit()
        XCTAssertNotEqual(attached.p.terminationStatus, 0)
        XCTAssertFalse(probe(tool, socket))
    }

    func testRecognitionFailuresAreExplained() { // V12
        let off = VoiceMachine.explain(recognitionError: #"Error Domain=kLSRErrorDomain Code=201 "Siri and Dictation are disabled""#)
        XCTAssertEqual(off?.needsDictationSetting, true)
        XCTAssertTrue(off?.message.contains("Keyboard") == true)
        XCTAssertNil(VoiceMachine.explain(recognitionError: "No speech detected"), "stopping with nothing said is not a failure")
        XCTAssertEqual(VoiceMachine.explain(recognitionError: "Something else")?.needsDictationSetting, false)
    }

    func testSayingNothingSendsNothing() { // V3
        XCTAssertNil(VoiceMachine.message(from: ""))
        XCTAssertNil(VoiceMachine.message(from: "  \n "))
        XCTAssertEqual(VoiceMachine.message(from: " what is next \n"), "[voice] what is next")
    }

    func testVoiceArgumentsCarryTheRule() throws { // V4, V5, V9
        let args = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock")
        let rule = args[args.firstIndex(of: "--append-system-prompt")! + 1]
        XCTAssertFalse(rule.contains("rabbit hole"), "only sessions that can spin off are told to")
        XCTAssertTrue(rule.contains("genlock say"))
        XCTAssertTrue(rule.contains("more depth"))
        XCTAssertFalse(rule.contains("Australian"))
        let settings = args[args.firstIndex(of: "--settings")! + 1]
        let json = try JSONSerialization.jsonObject(with: Data(settings.utf8)) as! [String: Any]
        XCTAssertNotNil((json["hooks"] as? [String: Any])?["Stop"])
        XCTAssertTrue(settings.contains("genlock session-state"))
        XCTAssertTrue(args.contains("Bash(genlock:*)"), "speaking must not stop for a permission prompt")
    }

    func testSessionsReportTheirStateWithSpeechOff() { // N1
        let args = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock", reportsState: true)
        let settings = args[args.firstIndex(of: "--settings")! + 1]
        for event in ["Stop", "Notification", "UserPromptSubmit", "PostToolUse"] { XCTAssertTrue(settings.contains(event), event) }
        XCTAssertFalse(args.contains("--append-system-prompt"), "no rule to add without speech")
    }

    func testAttentionFollowsTheSession() { // N1, N3, N5
        let done = SessionReport(state: "done", message: "", at: 1)
        let waiting = SessionReport(state: "waiting", message: "", at: 2)
        let working = SessionReport(state: "working", message: "", at: 3)
        XCTAssertEqual(Attention.next(current: nil, report: done, isNew: true, looking: false).attention, .done)
        XCTAssertTrue(Attention.next(current: nil, report: done, isNew: true, looking: false).notify)
        XCTAssertEqual(Attention.next(current: .done, report: waiting, isNew: true, looking: false).attention, .waiting)
        XCTAssertFalse(Attention.next(current: .done, report: done, isNew: false, looking: false).notify, "one notification per event")
        XCTAssertEqual(Attention.next(current: .done, report: done, isNew: false, looking: false).attention, .done, "stays until seen")
        XCTAssertNil(Attention.next(current: .done, report: working, isNew: true, looking: false).attention, "it resumed")
        XCTAssertNil(Attention.next(current: .done, report: done, isNew: false, looking: true).attention, "you have seen it")
        XCTAssertFalse(Attention.next(current: nil, report: done, isNew: true, looking: true).notify, "no alert for what you are looking at")
    }

    func testAChannelReadsWhatASessionReports() throws { // N1
        let channel = VoiceChannel(session: "s3", base: root.appendingPathComponent("voice"))
        try channel.prepare()
        XCTAssertNil(channel.readState())
        var env = tools
        env.environment["GENLOCK_APP_CHANNEL"] = channel.folder.path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: env.genlockArgv![0])
        p.arguments = Array(env.genlockArgv!.dropFirst()) + ["session-state"]
        p.environment = env.environment
        let input = Pipe()
        p.standardInput = input
        try p.run()
        input.fileHandleForWriting.write(Data(#"{"hook_event_name":"Notification","message":"Needs approval"}"#.utf8))
        input.fileHandleForWriting.closeFile()
        p.waitUntilExit()
        XCTAssertEqual(channel.readState()?.state, "waiting")
        XCTAssertEqual(channel.readState()?.message, "Needs approval")
    }

    private func transcripts(writing ids: [String] = []) throws -> Transcripts {
        let t = Transcripts(project: "/some/my_project.app", claudeHome: root)
        XCTAssertEqual(t.folder.lastPathComponent, "-some-my-project-app")
        try FileManager.default.createDirectory(at: t.folder, withIntermediateDirectories: true)
        for id in ids { try Data().write(to: t.folder.appendingPathComponent("\(id).jsonl")) }
        return t
    }

    func testAConversationIsPickedUpByItsOwnID() throws { // S1, S12
        let t = try transcripts()
        XCTAssertEqual(t.start(saved: nil, spawnSession: nil, newID: "n"), .new("n"), "nothing here yet")
        XCTAssertEqual(t.start(saved: "a", spawnSession: nil, newID: "n"), .new("n"), "opened and never spoken to, so it cannot be resumed")
        try Data().write(to: t.folder.appendingPathComponent("other.jsonl"))
        XCTAssertEqual(t.start(saved: nil, spawnSession: nil, newID: "n"), .latest, "history from before the app remembered")
        try Data().write(to: t.folder.appendingPathComponent("a.jsonl"))
        XCTAssertEqual(t.start(saved: "a", spawnSession: nil, newID: "n"), .resume("a"))
        XCTAssertEqual(t.start(saved: "a", spawnSession: "spin", newID: "n"), .new("spin"), "a spin-off starts on its handoff")
        try Data().write(to: t.folder.appendingPathComponent("spin.jsonl"))
        XCTAssertEqual(t.start(saved: nil, spawnSession: "spin", newID: "n"), .resume("spin"), "and never takes the folder's latest")
    }

    func testASpinOffFromAnotherRepositoryDoesNotBelong() throws { // O6
        let spawn = { (project: String) in
            try JSONDecoder().decode(SpawnRequest.self, from: Data(#"{"ticket":"T","session":"s","title":"t","project":"\#(project)","prompt":"p"}"#.utf8))
        }
        XCTAssertTrue(try spawn("/repo").belongs(to: "/repo"))
        XCTAssertTrue(try spawn("/repo").belongs(to: "/repo/app"), "a project can be a subfolder of its repository")
        XCTAssertTrue(try spawn("/private/tmp").belongs(to: "/tmp"), "one folder, two spellings")
        XCTAssertFalse(try spawn("/tmp/fixture").belongs(to: "/repo"))
        XCTAssertFalse(try spawn("/repo-other").belongs(to: "/repo"), "a shared prefix is not a shared folder")
    }

    func testTranscriptsAreFoundWhereClaudeCodeKeepsThem() { // S12
        XCTAssertEqual(Transcripts(project: "/tmp", claudeHome: root).folder.lastPathComponent, "-private-tmp", "symlinks resolved, /private kept")
    }

    func testOnlyAPickUpThatDiesAtOnceStartsOver() { // S15
        XCTAssertTrue(ConversationStart.latest.failedToPickUp(exitCode: 1, after: 2))
        XCTAssertTrue(ConversationStart.resume("a").failedToPickUp(exitCode: 1, after: 2))
        XCTAssertFalse(ConversationStart.latest.failedToPickUp(exitCode: 0, after: 2), "you ended it")
        XCTAssertFalse(ConversationStart.latest.failedToPickUp(exitCode: 1, after: 600), "it ran, then something else went wrong")
        XCTAssertFalse(ConversationStart.new("a").failedToPickUp(exitCode: 1, after: 2), "so it can never loop")
    }

    func testResumingPassesTheIDAndNotTheHandoff() { // S11
        let args = SessionLaunch.arguments(resume: false, voice: false, genlockCommand: nil, resumeID: "a")
        XCTAssertEqual(args, ["--resume", "a"])
    }

    func testOpenSessionsSurviveARestart() throws { // S11
        var m = SessionMemory()
        let spawn = try JSONDecoder().decode(SpawnRequest.self, from: Data(#"{"ticket":"T-1","session":"s","title":"t","project":"/a","prompt":"p"}"#.utf8))
        m.open = [.init(project: "/a"), .init(project: "/a", spawn: spawn), .init(project: "/gone")]
        m.visible = ["/gone", "/a#T-1", "/a"]
        m.conversations = ["/a": "c"]
        let file = SessionMemory.file(beside: root.appendingPathComponent("deep/projects.json"))
        try m.save(to: file)
        let back = SessionMemory.load(from: file)
        XCTAssertEqual(back, m)
        let r = back.restorable { $0 != "/gone" }
        XCTAssertEqual(r.open.map(\.key), ["/a", "/a#T-1"])
        XCTAssertEqual(r.visible, ["/a#T-1", "/a"], "the split as you left it, less what has gone")
        XCTAssertEqual(back.restorable { $0 == "/a" }.visible.count, 2)
        m.visible = ["/gone"]
        XCTAssertEqual(m.restorable { $0 != "/gone" }.visible, ["/a"], "something always comes back on screen")
        try Data("not json".utf8).write(to: file)
        XCTAssertEqual(SessionMemory.load(from: file), SessionMemory(), "damage means nothing open, not a crash")
    }

    func testACardReadsWhatTheConversationIsAbout() throws { // D12
        let t = try transcripts()
        let lines = [
            "half a line cut off by the tail",
            #"{"type":"ai-title","aiTitle":"Old title","sessionId":"a"}"#,
            #"{"type":"user","message":"mentions \"ai-title\" in passing"}"#,
            #"{"type":"last-prompt","lastPrompt":"[voice] fix   the\nresume","sessionId":"a"}"#,
            #"{"type":"ai-title","aiTitle":"Session restore","sessionId":"a"}"#,
        ]
        try lines.joined(separator: "\n").write(to: t.folder.appendingPathComponent("a.jsonl"), atomically: true, encoding: .utf8)
        try #"{"type":"ai-title","aiTitle":"Spin-off","sessionId":"b"}"#.write(to: t.folder.appendingPathComponent("b.jsonl"), atomically: true, encoding: .utf8)
        let a = t.activity(conversation: "a")
        XCTAssertEqual(a?.title, "Session restore")
        XCTAssertEqual(a?.prompt, "fix the resume", "tidied, and without the dictation marker")
        XCTAssertNotNil(a?.at)
        XCTAssertEqual(t.activity(conversation: "b")?.title, "Spin-off")
        XCTAssertNotNil(t.activity(conversation: nil), "with none remembered, the folder's newest")
        XCTAssertNil(Transcripts(project: "/nowhere", claudeHome: root).activity(conversation: nil))
    }

    func testSpeechOffAddsNothingAndResumeWorks() { // V7, S10
        XCTAssertEqual(SessionLaunch.arguments(resume: false, voice: false, genlockCommand: "genlock"), [])
        XCTAssertEqual(SessionLaunch.arguments(resume: true, voice: false, genlockCommand: nil), ["--continue"])
        XCTAssertEqual(SessionLaunch.arguments(resume: false, voice: true, genlockCommand: nil), [], "no genlock, so nothing could speak")
    }

    func testSessionsAreToldToSpotRabbitHoles() {
        let args = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock", spinoffs: true)
        let rule = args[args.firstIndex(of: "--append-system-prompt")! + 1]
        XCTAssertTrue(rule.contains("rabbit hole"))
        XCTAssertTrue(rule.contains("genlock spinoff propose"))
        XCTAssertTrue(rule.contains("Only on the user's yes"))
        XCTAssertTrue(rule.contains("genlock say"), "both rules together")
        XCTAssertEqual(args.filter { $0 == "--append-system-prompt" }.count, 1, "the flag can only be given once")
    }

    func testASpinOffStartsFromItsHandoffUnderItsClaimedSession() {
        let args = SessionLaunch.arguments(resume: false, voice: true, genlockCommand: "genlock", spinoffs: true, sessionID: "uuid-1", prompt: "You are a spin-off")
        XCTAssertEqual(args.first, "You are a spin-off", "ahead of the flags, which would swallow it")
        XCTAssertEqual(args[args.firstIndex(of: "--session-id")! + 1], "uuid-1", "so the guard recognises it as the claim's holder")
    }

    func testSpawnRequestsAreReadOnce() throws {
        let channel = VoiceChannel(session: "s2", base: root.appendingPathComponent("voice"))
        try channel.prepare()
        let req = #"{"ticket":"T-AAAAA","session":"u","title":"t","project":"/p","prompt":"go"}"#
        try req.write(to: channel.folder.appendingPathComponent("spawn-T-AAAAA.json"), atomically: true, encoding: .utf8)
        try "half".write(to: channel.folder.appendingPathComponent("spawn-T-BBBBB.json.tmp"), atomically: true, encoding: .utf8)
        let got = channel.takeSpawns()
        XCTAssertEqual(got.map(\.ticket), ["T-AAAAA"])
        XCTAssertTrue(channel.takeSpawns().isEmpty)
    }

    func testAReplyTravelsFromSayToTheApp() throws { // V4, V5, V6, V9
        let channel = VoiceChannel(session: "s1", base: root.appendingPathComponent("voice"))
        try channel.prepare()
        var withVoice = tools
        withVoice.environment["GENLOCK_APP_CHANNEL"] = channel.folder.path
        let before = try shell("git status --porcelain -uall")

        channel.markPending()
        XCTAssertEqual(try GenlockCLI.run(["voice-check"], in: repo, tools: withVoice).status, 2, "silent on a dictated turn: sent back")
        XCTAssertEqual(try GenlockCLI.run(["voice-check"], in: repo, tools: withVoice).status, 0, "typed turn: free to stop")
        XCTAssertTrue(channel.takeMessages().isEmpty)

        channel.markPending()
        _ = try GenlockCLI.run(["say", "first reply"], in: repo, tools: withVoice)
        _ = try GenlockCLI.run(["say", "second reply"], in: repo, tools: withVoice)
        XCTAssertEqual(try GenlockCLI.run(["voice-check"], in: repo, tools: withVoice).status, 0, "it spoke, so it may stop")
        XCTAssertEqual(channel.takeMessages(), ["first reply", "second reply"])
        XCTAssertTrue(channel.takeMessages().isEmpty, "each is spoken once")
        XCTAssertEqual(try shell("git status --porcelain -uall"), before, "voice touches nothing in the project")
        XCTAssertFalse(FileManager.default.fileExists(atPath: repo + "/.git/genlock"))
    }

    func testRepliesNameTheirProjectOnlyWhenNeeded() { // V8
        XCTAssertEqual(VoiceChannel.spoken("Done.", project: "budget", sessionsOpen: 1), "Done.")
        XCTAssertEqual(VoiceChannel.spoken("Done.", project: "budget", sessionsOpen: 2), "budget. Done.")
    }

    func testTheReplyVoiceIsAva() { // V11
        let ava = VoiceOption(identifier: "ava", name: "Ava", language: "en-US", isMale: false, quality: 1)
        let avaPremium = VoiceOption(identifier: "ava-p", name: "Ava (Premium)", language: "en-US", isMale: false, quality: 3)
        let samantha = VoiceOption(identifier: "sam", name: "Samantha", language: "en-US", isMale: false, quality: 2)
        let karen = VoiceOption(identifier: "karen", name: "Karen", language: "en-AU", isMale: false, quality: 3)
        XCTAssertEqual(VoiceOption.preferred(from: [samantha, karen, ava]), ava, "a basic Ava beats a better anyone else")
        XCTAssertEqual(VoiceOption.preferred(from: [ava, avaPremium, samantha]), avaPremium, "a downloaded voice is picked up")
        XCTAssertEqual(VoiceOption.preferred(from: [samantha, karen]), samantha, "American English if she is not installed")
        XCTAssertNil(VoiceOption.preferred(from: [karen]))
        XCTAssertNotNil(VoiceOption.upgradeHint(for: ava))
        XCTAssertNotNil(VoiceOption.upgradeHint(for: samantha))
        XCTAssertNil(VoiceOption.upgradeHint(for: avaPremium))
    }

    func testRulesTellAgentsToRegisterReviews() throws { // R6
        let out = try GenlockCLI.run(["install", "--only", "reviews"], in: repo, tools: tools)
        XCTAssertEqual(out.status, 0)
        let rules = try String(contentsOfFile: repo + "/AGENTS.md", encoding: .utf8)
        XCTAssertTrue(rules.contains("genlock review PATH"))
    }
}
