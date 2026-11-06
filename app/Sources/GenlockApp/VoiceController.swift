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
    @ObservationIgnored private var finishFallback: DispatchWorkItem?
    @ObservationIgnored private var didSend = false
    @ObservationIgnored private var hintedVoice = false

    override init() {
        speakReplies = UserDefaults.standard.object(forKey: "speakReplies") as? Bool ?? true
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

    /// Called on a timer, to pick up anything agents have handed over.
    func collectReplies(from sessions: [TerminalSession]) {
        let open = sessions.count
        for session in sessions {
            for text in session.channel.takeMessages() where speakReplies {
                speak(VoiceChannel.spoken(text, project: session.label, sessionsOpen: open))
            }
        }
    }

    /// AVSpeechSynthesizer queues on its own, so replies from several sessions never overlap.
    func speak(_ text: String, volume: Float = 1) {
        isSpeaking = true
        if !hintedVoice, let hint = VoiceOption.upgradeHint(for: chosenVoice) {
            hintedVoice = true
            AppModel.shared.message = hint
        }
        lastSpoken = text
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = replyVoice
        utterance.volume = volume
        synth.speak(utterance)
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
        synth.stopSpeaking(at: .immediate)
        isSpeaking = false
        speakingText = nil
    }
}

extension VoiceController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        let text = u.speechString
        DispatchQueue.main.async {
            MainActor.assumeIsolated { self.speakingText = text }
        }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.isSpeaking = self.synth.isSpeaking
                if !self.isSpeaking { self.speakingText = nil }
            }
        }
    }
}
