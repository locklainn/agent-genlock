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
        XCTAssertEqual(GenlockCLI.snapshot(of: repo, tools: ahead), .failure(.genlockTooOld))
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
