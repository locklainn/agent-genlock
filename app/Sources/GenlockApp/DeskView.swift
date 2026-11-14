import AppKit
import AVFoundation
import GenlockCore
import SwiftUI

// The Phone window: the phone app on the Mac, for when TJ is at the desk and wants his news the
// phone's way. It is a second client of the phone bridge (mobile/bridge/desk.mjs), so the thread,
// the items and the answer format are the phone's own; the walk rules are DeskWalk, ported from the
// phone's WalkPlan. It connects only while the window is open: opt-in, never in the way.

/// One line of the thread.
struct DeskLine: Identifiable, Equatable {
    enum Who { case me, laptop, assistant, info }
    enum Stage { case sending, delivered, picked, failed }
    let id: String
    let who: Who
    let text: String
    let at: Date
    var stage: Stage = .delivered
}

@MainActor @Observable
final class DeskModel {
    static let shared = DeskModel()

    enum Phase { case idle, reading, answering, counting, waiting }

    private(set) var conn: DeskConnection.State = .connecting
    private(set) var assistant = "unknown"
    private(set) var assistantName = "Tally"
    private(set) var lines: [DeskLine] = []
    private(set) var pending: [DeskItem] = []
    private(set) var walked: [DeskItem] = []
    private(set) var held: [DeskAnswer] = []
    /// The arrival screen's line while it shows: "Three updates, one question."
    private(set) var arriving: String?
    private(set) var active = false
    private(set) var phase: Phase = .idle
    /// The sentence being read now, for the caption.
    private(set) var caption = ""
    /// When the walk moves on by itself after an update, for the bar that drains over it.
    private(set) var countdownEnds: Date?
    private(set) var flash: String?
    private(set) var waiting = false
    /// The Mac grid the bridge pushes: what every session is doing, for the At work screen.
    private(set) var grid: DeskGrid?
    /// The text thread, opened on purpose; the dash is what shows otherwise, as on the phone.
    var showThread = false
    var speakOn: Bool = UserDefaults.standard.object(forKey: "desk.speak") as? Bool ?? true {
        didSet { UserDefaults.standard.set(speakOn, forKey: "desk.speak"); if !speakOn { stopSpeaking() } }
    }

    @ObservationIgnored private var link: DeskConnection?
    @ObservationIgnored private var heardKeys: Set<String> = []
    @ObservationIgnored private var movedAt: Int64 = 0
    /// The newest bridge message seen, kept across launches so reopening catches up on what was missed
    /// and no more. The first time ever it starts now: old history is not walked as news.
    @ObservationIgnored private var lastSeen: Int64 = {
        let saved = (UserDefaults.standard.object(forKey: "desk.lastSeen") as? NSNumber)?.int64Value ?? 0
        return saved > 0 ? saved : Int64(Date().timeIntervalSince1970 * 1000)
    }() {
        didSet { if lastSeen != oldValue { UserDefaults.standard.set(NSNumber(value: lastSeen), forKey: "desk.lastSeen") } }
    }
    @ObservationIgnored private var replies: [String: String] = [:]
    @ObservationIgnored private var token = 0
    @ObservationIgnored private let speaker = GenlockSpeaker()
    @ObservationIgnored private let synth = AVSpeechSynthesizer()
    @ObservationIgnored private let synthDone = SynthDone()
    @ObservationIgnored private var opens = 0

    static let arriveSeconds = 2.4
    static let moveOnSeconds = 4.0

    var now: DeskItem? { pending.first }
    var answered: Int { held.filter { $0.answer != nil }.count }

    // MARK: connection

    func open() {
        opens += 1
        guard link == nil else { return }
        synth.delegate = synthDone
        let c = DeskConnection(lastSeen: lastSeen,
            onMessage: { m in MainActor.assumeIsolated { DeskModel.shared.receive(m) } },
            onState: { s in MainActor.assumeIsolated { DeskModel.shared.conn = s } })
        link = c
        c.start()
    }

    func close() {
        opens = max(0, opens - 1)
        guard opens == 0 else { return }
        pause()
        link?.stop()
        link = nil
    }

    private func post(_ m: [String: Any]) async -> Bool {
        guard let link else { return false }
        do { try await link.post(m); return true } catch { return false }
    }

    /// Sends what TJ typed, as the phone's message box does.
    func say(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let id = UUID().uuidString
        lines.append(DeskLine(id: id, who: .me, text: t, at: Date(), stage: .sending))
        waiting = true
        Task {
            if await !post(["id": id, "kind": "say", "text": t]) { mark(id, .failed); waiting = false }
        }
    }

    func retry(_ line: DeskLine) {
        lines.removeAll { $0.id == line.id }
        say(line.text)
    }

    private func mark(_ id: String, _ stage: DeskLine.Stage) {
        if let i = lines.firstIndex(where: { $0.id == id && $0.who == .me }) { lines[i].stage = stage }
    }

