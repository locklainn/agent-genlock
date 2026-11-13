import AppKit
import AVFoundation
import GenlockCore
import Speech

/// Listening and speaking. Recognition runs on this Mac when the Mac supports it.
@MainActor @Observable
final class VoiceController: NSObject {
    private(set) var machine = VoiceMachine()
    private var transcript = VoiceTranscript()
    var partial: String { transcript.text }
    private(set) var isSpeaking = false
    /// The reply being read now, shown where your eyes already are.
    private(set) var speakingText: String?
    /// Replies that have arrived and wait for you to ask for them.
    private(set) var waitingReplies = 0
    private(set) var waitingFrom: [String] = []
    @ObservationIgnored private(set) var dings = 0
    /// Speech is over only when the last thing queued ends, whatever else finishes before it.
    @ObservationIgnored fileprivate var latestUtterance: AVSpeechUtterance?
    @ObservationIgnored private var queue: [(text: String, from: String?)] = []
    /// The update in front of you, which the talk key and the reply box answer.
    private(set) var replyTo: ReplyTarget?
    @ObservationIgnored private var replyQuietSince: Date?
    @ObservationIgnored private var lastHeardFrom = UserDefaults.standard.stringArray(forKey: "lastHeardFrom") ?? []
    @ObservationIgnored private var speechVolume: Float = 1
    /// Where speech has got to in `speakingText`, and where the current utterance began in it.
    @ObservationIgnored private(set) var reached = 0
    @ObservationIgnored private var playedFrom = 0
    private(set) var speedHeld = false
    /// How fast replies are read, as a multiple of normal speech.
    var speechSpeed: Double {
        didSet {
            UserDefaults.standard.set(speechSpeed, forKey: "speechSpeed")
            applySpeed()
        }
    }
    /// What you last heard, kept so a stray press never costs you an update.
    @ObservationIgnored private var lastHeard = UserDefaults.standard.stringArray(forKey: "lastHeard") ?? []
    /// When the update was closed. Nil while it is still on screen or never was.
    @ObservationIgnored private var closedAt: TimeInterval?
    /// Sessions whose starting work means the thread has moved on from what you last heard.
    @ObservationIgnored private var replaySources: [String] = []
    var canReplay: Bool {
        !lastHeard.isEmpty && VoiceMachine.isReplayable(isOpen: replyTo != nil, closedAt: closedAt, now: Date().timeIntervalSince1970)
    }

    /// The thread moved on, so what you last heard is no longer worth repeating.
    func replayMovedOn(working: Set<String>) {
        guard !lastHeard.isEmpty, VoiceMachine.hasMovedOn(sources: replaySources, working: working) else { return }
        lastHeard = []
        lastHeardFrom = []
        replaySources = []
        closedAt = nil
        UserDefaults.standard.removeObject(forKey: "lastHeard")
        UserDefaults.standard.removeObject(forKey: "lastHeardFrom")
    }

    private func noteClosed() { closedAt = Date().timeIntervalSince1970 }
    /// How loud the microphone is right now, 0 to 1, to draw it.
    private(set) var level = 0.0
    private(set) var target: String?
    var problem: String?
    var needsDictationSetting = false
    var speakReplies: Bool {
        didSet { UserDefaults.standard.set(speakReplies, forKey: "speakReplies") }
    }

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private let recognizer = SFSpeechRecognizer()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let synth = AVSpeechSynthesizer()
    /// The Genlock voice: the project's own Kokoro voice from the speaker. The synthesizer above is
    /// what reads when it is not installed or does not answer.
    @ObservationIgnored private let genlock = GenlockSpeaker()
    @ObservationIgnored private var genlockBusy = false
    /// The sentence the Genlock voice is reading now.
    private(set) var speakingSentence: String?
    @ObservationIgnored private var finishFallback: DispatchWorkItem?
    @ObservationIgnored private var didSend = false
    @ObservationIgnored private var hintedVoice = false

    override init() {
        speakReplies = UserDefaults.standard.object(forKey: "speakReplies") as? Bool ?? true
        speechSpeed = UserDefaults.standard.object(forKey: "speechSpeed") as? Double ?? SpeechSpeed.standard
        super.init()
        synth.delegate = self
    }

