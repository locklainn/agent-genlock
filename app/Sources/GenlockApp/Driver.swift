import AppKit
import GenlockCore
import AVFoundation
import Speech
import UserNotifications

/// Runs the built app from a script of real input events, for testing. It posts events into
/// the app's own queue, so clicks go through the same path a mouse does, and needs no system
/// permissions. Inert unless GENLOCK_APP_DRIVE names a script.
@MainActor
enum Driver {
    static var isActive: Bool { ProcessInfo.processInfo.environment["GENLOCK_APP_DRIVE"] != nil }

    static func runIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["GENLOCK_APP_DRIVE"],
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let steps = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        Task { @MainActor in
            for step in steps { await run(step) }
        }
    }

    private static var pasteResults: [Bool] = []
    /// Simulated clicks do not reach panel rows, so a test asks for this state instead.
    static var expandQuestions = false

    private static var window: NSWindow? { NSApp.windows.first { $0.isVisible && $0.contentView != nil && !($0 is CelebrationPanel) } }

    private static func projectID(named name: String) -> String? {
        AppModel.shared.store.projects.first { $0.name == name }?.id
    }

    private static func postClick(at global: CGRect, shift: Bool) {
        guard let w = window, let height = w.contentView?.bounds.height else { return }
        let location = NSPoint(x: global.midX, y: height - global.midY)
        let flags: NSEvent.ModifierFlags = shift ? .shift : []
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: location, modifierFlags: flags,
                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                          context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                NSApp.postEvent(e, atStart: false)
            }
        }
    }

    private static func postFlags(_ flags: NSEvent.ModifierFlags, keyCode: UInt16) {
        guard let w = window, let e = NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: flags,
                                                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                                       context: nil, characters: "", charactersIgnoringModifiers: "",
                                                       isARepeat: false, keyCode: keyCode) else { return }
        NSApp.postEvent(e, atStart: false)
    }

    private static func postKey(_ type: NSEvent.EventType) {
        guard let w = window, let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: w.windowNumber, context: nil, characters: "\u{F703}", charactersIgnoringModifiers: "\u{F703}",
                                                       isARepeat: false, keyCode: 124) else { return }
        NSApp.postEvent(e, atStart: false)
    }

    private static func run(_ step: [String: Any]) async {
        let model = AppModel.shared
        if let s = step["wait"] as? Double { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
        if let name = step["clickCard"] as? String, let id = projectID(named: name), let frame = model.cardFrames[id] {
            let shift = step["shift"] as? Bool ?? false
            if shift { postFlags(.shift, keyCode: 56) }
            postClick(at: frame, shift: shift)
        }
        if let at = step["clickAt"] as? [Double] { postClick(at: CGRect(x: at[0], y: at[1], width: 0, height: 0), shift: false) }
        if step["releaseShift"] != nil { postFlags([], keyCode: 56) }
        if step["tapRightOption"] != nil {
            postFlags(.option, keyCode: 61)
            postFlags([], keyCode: 61)
        }
        if step["tapRightCommand"] != nil {
            postFlags(.command, keyCode: VoiceMachine.rightCommandKey)
            postFlags([], keyCode: VoiceMachine.rightCommandKey)
        }
        if step["dashboard"] != nil { model.route = .dashboard }
        if let args = step["icon"] as? [String], let id = projectID(named: args[0]) {
            model.setIcon(id, args[1].hasPrefix("sym:") ? .symbol(String(args[1].dropFirst(4))) : .emoji(args[1]))
        }
        if let args = step["setup"] as? [String], let id = projectID(named: args[0]) { model.setUp(id, flag: args[1]) }
        if let name = step["iconPicker"] as? String { model.iconTarget = projectID(named: name) }
        if let name = step["open"] as? String, let id = projectID(named: name) { model.openSessions([id]) }
        if let name = step["focus"] as? String, let focus = DashFocus(rawValue: name) { model.focusDashboard(focus) }
        if let path = step["addProject"] as? String { model.addProject(path: path) }
        if let args = step["tier"] as? [String], let id = projectID(named: args[0]), let tier = Tier(rawValue: args[1]) { model.move(id, to: tier) }
        if let args = step["dictate"] as? [String], let id = projectID(named: args[0]) { model.voice.submit(args[1], to: id) }
        if let args = step["type"] as? [String], let id = projectID(named: args[0]) { model.sessions[id]?.view.send(txt: args[1]) }
        // Dropped paths and a private pasteboard, so a test never touches the real clipboard.
        if let args = step["insertPaths"] as? [String], let id = projectID(named: args[0]) {
            _ = model.sessions[id]?.view.insert(paths: Array(args.dropFirst()))
        }
        if let args = step["pasteFrom"] as? [String], let id = projectID(named: args[0]), let view = model.sessions[id]?.view {
            let board = NSPasteboard(name: .init("com.locklainn.genlock.test"))
            board.clearContents()
            if args[1] == "text" { board.setString(args[2], forType: .string) }
            if args[1] == "image" { board.setData(try? Data(contentsOf: URL(fileURLWithPath: args[2])), forType: .tiff) }
            if args[1] == "file" { board.writeObjects([URL(fileURLWithPath: args[2]) as NSURL]) }
            pasteResults.append(view.pasteAttachment(from: board))
        }
        if let name = step["endSession"] as? String, let id = projectID(named: name) { model.endSession(id) }
        if let name = step["newSession"] as? String, let id = projectID(named: name) { model.newSession(in: id) }
        if let name = step["closeTab"] as? String, let id = projectID(named: name) { model.tuck(id) }
        if let name = step["endNoted"] as? String, let id = projectID(named: name), let s = model.sessions[id] {
            model.recentlyEnded = SessionMemory.noteEnded(SessionMemory.Open(project: s.projectID, spawn: s.spawn, slot: s.slot), in: model.recentlyEnded)
            model.endSession(id)
        }
        if let name = step["reopen"] as? String, let id = projectID(named: name), let open = model.recentlyEnded.first(where: { $0.key == id }) { model.reopen(open) }
        if step["restartToUpdate"] != nil { model.updater.restart() }
        if step["openAssistant"] != nil { model.openAssistant() }
        if step["pressRightArrow"] != nil { postKey(.keyDown) }
        if step["dismissUpdate"] != nil { model.dismissReplies() }
        if let p = step["clickAt"] as? [Double] { postClick(at: CGRect(x: p[0], y: p[1], width: 0, height: 0), shift: false) }
        if let text = step["sendReply"] as? String { model.voice.sendReply(text) }
        if step["talkKey"] != nil { model.pressVoice() }
        if step["escapeKey"] != nil, let w = window, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) { NSApp.postEvent(e, atStart: false) }
        if step["releaseRightArrow"] != nil { postKey(.keyUp) }
        if let speed = step["speechSpeed"] as? Double { model.voice.speechSpeed = speed }
        if let name = step["nameAssistant"] as? String { model.nameAssistant(name.isEmpty ? nil : name) }
        if step["letAssistantChoose"] != nil { model.nameAssistant(nil, letItChoose: true) }
        if let state = step["assistantPhase"] as? String { model.sessions[model.assistantFolder]?.phase = state }
        if let args = step["rank"] as? [String], let id = projectID(named: args[0]), let place = Int(args[2]) { model.rank(args[1], to: place, in: id) }
        if let args = step["due"] as? [String], let id = projectID(named: args[0]) { model.setDue(args[1], to: args[2].isEmpty ? nil : args[2], in: id) }
        if let text = step["speakSilently"] as? String { model.voice.speak(text, volume: 0) }
        if let args = step["askToComplete"] as? [String], let id = projectID(named: args[0]),
           let goal = model.state(for: id).snapshot?.goal(args[1]) { model.completingGoal = CompletingGoal(goal: goal, projectID: id) }
        if step["confirmComplete"] != nil, let c = model.completingGoal {
            model.completeGoal(c.goal, evidence: GoalCompletion.defaultEvidence(c.goal), in: c.projectID)
            model.completingGoal = nil
        }
        if let args = step["answerFirst"] as? [String], let id = projectID(named: args[0]), let q = model.state(for: id).snapshot?.questionsForUser.first { model.answerQuestion(q, args[1], in: id) }
        if step["expandQuestions"] != nil { expandQuestions = true }
        if let v = step["showCompleted"] as? Bool { model.showingCompleted = v }
        if step["clickCelebration"] != nil { CelebrationPresenter.clickForTest() }
        if let path = step["celebrationCapture"] as? String { CelebrationPresenter.capture(to: path) }
        if let cmd = step["shell"] as? String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", cmd]
            try? p.run()
            p.waitUntilExit()
        }
        if let args = step["terminalCapture"] as? [String], let id = projectID(named: args[0]), let view = model.sessions[id]?.view {
            terminalImage(of: view, to: args[1])
        }
        if let args = step["writeState"] as? [String], let id = projectID(named: args[0]), let s = model.sessions[id] {
            let session = args.count > 3 ? #","session":"\#(args[3])""# : ""
            let body = #"{"state":"\#(args[1])","message":"\#(args[2])","at":\#(Date().timeIntervalSince1970 * 1000)"# + session + "}"
            try? body.write(to: s.channel.folder.appendingPathComponent("state.json"), atomically: true, encoding: .utf8)
        }
        if let name = step["notificationClick"] as? String, let id = projectID(named: name) { model.showSession(id) }
        if step["hideApp"] != nil { NSApp.hide(nil) }
        if let path = step["deliveredReport"] as? String {
            UNUserNotificationCenter.current().getDeliveredNotifications { list in
                UNUserNotificationCenter.current().getNotificationSettings { settings in
                    let lines = list.map { "\($0.request.content.title) | \($0.request.content.body)" }
                    let out = "auth=\(settings.authorizationStatus.rawValue)\n" + lines.joined(separator: "\n")
                    try? out.write(toFile: path, atomically: true, encoding: .utf8)
                }
            }
        }
        if let path = step["snapshot"] as? String { snapshot(to: path) }
        if let path = step["report"] as? String { report(to: path) }
        if step["quit"] != nil {
            model.rememberSessions()
            NSApp.terminate(nil)
        }
    }

    private static func snapshot(to path: String) {
        guard let view = window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }

    /// Renders the layer itself, which includes the background a view snapshot leaves out.
    private static func terminalImage(of view: NSView, to path: String) {
        guard let layer = view.layer, let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width), pixelsHigh: Int(view.bounds.height),
                                                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return }
        layer.render(in: ctx.cgContext)
        view.displayIgnoringOpacity(view.bounds, in: ctx)
        ctx.flushGraphics()
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }

    /// For each pane: does a point in the middle land on a registered drop target, and does Paste reach this terminal?
    private static func paneReport() -> [[String: Any]] {
        AppModel.shared.sessions.values.map { s in
            let view = s.view
            var dropTarget = ""
            if let root = view.window?.contentView {
                let middle = root.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), from: view)
                var v = root.hitTest(middle)
                while let found = v, !found.registeredDraggedTypes.contains(.fileURL) { v = found.superview }
                dropTarget = v.map { String(describing: type(of: $0)) } ?? "none"
            }
            view.window?.makeFirstResponder(view)
            let pasteItem = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items).first { $0.action == #selector(NSText.paste(_:)) }
            return ["label": s.label, "dropTarget": dropTarget,
                    "pasteReachesTerminal": NSApp.target(forAction: #selector(NSText.paste(_:))) as AnyObject === view,
                    "pasteKey": pasteItem?.keyEquivalent ?? "<no menu item>"]
        }
    }

    private static func report(to path: String) {
        let model = AppModel.shared
        var cards: [String: Any] = [:]
        for p in model.store.projects {
            let snap = model.state(for: p.id).snapshot
            cards[p.name] = [
                "tier": p.tier.rawValue,
                "goal": snap.flatMap { CardSummary($0).goalTitle } ?? "",
                "last": snap.flatMap { CardSummary($0).lastTaskTitle } ?? "",
                "error": model.state(for: p.id).error?.description ?? "",
                "changed": Array(model.state(for: p.id).recentlyChanged),
                "reviews": snap?.openReviews.count ?? 0,
                "activityTitle": model.state(for: p.id).activity?.title ?? "",
                "activityPrompt": model.state(for: p.id).activity?.prompt ?? "",
            ]
        }
        let out: [String: Any] = [
            "route": model.route == .dashboard ? "dashboard" : "sessions",
            "visible": model.visible.map { URL(fileURLWithPath: $0).lastPathComponent },
            "running": model.sessions.filter(\.value.isRunning).keys.map { URL(fileURLWithPath: $0).lastPathComponent }.sorted(),
            "marked": model.markedCount,
            "terminalFrames": Dictionary(uniqueKeysWithValues: model.sessions.values.map { s in
                (s.label, ["\(s.view.frame)", "inWindow=\(s.view.window != nil)", "isFirstResponder=\(s.view.window?.firstResponder === s.view)", "grid=\(s.cols)x\(s.rows)"])
            }),
            "cardFrames": Dictionary(uniqueKeysWithValues: model.store.projects.map { p in
                (p.name, model.cardFrames[p.id].map { [Int($0.minX), Int($0.minY), Int($0.width), Int($0.height)] } ?? [])
            }),
            "message": model.message ?? "",
            "initialized": Dictionary(uniqueKeysWithValues: model.store.projects.map { ($0.name, model.state(for: $0.id).snapshot?.initialized ?? false) }),
            "needing": model.needingAttention.map(\.label),
            "tucked": model.tucked.sorted(),
            "recentlyEnded": model.recentlyEnded.map(\.key),
            "tabLabels": model.sessions.keys.sorted().map { model.tabLabel($0) },
            "dockBadge": NSApp.dockTile.badgeLabel ?? "",
            "active": NSApp.isActive,
            "cards": cards,
            "spoken": model.voice.lastSpoken ?? "",
            "voice": model.voice.chosenVoice?.name ?? "",
            "pasteResults": pasteResults,
            "assistantName": model.assistantName,
            "genlockTool": model.tools?.genlockArgv ?? [],
            "sessionPathStart": model.tools?.environment["PATH"]?.split(separator: ":").first.map(String.init) ?? "",
            "celebrating": CelebrationPresenter.current?.title ?? "",
            "celebrationsShown": CelebrationPresenter.shownTitles,
            "celebrationFrame": CelebrationPresenter.frameDescription,
            "screenFrame": "\(NSScreen.main?.frame ?? .zero)",
            "completedGoals": model.completedGoalCount,
            "voiceReached": model.voice.reached,
            "replyTo": model.voice.replyTo.map { URL(fileURLWithPath: $0.session).lastPathComponent } ?? "",
            "focused": model.focusedProject.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "",
            "voiceHeld": model.voice.speedHeld,
            "voiceSpeed": model.voice.speechSpeed,
            "voiceSpeakingText": model.voice.speakingText ?? "",
            "askingName": model.askingAssistantName,
            "voiceWaiting": model.voice.waitingReplies,
            "voiceWaitingFrom": model.voice.waitingFrom,
            "voiceDings": model.voice.dings,
            "voiceSpeaking": model.voice.isSpeaking,
            "update": "\(model.updater.state)",
            "panes": paneReport(),
            "voiceState": "\(model.voice.machine.state)",
            "voiceTarget": model.voice.target ?? "",
            "voicePartial": model.voice.partial,
            "voiceLevel": model.voice.level,
            "voiceProblem": model.voice.problem ?? "",
            "speechAuth": SFSpeechRecognizer.authorizationStatus().rawValue,
            "micAuth": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
            "recognizer": model.voice.recognizerReport,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}