    private func receive(_ m: [String: Any]) {
        let t = (m["t"] as? NSNumber)?.int64Value ?? Int64(Date().timeIntervalSince1970 * 1000)
        lastSeen = max(lastSeen, t)
        let at = Date(timeIntervalSince1970: Double(t) / 1000)
        switch m["kind"] as? String {
        case "state":
            if let a = m["assistant"] as? String { assistant = a }
            if let n = m["assistantName"] as? String, !n.isEmpty { assistantName = n }
            if m["laptop"] as? String == "offline" { assistant = "unknown" }
        case "ack":
            guard let of = m["of"] as? String else { return }
            if m["queued"] as? Bool == true {
                lines.append(DeskLine(id: UUID().uuidString, who: .info, text: "\(assistantName) was not open, so it is starting with your message.", at: at))
            }
            mark(of, .delivered)
        case "started":
            if let of = m["of"] as? String { mark(of, .picked) }
        case "error":
            if let of = m["of"] as? String { mark(of, .failed); waiting = false }
            if let text = m["text"] as? String { flash = text }
        case "prompt":
            let id = (m["turn"] as? String) ?? (m["id"] as? String) ?? UUID().uuidString
            if !lines.contains(where: { $0.id == id }) { lines.append(DeskLine(id: id, who: .laptop, text: (m["text"] as? String) ?? "", at: at)) }
        case "reply":
            let id = (m["turn"] as? String) ?? (m["id"] as? String) ?? UUID().uuidString
            guard !lines.contains(where: { $0.id == id }) else { return }
            let text = (m["text"] as? String) ?? ""
            lines.append(DeskLine(id: id, who: .assistant, text: text, at: at))
            replies[id] = text
            waiting = false
            let re = youSaid(m)
            let items = DeskWalk.items(fromReply: m, at: t, re: re.map { String($0.prefix(400)) })
            // Not walked: a reply to TJ at the laptop (he read it there), or one from before the moved-on mark.
            let walk = (m["walk"] as? Bool ?? true) && t >= movedAt
            guard walk, !items.isEmpty, !pending.contains(where: { p in items.contains { $0.id == p.id } }) else { return }
            merge(items)
            arrive()
        case "grid":
            grid = DeskGrid(m)
        case "moved":
            let mark = (m["at"] as? NSNumber)?.int64Value ?? 0
            if mark > movedAt { movedAt = mark }
            let kept = DeskWalk.current(pending, mark: movedAt, keepHead: active)
            let n = pending.count - kept.count
            if n > 0 {
                pending = kept
                flash = "Dropped \(n) older item\(n == 1 ? "" : "s"): you carried on elsewhere."
                if pending.isEmpty && active { finish() }
            }
        default: break
        }
    }

