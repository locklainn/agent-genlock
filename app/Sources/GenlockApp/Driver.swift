import AppKit
import GenlockCore
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

    private static var window: NSWindow? { NSApp.windows.first { $0.isVisible && $0.contentView != nil } }

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

    private static func run(_ step: [String: Any]) async {
        let model = AppModel.shared
        if let s = step["wait"] as? Double { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
        if let name = step["clickCard"] as? String, let id = projectID(named: name), let frame = model.cardFrames[id] {
            let shift = step["shift"] as? Bool ?? false
            if shift { postFlags(.shift, keyCode: 56) }
            postClick(at: frame, shift: shift)
        }
        if step["releaseShift"] != nil { postFlags([], keyCode: 56) }
        if step["tapRightOption"] != nil {
            postFlags(.option, keyCode: 61)
            postFlags([], keyCode: 61)
        }
        if step["dashboard"] != nil { model.route = .dashboard }
        if let args = step["icon"] as? [String], let id = projectID(named: args[0]) {
            model.setIcon(id, args[1].hasPrefix("sym:") ? .symbol(String(args[1].dropFirst(4))) : .emoji(args[1]))
        }
        if let args = step["setup"] as? [String], let id = projectID(named: args[0]) { model.setUp(id, flag: args[1]) }
        if let name = step["setGoal"] as? String, let id = projectID(named: name) { model.setGoal(id) }
        if let name = step["iconPicker"] as? String { model.iconTarget = projectID(named: name) }
        if let name = step["open"] as? String, let id = projectID(named: name) { model.openSessions([id]) }
        if let name = step["focus"] as? String, let focus = DashFocus(rawValue: name) { model.focusDashboard(focus) }
        if let path = step["addProject"] as? String { model.addProject(path: path) }
        if let args = step["tier"] as? [String], let id = projectID(named: args[0]), let tier = Tier(rawValue: args[1]) { model.move(id, to: tier) }
        if let args = step["dictate"] as? [String], let id = projectID(named: args[0]) { model.voice.submit(args[1], to: id) }
        if let args = step["type"] as? [String], let id = projectID(named: args[0]) { model.sessions[id]?.view.send(txt: args[1]) }
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
            let body = #"{"state":"\#(args[1])","message":"\#(args[2])","at":\#(Date().timeIntervalSince1970 * 1000)}"#
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
        if step["quit"] != nil { NSApp.terminate(nil) }
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
            ]
        }
        let out: [String: Any] = [
            "route": model.route == .dashboard ? "dashboard" : "sessions",
            "visible": model.visible.map { URL(fileURLWithPath: $0).lastPathComponent },
            "running": model.sessions.filter(\.value.isRunning).keys.map { URL(fileURLWithPath: $0).lastPathComponent }.sorted(),
            "marked": model.markedCount,
            "cardFrames": Dictionary(uniqueKeysWithValues: model.store.projects.map { p in
                (p.name, model.cardFrames[p.id].map { [Int($0.minX), Int($0.minY), Int($0.width), Int($0.height)] } ?? [])
            }),
            "message": model.message ?? "",
            "initialized": Dictionary(uniqueKeysWithValues: model.store.projects.map { ($0.name, model.state(for: $0.id).snapshot?.initialized ?? false) }),
            "needing": model.needingAttention.map(\.label),
            "dockBadge": NSApp.dockTile.badgeLabel ?? "",
            "active": NSApp.isActive,
            "cards": cards,
            "spoken": model.voice.lastSpoken ?? "",
            "voice": model.voice.chosenVoice?.name ?? "",
            "voiceState": "\(model.voice.machine.state)",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }
}