    var isListening: Bool { machine.state == .listening }

    var recognizerReport: String {
        guard let recognizer else { return "no recognizer for \(Locale.current.identifier)" }
        return "locale=\(recognizer.locale.identifier) available=\(recognizer.isAvailable) onDevice=\(recognizer.supportsOnDeviceRecognition) lastError=\(lastRecognitionError)"
    }
    @ObservationIgnored private var lastRecognitionError = "none"

    /// The button and the key both come here: press to start, press again to send.
    func press(target project: String?) {
        stopSpeaking()
        switch machine.press() {
        case .startListening:
            guard let project else {
                machine.reset()
                problem = "Open a session first, so there is somewhere to send it."
                return
            }
            target = project
            transcript = VoiceTranscript()
            problem = nil
            needsDictationSetting = false
            didSend = false
            requestAccessThenListen()
        case .finishListening:
            finish()
        case .none:
            break
        }
    }

    func cancel() {
        guard machine.state != .idle else { return }
        didSend = true
        teardown()
        machine.reset()
        transcript = VoiceTranscript()
        target = nil
    }

    private func requestAccessThenListen() {
        SFSpeechRecognizer.requestAuthorization { speech in
            AVCaptureDevice.requestAccess(for: .audio) { mic in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard speech == .authorized else {
                            self.deny("Speech recognition is turned off for Genlock. Allow it in System Settings, Privacy & Security, Speech Recognition.")
                            return
                        }
                        guard mic else {
                            self.deny("The microphone is turned off for Genlock. Allow it in System Settings, Privacy & Security, Microphone.")
                            return
                        }
                        // The second press may already have arrived while permission was being asked.
                        if self.isListening { self.beginListening() }
                    }
                }
            }
        }
    }

    func openDictationSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") { NSWorkspace.shared.open(url) }
    }

    private func deny(_ message: String) {
        problem = message
        machine.reset()
        target = nil
    }

    private func beginListening() {
        guard let recognizer, recognizer.isAvailable else {
            deny("Speech recognition is not available right now.")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            guard let samples = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in stride(from: 0, to: n, by: 8) { sum += samples[i] * samples[i] }
            let rms = (sum / Float(max(1, n / 8))).squareRoot()
            let scaled = min(1, Double(rms) * 9)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.level = self.level * 0.6 + scaled * 0.4 }
            }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            deny("Could not start the microphone: \(error.localizedDescription)")
            return
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let result {
                        self.transcript.receive(result.bestTranscription.formattedString,
                                                endsUtterance: result.speechRecognitionMetadata != nil)
                    }
                    if let error {
                        self.lastRecognitionError = "\(error)"
                        // Say so at once, rather than listen on while nothing can come of it.
                        if self.isListening, self.partial.isEmpty,
                           let why = VoiceMachine.explain(recognitionError: "\(error)") {
                            self.needsDictationSetting = why.needsDictationSetting
                            self.teardown()
                            self.didSend = true
                            self.deny(why.message)
                            return
                        }
                    }
                    if result?.isFinal == true || error != nil, self.machine.state == .sending { self.send() }
                }
            }
        }
    }

    private func finish() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // A final result normally follows at once. If it does not, send what was heard.
        let fallback = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.send() }
        }
        finishFallback = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: fallback)
    }

    private func send() {
        guard !didSend else { return }
        didSend = true
        if VoiceMachine.message(from: partial) == nil {
            problem = "Nothing was heard, so nothing was sent."
        } else if replyTo?.session == target {
            // Answered, so it has done its job. Cancelling or saying nothing leaves it to try again.
            replyTo = nil
            noteClosed()
        }
        submit(partial, to: target)
        teardown()
        machine.reset()
        transcript = VoiceTranscript()
        target = nil
    }

    /// The last step of dictation, also what the test driver calls.
    func submit(_ transcript: String, to project: String?) {
        guard let project, let message = VoiceMachine.message(from: transcript),
              let session = AppModel.shared.sessions[project] else { return }
        if speakReplies { session.channel.markPending() }
        session.submit(speakReplies ? message : String(message.dropFirst("[voice] ".count)))
    }

    private func teardown() {
        finishFallback?.cancel()
        finishFallback = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    // MARK: Speaking

    /// Called on a timer. An agent never just starts talking, because you may not be there: its
    /// reply waits, with a ding and a notice, until you ask for it.
    func collectReplies(from sessions: [TerminalSession]) {
        if speakReplies { GenlockSpeaker.warm(tools: AppModel.shared.tools) }
        guard speakReplies else {
            for session in sessions { _ = session.channel.takeMessages() }
            waitingReplies = 0
            waitingFrom = []
            return
        }
        let waiting = sessions.filter { $0.channel.waitingCount > 0 && UpdateRouting.isReady(phase: $0.phase, isRunning: $0.isRunning) }
        let total = waiting.reduce(0) { $0 + $1.channel.waitingCount }
        if total > waitingReplies && machine.state == .idle {
            dings += 1
            if !Driver.isActive { NSSound(named: "Glass")?.play() }
        }
        waitingReplies = total
        waitingFrom = waiting.map(\.label).sorted()
    }

    /// You said yes: read everything waiting, oldest first within each session.
    func hearReplies(from sessions: [TerminalSession]) {
        for item in takeWaiting(from: sessions) { speak(item.text, volume: Driver.isActive ? 0 : 1, from: item.from) }
    }

    /// You would rather not hear it now. It goes quiet, and right Command can still replay it.
    func dismissReplies(from sessions: [TerminalSession]) {
        _ = takeWaiting(from: sessions)
        noteClosed()
    }

    private func takeWaiting(from sessions: [TerminalSession]) -> [(text: String, from: String)] {
        let open = sessions.count
        let ready = sessions.filter { UpdateRouting.isReady(phase: $0.phase, isRunning: $0.isRunning) }
        let waiting = ready.flatMap { session in
            session.channel.takeMessages().map { (text: VoiceChannel.spoken($0, project: session.label, sessionsOpen: open), from: session.key) }
        }
        waitingReplies = 0
        waitingFrom = []
        guard !waiting.isEmpty else { return [] }
        keepForReplay(waiting)
        return waiting
    }

    /// What the Assistant was handed stays replayable, in their own words.
    func keepForReplay(_ items: [(text: String, from: String)], handedTo: String? = nil) {
        replaySources = items.map(\.from) + (handedTo.map { [$0] } ?? [])
        closedAt = Date().timeIntervalSince1970
        lastHeard = items.map(\.text)
        lastHeardFrom = items.map(\.from)
        UserDefaults.standard.set(lastHeard, forKey: "lastHeard")
        UserDefaults.standard.set(lastHeardFrom, forKey: "lastHeardFrom")
    }

    func replayLast() {
        for (i, text) in lastHeard.enumerated() {
            speak(text, volume: Driver.isActive ? 0 : 1, from: i < lastHeardFrom.count ? lastHeardFrom[i] : nil)
        }
    }

    /// Replies queue here rather than in the synthesizer, because changing speed means restarting
    /// the current one from the word it has reached.
    func speak(_ text: String, volume: Float = 1, from session: String? = nil) {
        isSpeaking = true
        if !hintedVoice, !GenlockSpeaker.isInstalled, let hint = VoiceOption.upgradeHint(for: chosenVoice) {
            hintedVoice = true
            AppModel.shared.message = hint
        }
        lastSpoken = text
        queue.append((text, session))
        speechVolume = volume
        if latestUtterance == nil && !genlockBusy { playNext() }
    }

    fileprivate func playNext() {
        guard !queue.isEmpty else {
            isSpeaking = false
            speakingText = nil
            replyQuietSince = Date()
            return
        }
        let next = queue.removeFirst()
        let text = next.text
        speakingText = text
        replyQuietSince = nil
        if let from = next.from {
            replyTo = ReplyTarget(session: from, text: text)
            closedAt = nil
        }
        reached = 0
        guard GenlockSpeaker.isInstalled else { play(from: 0); return }
        // In the project's Genlock voice, a sentence at a time; the system voice if it cannot be had.
        let root = next.from.flatMap { AppModel.shared.sessions[$0]?.projectID }
        genlockBusy = true
        genlock.volume = speechVolume
        genlock.speak(text, root: root, speed: speechSpeed, tools: AppModel.shared.tools,
                      onSentence: { [weak self] sentence in
                          guard let self else { return }
                          self.speakingSentence = sentence
                          self.genlock.setSpeed(self.speechSpeed * (self.speedHeld ? SpeechSpeed.holdBoost : 1))
                      },
                      onEnd: { [weak self] spoke in
                          guard let self else { return }
                          self.genlockBusy = false
                          self.speakingSentence = nil
                          if spoke { self.playNext() } else { self.play(from: 0) }
                      })
    }

    private func play(from offset: Int) {
        guard let text = speakingText else { return }
        playedFrom = offset
        let utterance = AVSpeechUtterance(string: SpeechSpeed.remainder(of: text, from: offset))
        utterance.voice = replyVoice
        utterance.volume = speechVolume
        utterance.rate = SpeechSpeed.rate(speed: speechSpeed, held: speedHeld)
        latestUtterance = utterance
        synth.speak(utterance)
    }

    /// Restarts what is being read from the word it reached, at the current speed.
    private func applySpeed() {
        if genlockBusy { genlock.setSpeed(speechSpeed * (speedHeld ? SpeechSpeed.holdBoost : 1)); return }
        guard latestUtterance != nil else { return }
        latestUtterance = nil
        synth.stopSpeaking(at: .immediate)
        play(from: reached)
    }

    /// While the right arrow is held.
    func holdSpeed(_ held: Bool) {
        guard held != speedHeld else { return }
        speedHeld = held
        applySpeed()
    }

    fileprivate func noteReached(_ location: Int, of utterance: AVSpeechUtterance) {
        if utterance === latestUtterance { reached = playedFrom + location }
    }

    func dismissReply() {
        replyTo = nil
        noteClosed()
    }

    /// Your answer to the update in front of you, spoken back like anything you dictate.
    func sendReply(_ text: String) {
        guard let replyTo else { return }
        submit(text, to: replyTo.session)
        self.replyTo = nil
        noteClosed()
    }

    func expireReply(now: Date = Date()) {
        guard replyTo != nil, machine.state == .idle, let since = replyQuietSince,
              now.timeIntervalSince(since) >= ReplyTarget.lingerSeconds else { return }
        replyTo = nil
        noteClosed()
    }

    /// Lets you hear the speed you just chose.
    func trySpeed() {
        stopSpeaking()
        speak("This is how fast replies will be read. Hold the right arrow while I'm talking to go faster.", volume: Driver.isActive ? 0 : 1)
    }

    @ObservationIgnored private(set) var lastSpoken: String?

    @ObservationIgnored lazy var chosenVoice: VoiceOption? = VoiceOption.preferred(from: AVSpeechSynthesisVoice.speechVoices().map {
        VoiceOption(identifier: $0.identifier, name: $0.name, language: $0.language,
                    isMale: $0.gender == .male, quality: $0.quality.rawValue)
    })

    private var replyVoice: AVSpeechSynthesisVoice? {
        chosenVoice.flatMap { AVSpeechSynthesisVoice(identifier: $0.identifier) } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    func stopSpeaking() {
        queue.removeAll()
        replyQuietSince = Date()
        latestUtterance = nil
        speedHeld = false
        synth.stopSpeaking(at: .immediate)
        genlock.stop()
        genlockBusy = false
        speakingSentence = nil
        isSpeaking = false
        speakingText = nil
    }
}

extension VoiceController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance u: AVSpeechUtterance) {
        nonisolated(unsafe) let u = u
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.noteReached(range.location, of: u) }
        }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { ended(u) }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { ended(u) }

    nonisolated private func ended(_ u: AVSpeechUtterance) {
        nonisolated(unsafe) let u = u
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard u === self.latestUtterance else { return }
                self.latestUtterance = nil
                self.playNext()
            }
        }
    }
}