    /// The words of TJ's this reply answers: the desk's own message the bridge names, else the prompt as typed.
    private func youSaid(_ m: [String: Any]) -> String? {
        if let of = m["reOf"] as? String, let mine = lines.first(where: { $0.id == of && $0.who == .me }) { return mine.text }
        let re = (m["re"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return re.isEmpty ? nil : re
    }

    private func merge(_ items: [DeskItem]) {
        // A new update after the last one was walked through: its steps start a fresh bar.
        if !active && pending.isEmpty && phase != .answering { walked = [] }
        let head = active ? Array(pending.prefix(1)) : []
        let keys = active ? heardKeys.union(head.map(\.key)) : []
        pending = head + DeskWalk.merge(Array(pending.dropFirst(head.count)), items, heard: keys)
    }

    // MARK: the walk

    /// A reply came in: announce it, then walk it. A walk already on picks the new items up in place.
    func arrive() {
        guard !active, arriving == nil, phase != .answering, !pending.isEmpty else { return }
        let line = DeskWalk.arrivalLine(items: pending.count, questions: pending.filter(\.isQuestion).count)
        arriving = line
        token += 1
        let my = token
        var shown = false, said = false
        let go = { [weak self] in
            guard let self, my == self.token, shown, said, self.arriving != nil else { return }
            self.start()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.arriveSeconds) { shown = true; go() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { said = true; go() }
        speak(line, project: nil) { said = true; go() }
    }

    func start() {
        arriving = nil
        guard !pending.isEmpty else { finish(); return }
        if !active { heardKeys = [] }
        active = true
        read()
    }

    /// Reads the item at the head of the queue, then waits for an answer (a question) or moves on (an update).
    private func read() {
        guard let item = now else { finish(); return }
        token += 1
        let my = token
        countdownEnds = nil
        phase = .reading
        speak(item.spoken, project: item.project) { [weak self] in
            guard let self, my == self.token, self.active else { return }
            if item.isQuestion { self.phase = .answering; return }
            // Something to open (a document, an image, a link): it stays until TJ clicks next.
            if item.waitsForTap(links: self.linksShown(item)) { self.phase = .waiting; return }
            self.phase = .counting
            self.countdownEnds = Date().addingTimeInterval(Self.moveOnSeconds)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.moveOnSeconds) { [weak self] in
                guard let self, my == self.token, self.phase == .counting else { return }
                self.next()
            }
        }
    }

    /// The links shown on `item`: in its own words, or in the reply where its paragraph names it.
    func linksShown(_ item: DeskItem) -> [DeskLinkRef] {
        guard let r = lines.last(where: { $0.who == .assistant && item.id.hasPrefix($0.id + "-") }) else { return DeskWalk.links(for: item, reply: nil, siblings: [item]) }
        return DeskWalk.links(for: item, reply: r.text, siblings: (walked + pending).filter { $0.id.hasPrefix(r.id + "-") })
    }

    /// TJ started typing an answer: the walk holds still for him.
    func holdForAnswer() {
        guard active, phase == .counting || phase == .reading || phase == .waiting else { return }
        token += 1
        countdownEnds = nil
        if phase == .reading { stopSpeaking() }
        phase = .answering
    }

    func answer(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let item = now, !t.isEmpty else { return }
        heard(item, DeskAnswer(item: item, answer: t))
        advance()
    }

    /// Skip: a question skipped is reported as heard but not answered.
    func next() {
        guard let item = now else { return }
        heard(item, item.isQuestion ? DeskAnswer(item: item, skipped: true) : DeskAnswer(item: item))
        advance()
    }

    func repeatItem() {
        if !active { active = true }
        read()
    }

    /// Go back to step `to` (0: start the whole update over) and play on from there, whether the
    /// walk is playing, paused or finished.
    func rewind(to: Int) {
        let r = DeskWalk.rewind(walked: walked, pending: pending, to: to)
        walked = r.walked
        pending = r.pending
        token += 1
        stopSpeaking()
        arriving = nil
        active = true
        read()
    }

    func jump(to item: DeskItem) {
        pending = [item] + pending.filter { $0.id != item.id }
        if active { read() }
    }

    func pause() {
        token += 1
        stopSpeaking()
        countdownEnds = nil
        active = false
        arriving = nil
        phase = .idle
    }

    /// Send the answers so far as one batch and end the walk; unheard items stay for next time.
    func flush() {
        pause()
        sendAnswers()
    }

    private func heard(_ item: DeskItem, _ answer: DeskAnswer) {
        heardKeys.insert(item.key)
        walked = walked.filter { $0.id != item.id } + [item]
        pending.removeAll { $0.id == item.id }
        // Heard again after a rewind: a real answer replaces the old one; a pass keeps it.
        if answer.answer != nil || answer.skipped || !held.contains(where: { $0.item.id == item.id }) {
            held.removeAll { $0.item.id == item.id }
            held.append(answer)
        }
    }

    private func advance() {
        stopSpeaking()
        if pending.isEmpty { finish() } else if active { read() } else { phase = .idle }
    }

    private func finish() {
        token += 1
        active = false
        phase = .idle
        countdownEnds = nil
        arriving = nil
        sendAnswers()
    }

    private func sendAnswers() {
        let batch = held
        guard let msg = DeskWalk.answersMessage(batch, left: pending.count) else { held = []; return }
        let id = UUID().uuidString
        var m = msg
        m["id"] = id
        held = []
        lines.append(DeskLine(id: id, who: .me, text: (msg["text"] as? String) ?? "", at: Date(), stage: .sending))
        waiting = true
        Task {
            if await !post(m) {
                mark(id, .failed)
                waiting = false
                held = batch + held
                flash = "Not connected. Your answers are kept and go once connected."
            }
        }
    }

    func dismissFlash() { flash = nil }

    // MARK: voice

    /// Reads `text` in the project's Genlock voice, the system voice if that cannot be had. Silent
    /// (at once) when reading aloud is off.
    private func speak(_ text: String, project: String?, done: @escaping () -> Void) {
        caption = text
        // A driven test run walks silently, so it never talks over whoever is at the Mac.
        guard speakOn, ProcessInfo.processInfo.environment["GENLOCK_DESK_QUIET"] == nil else { done(); return }
        let root = project.flatMap { Self.root(for: $0) }
        let fallback = { [weak self] in
            guard let self else { return }
            self.synthDone.onEnd = done
            self.synth.speak(AVSpeechUtterance(string: text))
        }
        guard GenlockSpeaker.isInstalled else { fallback(); return }
        speaker.speak(text, root: root, speed: 1, tools: AppModel.shared.tools,
                      onSentence: { [weak self] s in self?.caption = s },
                      onEnd: { spoke in if spoke { done() } else { fallback() } })
    }

    private func stopSpeaking() {
        speaker.stop()
        synthDone.onEnd = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    /// The folder of the project an item names: by folder name, then loosely ("genlock" finds agent-genlock).
    static func root(for project: String) -> String? {
        let p = project.trimmingCharacters(in: .whitespaces).lowercased()
        guard !p.isEmpty else { return nil }
        let all = AppModel.shared.store.projects
        return (all.first { $0.name.lowercased() == p } ?? all.first { $0.name.lowercased().contains(p) })?.path
    }
}

private final class SynthDone: NSObject, AVSpeechSynthesizerDelegate {
    var onEnd: (() -> Void)?
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        DispatchQueue.main.async { let f = self.onEnd; self.onEnd = nil; f?() }
    }
}

// MARK: - views

private let ink = rgb(0x0F0F12)
private let questionColor = rgb(0xF2B84B)
private let doneColor = rgb(0x7BD88F)
private let blockedColor = rgb(0xFF6B6B)
private func rgb(_ v: Int) -> Color {
    let r = Double((v >> 16) & 0xFF) / 255, g = Double((v >> 8) & 0xFF) / 255, b = Double(v & 0xFF) / 255
    return Color(red: r, green: g, blue: b)
}
private let hueValues: [Int] = [0x5B3FD9, 0x1E7A6B, 0xB0413E, 0x2F6BD1, 0x8A3FA6, 0xB8721D, 0x2E8540, 0x9C2F6B]
private let hues: [Color] = hueValues.map(rgb)

/// The same colour the phone gives a project: Java's String.hashCode, floor-mod the palette.
func deskProjectColor(_ name: String) -> Color {
    var h: Int32 = 0
    for u in name.lowercased().utf16 { h = h &* 31 &+ Int32(u) }
    let n = Int32(hues.count)
    return hues[Int(((h % n) + n) % n)]
}

struct DeskView: View {
    @State private var model = DeskModel.shared

    var body: some View {
        ZStack {
            ink.ignoresSafeArea()
            if let line = model.arriving {
                ArrivalCard(name: model.assistantName, line: line, projects: projects) { model.start() }
            } else if model.now != nil {
                WalkCard(model: model)
            } else if model.showThread {
                ThreadPane(model: model)
            } else {
                DashPane(model: model)
            }
        }
        .overlay(alignment: .top) { header }
        .overlay(alignment: .bottom) {
            if let f = model.flash {
                Text(f).font(.system(size: 12)).padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Capsule().fill(Color.white.opacity(0.15))).padding(.bottom, 90)
                    .onTapGesture { model.dismissFlash() }
                    .task(id: f) { try? await Task.sleep(nanoseconds: 5_000_000_000); model.dismissFlash() }
            }
        }
        .foregroundStyle(.white)
        .frame(minWidth: 420, minHeight: 640)
        .preferredColorScheme(.dark)
        .onAppear { model.open() }
        .onDisappear { model.close() }
    }

    private var projects: [String] {
        var seen: [String] = []
        for p in model.pending.map(\.project) where !p.isEmpty && !seen.contains(where: { $0.caseInsensitiveCompare(p) == .orderedSame }) { seen.append(p) }
        return seen
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(dot).frame(width: 7, height: 7)
            Text(status).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.7))
            Spacer()
            if model.now == nil && model.arriving == nil {
                Button { model.showThread.toggle() } label: {
                    Image(systemName: model.showThread ? "rectangle.portrait.fill" : "text.bubble")
                }
                .buttonStyle(.borderless).foregroundStyle(.white.opacity(0.8))
                .help(model.showThread ? "Back to the dash" : "The full text thread")
            }
            Button { model.speakOn.toggle() } label: {
                Image(systemName: model.speakOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
            }
            .buttonStyle(.borderless).foregroundStyle(.white.opacity(0.8))
            .help(model.speakOn ? "Reading aloud is on" : "Reading aloud is off: on screen only")
        }
        .padding(.horizontal, 16).padding(.top, 10)
    }

    private var dot: Color {
        switch model.conn {
        case .connected: return model.assistant == "busy" ? questionColor : doneColor
        case .connecting: return .gray
        case .noBridge: return blockedColor
        }
    }

    private var status: String {
        switch model.conn {
        case .noBridge: return "The phone bridge is not running"
        case .connecting: return "Connecting…"
        case .connected:
            switch model.assistant {
            case "busy": return "\(model.assistantName) is working"
            case "closed": return "\(model.assistantName) is closed: a message starts it"
            case "starting": return "\(model.assistantName) is starting"
            default: return "\(model.assistantName) is listening"
            }
        }
    }
}

private struct ArrivalCard: View {
    let name: String
    let line: String
    let projects: [String]
    let start: () -> Void
    @State private var pulse = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Circle().fill(questionColor.opacity(0.35)).frame(width: 132, height: 132)
                    .scaleEffect(pulse ? 1.18 : 1).opacity(pulse ? 0.42 : 0.6)
                Circle().fill(.white).frame(width: 96, height: 96)
                Image(systemName: "waveform").font(.system(size: 44, weight: .semibold)).foregroundStyle(ink)
            }
            .padding(.bottom, 36)
            Text("\(name) replied").font(.system(size: 34, weight: .heavy)).multilineTextAlignment(.center)
            Text(String(line.dropLast())).font(.system(size: 19, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).padding(.top, 12)
            if !projects.isEmpty {
                Text(projects.prefix(4).joined(separator: ", ") + (projects.count > 4 ? " and \(projects.count - 4) more" : ""))
                    .font(.system(size: 15)).foregroundStyle(.white.opacity(0.65)).padding(.top, 6)
            }
            Text("Walking you through it…").font(.system(size: 15, weight: .medium)).foregroundStyle(questionColor).padding(.top, 40)
            Text("Click to start now").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).padding(.top, 6)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: start)
        .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true } }
    }
}

private struct WalkCard: View {
    @Bindable var model: DeskModel
    @State private var draft = ""
    /// A review: the image on screen, and each image's comment (the box holds the one on screen).
    @State private var page = 0
    @State private var comments: [Int: String] = [:]
    @FocusState private var typing: Bool

    var body: some View {
        if let now = model.now {
            let accent = deskProjectColor(now.project.isEmpty ? model.assistantName : now.project)
            VStack(alignment: .leading, spacing: 0) {
                Segments(walked: model.walked.count, pending: model.pending, active: model.active) { n in
                    // An earlier step goes back to it, the one playing starts again, a later one jumps ahead.
                    if n < model.walked.count { model.rewind(to: n) }
                    else if n == model.walked.count { model.repeatItem() }
                    else if model.pending.indices.contains(n - model.walked.count) { model.jump(to: model.pending[n - model.walked.count]) }
                }
                .padding(.top, 34)
                HStack {
                    Text("DIGEST  ·  \(model.walked.count + 1) OF \(model.walked.count + model.pending.count)")
                        .font(.system(size: 11, weight: .medium)).tracking(1.6).foregroundStyle(.white.opacity(0.7))
                    Spacer()
                    if model.answered > 0 {
                        Button { model.flush() } label: { Label("Send \(model.answered)", systemImage: "paperplane.fill") }
                            .buttonStyle(.plain).padding(.horizontal, 12).padding(.vertical, 5)
                            .background(Capsule().fill(.white.opacity(0.18)))
                    }
                }
                .padding(.top, 10)

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text((now.task.isEmpty ? (now.project.isEmpty ? "Reply" : now.project) : (now.project.isEmpty ? model.assistantName : now.project)).uppercased())
                            .font(.system(size: 13, weight: .bold)).tracking(2).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                        Text(now.task.isEmpty ? model.assistantName : now.task)
                            .font(.system(size: 34, weight: .heavy)).lineLimit(4).padding(.top, 4)
                        if let re = now.re {
                            HStack(alignment: .top, spacing: 10) {
                                Capsule().fill(.white.opacity(0.4)).frame(width: 3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("YOU SAID").font(.system(size: 10, weight: .medium)).tracking(1.4).foregroundStyle(.white.opacity(0.6))
                                    Text(re).font(.system(size: 14)).foregroundStyle(.white.opacity(0.85)).lineLimit(3)
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 12)
                        }
                        KindTag(item: now).padding(.top, 10)
                        Text(now.say.replacingOccurrences(of: #"[*`#_]"#, with: "", options: .regularExpression))
                            .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white.opacity(0.92))
                            .textSelection(.enabled).padding(.top, 14)
                        if let ask = now.ask {
                            Text(ask).font(.system(size: 20, weight: .bold)).foregroundStyle(questionColor).padding(.top, 12)
                        }
                        if !now.images.isEmpty {
                            ReviewImages(images: now.images, page: page, commented: commentedPages) { turn(to: $0, images: now.images) }
                                .padding(.top, 14)
                        }
                        if !now.files.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(now.files, id: \.fid) { f in
                                    Button { if let p = f.path { NSWorkspace.shared.open(URL(fileURLWithPath: p)) } } label: {
                                        Label(f.label, systemImage: "doc.text").font(.system(size: 13, weight: .semibold))
                                    }
                                    .buttonStyle(.plain).padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.12)))
                                    .contextMenu { if let p = f.path { Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) } } }
                                    .help(f.path ?? f.name)
                                }
                            }
                            .padding(.top, 14)
                        }
                        let links = model.linksShown(now)
                        let holds = now.waitsForTap(links: links)
                        if !links.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(links) { l in
                                    Button { if let u = URL(string: l.url) { NSWorkspace.shared.open(u) } } label: {
                                        Label(l.label, systemImage: "arrow.up.right.square").font(.system(size: 13, weight: .semibold))
                                    }
                                    .buttonStyle(.plain).padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.12)))
                                }
                            }
                            .padding(.top, 14)
                        }
                        if holds && !now.isQuestion {
                            Text("Take your time. Click next when you're done.").font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.white.opacity(0.7)).padding(.top, 10)
                        }
                        if now.late {
                            Text("Came in while we talked").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.7)).padding(.top, 6)
                        }
                        if let next = model.pending.dropFirst().first {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("NEXT").font(.system(size: 10, weight: .medium)).tracking(1.6).foregroundStyle(.white.opacity(0.5))
                                Button { model.jump(to: next) } label: {
                                    Text((next.label.isEmpty ? next.say : next.label) + (model.pending.count > 2 ? "  +\(model.pending.count - 2)" : ""))
                                        .font(.system(size: 13)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                                }.buttonStyle(.plain)
                            }
                            .padding(.top, 22)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 18)
                }

                if let ends = model.countdownEnds { CountdownBar(ends: ends).padding(.bottom, 8) }
                transport
                answerBox(now).padding(.top, 10)
            }
            .padding(.horizontal, 22).padding(.bottom, 16)
            .background(LinearGradient(stops: [.init(color: accent, location: 0), .init(color: accent.opacity(0.35), location: 0.55), .init(color: ink, location: 1)],
                                       startPoint: .top, endPoint: .bottom).ignoresSafeArea())
            .animation(.easeInOut(duration: 0.6), value: now.project)
            .onChange(of: model.phase) { _, p in if p == .answering { typing = true } }
            .onChange(of: now.id) { _, _ in draft = ""; page = 0; comments = [:] }
        }
    }

    private var transport: some View {
        HStack(spacing: 28) {
            Spacer()
            Button { model.rewind(to: 0) } label: { Image(systemName: "backward.end.fill").font(.system(size: 22)) }
                .buttonStyle(.plain).help("Start over from the first step").keyboardShortcut(.leftArrow, modifiers: [.command, .shift])
            Button { model.repeatItem() } label: { Image(systemName: "gobackward").font(.system(size: 22)) }
                .buttonStyle(.plain).help("Repeat").keyboardShortcut("r", modifiers: [.command])
            Button { if model.active { model.pause() } else { model.start() } } label: {
                Image(systemName: model.active ? "pause.fill" : "play.fill").font(.system(size: 26)).foregroundStyle(ink)
                    .frame(width: 64, height: 64).background(Circle().fill(.white))
            }
            .buttonStyle(.plain).help(model.active ? "Pause" : "Play").keyboardShortcut(.space, modifiers: [])
            Button { model.next() } label: { Image(systemName: "forward.end.fill").font(.system(size: 22)) }
                .buttonStyle(.plain).help("Next (skip)").keyboardShortcut(.rightArrow, modifiers: [.command])
            Spacer()
        }
        .overlay(alignment: .leading) {
            Text(phaseLabel).font(.system(size: 10, weight: .medium)).tracking(1.4).foregroundStyle(.white.opacity(0.55))
        }
    }

    private var phaseLabel: String {
        switch model.phase {
        case .idle: return "PAUSED"
        case .reading: return "READING"
        case .answering: return "YOUR ANSWER"
        case .counting: return "MOVING ON"
        case .waiting: return "YOUR PACE"
        }
    }

    @ViewBuilder private func answerBox(_ now: DeskItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !now.options.isEmpty {
                FlowRow(now.options) { o in
                    Button { model.answer(o) } label: { Text(o).font(.system(size: 14, weight: .semibold)).foregroundStyle(ink) }
                        .buttonStyle(.plain).padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Capsule().fill(.white))
                }
            }
            if now.images.count > 1 {
                let done = commentedPages.count
                Button { finishReview() } label: {
                    Label("Finish review  ·  \(done) of \(now.images.count) commented", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 14, weight: .bold)).foregroundStyle(ink).frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                .buttonStyle(.plain).background(RoundedRectangle(cornerRadius: 10).fill(questionColor)).disabled(done == 0)
                .keyboardShortcut(.return, modifiers: [.command])
            }
            HStack(spacing: 8) {
                TextField(!now.images.isEmpty ? "Your comment on image \(page + 1)" : now.isQuestion ? "Your answer" : model.phase == .waiting ? "Reply to this" : "Reply to this, or let it move on", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...4).focused($typing)
                    .padding(10).background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.12)))
                    .onSubmit { send() }
                    .onChange(of: draft) { _, d in if !d.isEmpty { model.holdForAnswer() } }
                Button(action: send) { Image(systemName: !now.images.isEmpty && page < now.images.count - 1 ? "chevron.right.circle.fill" : "arrow.up.circle.fill").font(.system(size: 26)) }
                    .help(!now.images.isEmpty && page < now.images.count - 1 ? "Keep this comment, next image" : now.images.isEmpty ? "Send" : "Finish review")
                    .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty && !comments.values.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
            }
        }
    }

    private func send() {
        let d = draft
        // A review: send before the last image keeps this comment and turns the page, as on the phone;
        // the last image's send, or Finish review, sends every comment, each tagged with its image.
        if let images = model.now?.images, !images.isEmpty, page < images.count - 1 {
            turn(to: page + 1, images: images)
            return
        }
        finishReview()
    }

    private func finishReview() {
        let d = draft
        if let images = model.now?.images, !images.isEmpty {
            var all = comments; all[page] = d
            guard let text = DeskWalk.reviewAnswer(images, all) else { return }
            draft = ""; comments = [:]; page = 0
            model.answer(text)
            return
        }
        draft = ""
        model.answer(d)
    }

    private var commentedPages: Set<Int> {
        var s = Set(comments.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }.keys)
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty { s.insert(page) }
        return s
    }

    /// Show image [to]: this one keeps its comment, and the box takes that one's.
    private func turn(to: Int, images: [DeskImage]) {
        let n = max(0, min(images.count - 1, to))
        guard n != page else { return }
        comments[page] = draft
        page = n
        draft = comments[n] ?? ""
        model.holdForAnswer()
    }
}

/// A review's images, one at a time: the image, its label, arrows (or ⌘[ and ⌘]) to turn, and dots
/// marking each image already commented on. Opened from where it is on this Mac.
private struct ReviewImages: View {
    let images: [DeskImage]
    let page: Int
    let commented: Set<Int>
    let turn: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.08))
                if let p = images[page].path, let img = NSImage(contentsOfFile: p) {
                    Image(nsImage: img).resizable().scaledToFit().padding(6)
                        .onTapGesture(count: 2) { NSWorkspace.shared.open(URL(fileURLWithPath: p)) }
                        .help("Double-click to open it full size")
                } else {
                    Text("This image is not on this Mac").font(.system(size: 13)).foregroundStyle(.white.opacity(0.6))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 180, maxHeight: 380)
            HStack {
                Button { turn(page - 1) } label: { Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)) }
                    .buttonStyle(.plain).disabled(page == 0).keyboardShortcut("[", modifiers: [.command]).help("Previous image (⌘[)")
                Text(DeskWalk.imageLabel(images, page)).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .center)
                Button { turn(page + 1) } label: { Image(systemName: "chevron.right").font(.system(size: 18, weight: .semibold)) }
                    .buttonStyle(.plain).disabled(page >= images.count - 1).keyboardShortcut("]", modifiers: [.command]).help("Next image (⌘])")
            }
            if images.count > 1 {
                HStack(spacing: 6) {
                    ForEach(images.indices, id: \.self) { n in
                        Circle().fill(commented.contains(n) ? questionColor : n == page ? Color.white : Color.white.opacity(0.3))
                            .frame(width: n == page ? 11 : 8, height: n == page ? 11 : 8)
                            .onTapGesture { turn(n) }
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// One segment per step. Drawn 4pt tall, clickable over a 20pt band so the pointer can find one.
private struct Segments: View {
    let walked: Int
    let pending: [DeskItem]
    let active: Bool
    let onTap: (Int) -> Void
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<walked, id: \.self) { n in seg(n, .white.opacity(0.85), "Go back to step \(n + 1)") }
            ForEach(Array(pending.enumerated()), id: \.element.id) { n, i in
                let c: Color = n == 0 ? (i.isQuestion ? questionColor : .white) : (i.isQuestion ? questionColor.opacity(0.45) : .white.opacity(0.25))
                seg(walked + n, n == 0 && !active ? c.opacity(0.6) : c, n == 0 ? "Hear this step again" : "Jump to step \(walked + n + 1)")
            }
        }
        .frame(height: 20)
    }
    private func seg(_ n: Int, _ c: Color, _ help: String) -> some View {
        Capsule().fill(c).frame(height: 4).frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle()).onTapGesture { onTap(n) }.help(help)
    }
}

private struct KindTag: View {
    let item: DeskItem
    var body: some View {
        let tag: (String, Color)? = item.isQuestion ? ("QUESTION", questionColor) : item.kind == "blocked" ? ("BLOCKED", blockedColor)
            : item.kind == "done" ? ("DONE", doneColor) : nil
        if let (label, color) = tag {
            Text(label).font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(color)
                .padding(.horizontal, 8).padding(.vertical, 3).background(RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.2)))
        }
    }
}

private struct CountdownBar: View {
    let ends: Date
    var body: some View {
        TimelineView(.animation) { ctx in
            let left = max(0, ends.timeIntervalSince(ctx.date)) / DeskModel.moveOnSeconds
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.2))
                    Capsule().fill(.white).frame(width: g.size.width * left)
                }
            }
            .frame(height: 3)
        }
    }
}

/// Buttons that wrap onto as many rows as they need.
private struct FlowRow<Content: View>: View {
    let items: [String]
    let content: (String) -> Content
    init(_ items: [String], @ViewBuilder content: @escaping (String) -> Content) { self.items = items; self.content = content }
    var body: some View {
        Flow(spacing: 8) { ForEach(items, id: \.self) { content($0) } }
    }
}

private struct Flow: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        rows(proposal.width ?? 400, subviews).last.map { CGSize(width: proposal.width ?? 400, height: $0.y + $0.h) } ?? .zero
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var i = 0
        for r in rows(bounds.width, subviews) {
            var x = bounds.minX
            for _ in 0..<r.count {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + r.y), proposal: .unspecified)
                x += s.width + spacing
                i += 1
            }
        }
    }
    private func rows(_ width: CGFloat, _ subviews: Subviews) -> [(count: Int, y: CGFloat, h: CGFloat)] {
        var out: [(count: Int, y: CGFloat, h: CGFloat)] = []
        var x: CGFloat = 0, y: CGFloat = 0, h: CGFloat = 0, n = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if n > 0 && x + s.width > width { out.append((n, y, h)); y += h + spacing; x = 0; h = 0; n = 0 }
            x += s.width + spacing; h = max(h, s.height); n += 1
        }
        if n > 0 { out.append((n, y, h)) }
        return out
    }
}

/// The thread, when nothing is waiting to be walked: every message and reply, and the box to send one.
private struct ThreadPane: View {
    @Bindable var model: DeskModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.lines.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("All caught up").font(.system(size: 34, weight: .heavy))
                                Text("Replies from \(model.assistantName) are walked here one item at a time, the way the phone does. Type below to ask for anything.")
                                    .font(.system(size: 14)).foregroundStyle(.white.opacity(0.65))
                            }
                            .padding(.top, 60)
                        }
                        ForEach(model.lines) { l in LineRow(line: l, name: model.assistantName) { model.retry(l) }.id(l.id) }
                        if model.waiting {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("\(model.assistantName) is on it…").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)) }
                        }
                    }
                    .padding(.horizontal, 18).padding(.top, 40).padding(.bottom, 12)
                }
                .onChange(of: model.lines.count) { _, _ in if let last = model.lines.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
                .onAppear { if let last = model.lines.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            if !model.walked.isEmpty && model.answered > 0 {
                Button("Send \(model.answered) answer\(model.answered == 1 ? "" : "s")") { model.flush() }.padding(.bottom, 6)
            }
            HStack(spacing: 8) {
                TextField("Message \(model.assistantName)", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6)
                    .padding(10).background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.1)))
                    .onSubmit(send)
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || model.conn != .connected)
            }
            .padding(14)
        }
    }

    private func send() {
        guard model.conn == .connected else { return }
        model.say(draft)
        draft = ""
    }
}

private struct LineRow: View {
    let line: DeskLine
    let name: String
    let retry: () -> Void

    var body: some View {
        switch line.who {
        case .me:
            HStack {
                Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(line.text).font(.system(size: 14)).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.16)))
                    HStack(spacing: 6) {
                        Text(stage).font(.system(size: 10)).foregroundStyle(line.stage == .failed ? blockedColor : .white.opacity(0.5))
                        if line.stage == .failed { Button("Retry", action: retry).buttonStyle(.link).font(.system(size: 10)) }
                    }
                }
            }
        case .laptop:
            VStack(alignment: .leading, spacing: 2) {
                Text("AT THE LAPTOP").font(.system(size: 9, weight: .medium)).tracking(1.2).foregroundStyle(.white.opacity(0.45))
                Text(line.text).font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).lineLimit(4)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 3) {
                Text(name.uppercased()).font(.system(size: 9, weight: .bold)).tracking(1.2).foregroundStyle(.white.opacity(0.5))
                Text((try? AttributedString(markdown: line.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line.text))
                    .font(.system(size: 14)).textSelection(.enabled)
            }
        case .info:
            Text(line.text).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).frame(maxWidth: .infinity)
        }
    }

    private var stage: String {
        switch line.stage {
        case .sending: return "Sending…"
        case .delivered: return "Delivered"
        case .picked: return "\(name) has it"
        case .failed: return "Not delivered"
        }
    }
}


// MARK: - the dash (the phone's screen when nothing is left to walk)

/// The grid the bridge pushes (mobile/bridge/lib.mjs readGrid): just what the At work screen reads.
struct DeskGrid: Equatable {
    struct Row: Equatable, Identifiable {
        let id: String
        let project: String
        let title: String
        let line: String
        let phase: String?
    }
    let macOpen: Bool
    let rows: [Row]

    init(_ m: [String: Any]) {
        macOpen = (m["mac"] as? String ?? "open") == "open"
        var rows: [Row] = []
        for p in m["projects"] as? [[String: Any]] ?? [] {
            let name = p["name"] as? String ?? ""
            for x in p["sessions"] as? [[String: Any]] ?? [] where x["running"] as? Bool ?? true {
                let st = x["status"] as? [String: Any] ?? [:]
                let wait = (x["wait"] as? [String: Any])?["headline"] as? String
                let task = st["task"] as? String
                let line = [wait, task, st["headline"] as? String].compactMap { $0 }.first { !$0.isEmpty } ?? ""
                rows.append(Row(id: (x["key"] as? String) ?? UUID().uuidString, project: name, title: x["title"] as? String ?? "", line: line, phase: x["phase"] as? String))
            }
        }
        self.rows = rows
    }
}

/// Nothing to walk: "All caught up" (or where your message is) for a few seconds, then what is at
/// work across the Mac, on the same coloured screen as the walk. The text thread is one click away.
private struct DashPane: View {
    @Bindable var model: DeskModel
    @State private var settled = false
    @State private var draft = ""

    private var outgoing: DeskLine? {
        guard let i = model.lines.lastIndex(where: { $0.who == .me }) else { return nil }
        let l = model.lines[i]
        let answered = model.lines[(i + 1)...].contains { $0.who == .assistant }
        return !answered && (model.waiting || l.stage == .failed) ? l : nil
    }

    var body: some View {
        let accent = deskProjectColor(model.assistantName)
        let idle = outgoing == nil && model.answered == 0
        VStack(alignment: .leading, spacing: 0) {
            if idle && settled { AtWork(grid: model.grid) } else { caughtUp }
            composer.padding(.top, 12)
        }
        .padding(.horizontal, 22).padding(.top, 34).padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(LinearGradient(stops: [.init(color: accent, location: 0), .init(color: accent.opacity(0.35), location: 0.55), .init(color: ink, location: 1)],
                                   startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .task(id: idle) {
            settled = false
            guard idle else { return }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            settled = true
        }
    }

    private var caughtUp: some View {
        let name = model.assistantName
        let stage = outgoing?.stage
        let heard = model.walked.count
        return VStack(alignment: .leading, spacing: 8) {
            Spacer()
            Text(stage == .sending ? "Sending…" : stage == .delivered ? "Delivered" : stage == .picked ? "\(name) is working…" : stage == .failed ? "Not delivered" : "All caught up")
                .font(.system(size: 34, weight: .heavy))
            Text(stage == .sending ? "Sending your message…"
                 : stage == .delivered ? "Delivered. \(name) has not started on it yet."
                 : stage == .picked ? "\(name) has your message. The reply plays here when it is ready."
                 : stage == .failed ? "Your message did not get through. It is kept: click Retry to send it again."
                 : heard > 0 ? "You heard \(heard) item\(heard == 1 ? "" : "s"). Type anything to start something new."
                 : "Type anything. Replies play here, one item at a time.")
                .font(.system(size: 15)).foregroundStyle(.white.opacity(0.75))
            if stage == .sending || stage == .delivered || stage == .picked {
                ProgressView().progressViewStyle(.linear).tint(.white).padding(.top, 8)
            }
            if stage == .failed, let l = outgoing {
                Button("Retry") { model.retry(l) }.buttonStyle(WhitePill()).padding(.top, 10)
            }
            if model.answered > 0 {
                Button("Send \(model.answered) answer\(model.answered == 1 ? "" : "s")") { model.flush() }.buttonStyle(WhitePill()).padding(.top, 10)
            }
            if heard > 0 && stage == nil {
                Button { model.rewind(to: 0) } label: { Label(heard == 1 ? "Hear it again" : "Hear all \(heard) again", systemImage: "gobackward") }
                    .buttonStyle(.bordered).tint(.white).padding(.top, 10)
            }
            Spacer()
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message \(model.assistantName)", text: $draft, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(1...6)
                .padding(10).background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.12)))
                .onSubmit(send)
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)) }
                .buttonStyle(.plain).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || model.conn != .connected)
        }
    }

    private func send() {
        guard model.conn == .connected, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.say(draft)
        draft = ""
    }
}

private struct WhitePill: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 14, weight: .semibold)).foregroundStyle(ink)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.8 : 1)))
    }
}

/// The sessions at work, counted as genlock sweep counts them: "working" now, "holding" paused.
private struct AtWork: View {
    let grid: DeskGrid?
    @State private var pulse = false

    var body: some View {
        let rows = grid?.rows ?? []
        let working = rows.filter { $0.phase == "working" }
        let paused = rows.filter { $0.phase == "holding" }
        VStack(alignment: .leading, spacing: 0) {
            Text("AT WORK NOW").font(.system(size: 13, weight: .bold)).tracking(2).foregroundStyle(.white.opacity(0.75)).padding(.top, 24)
            if let grid, grid.macOpen {
                Text(!working.isEmpty ? "\(working.count) \(working.count == 1 ? "session" : "sessions") working" : !paused.isEmpty ? "All paused" : "Nothing running")
                    .font(.system(size: 34, weight: .heavy)).lineLimit(3).padding(.top, 10)
                HStack(spacing: 8) {
                    Circle().fill(working.isEmpty ? Color.white.opacity(0.3) : doneColor.opacity(pulse ? 1 : 0.35)).frame(width: 10, height: 10)
                    Text(working.isEmpty ? "Quiet" : "Active").font(.system(size: 15, weight: .medium)).foregroundStyle(working.isEmpty ? .white.opacity(0.6) : doneColor)
                    if !paused.isEmpty {
                        Text("·").foregroundStyle(.white.opacity(0.5))
                        Text("\(paused.count) paused").font(.system(size: 15, weight: .medium)).foregroundStyle(questionColor)
                    }
                }
                .padding(.top, 8)
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(working.map { ($0, true) } + paused.map { ($0, false) }, id: \.0.id) { row, active in
                            HStack(spacing: 10) {
                                if active { Circle().fill(doneColor.opacity(pulse ? 1 : 0.35)).frame(width: 9, height: 9) }
                                else { Image(systemName: "pause.fill").font(.system(size: 11)).foregroundStyle(questionColor) }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text([row.project, row.title].filter { !$0.isEmpty }.joined(separator: " · ")).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                                    if !row.line.isEmpty { Text(row.line).font(.system(size: 13)).foregroundStyle(.white.opacity(0.65)).lineLimit(1) }
                                }
                                Spacer()
                                Text(active ? "working" : "paused").font(.system(size: 11, weight: .medium)).foregroundStyle(active ? doneColor : questionColor)
                            }
                        }
                        if !rows.isEmpty && working.isEmpty && paused.isEmpty {
                            Text("Nothing running right now. Type anything to start something.").font(.system(size: 15)).foregroundStyle(.white.opacity(0.7))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 18)
            } else {
                Text(grid == nil ? "Waiting for the Mac…" : "The Mac app is closed").font(.system(size: 28, weight: .heavy)).padding(.top, 10)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true } }
    }
}
