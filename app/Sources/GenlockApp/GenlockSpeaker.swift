import AVFoundation
import Foundation
import GenlockCore

/// The Genlock voice on the Mac. Replies are spoken by the Genlock speaker (`genlock voice serve`,
/// lib/speaker.mjs), which keeps the Kokoro model loaded and answers with one wav per sentence in
/// the project's own voice. This plays them in order as they arrive. The phone bridge asks the
/// same speaker, so a project sounds the same on both.
@MainActor
final class GenlockSpeaker: NSObject, AVAudioPlayerDelegate {
    static var home: URL {
        if let h = ProcessInfo.processInfo.environment["GENLOCK_VOICE_HOME"] { return URL(fileURLWithPath: h) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genlock/voice")
    }
    /// Installed with `genlock voice install`. Without it the system voice reads replies.
    static var isInstalled: Bool {
        FileManager.default.fileExists(atPath: home.appendingPathComponent("kokoro-multi-lang-v1_0/model.onnx").path)
    }

    private struct Clip { let text: String; let wav: Data }
    private var clips: [Clip] = []
    private var streamEnded = false
    private var playedAny = false
    private var player: AVAudioPlayer?
    private var task: Task<Void, Never>?
    private var generation = 0
    private var onSentence: ((String) -> Void)?
    private var onEnd: ((Bool) -> Void)?
    /// The speed the clips were made at; the player stretches only the difference.
    private var madeAt = 1.0
    private var wanted = 1.0
    var volume: Float = 1 { didSet { player?.volume = volume } }

    /// Playback speed as a multiple of normal: the speaker makes clips at it, the player covers changes.
    func setSpeed(_ speed: Double) {
        wanted = speed
        player?.rate = Self.stretch(wanted / madeAt)
    }
    private static func stretch(_ r: Double) -> Float { Float(min(max(r, 0.5), 2)) }

    /// Speak [text] in the voice of the project at [root]. onEnd(true) once it is all played;
    /// onEnd(false) when nothing could be played, so the caller reads it with the system voice.
    func speak(_ text: String, root: String?, speed: Double, tools: ToolEnvironment?,
               onSentence: @escaping (String) -> Void, onEnd: @escaping (Bool) -> Void) {
        stop()
        generation += 1
        let my = generation
        clips = []; streamEnded = false; playedAny = false
        self.onSentence = onSentence; self.onEnd = onEnd
        madeAt = speed; wanted = speed
        task = Task { [weak self] in
            do {
                let port = try await Self.ensurePort(tools: tools)
                var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/speak")!)
                req.httpMethod = "POST"
                req.timeoutInterval = 60
                var body: [String: Any] = ["text": text, "format": "wav", "speed": speed]
                if let root { body["root"] = root }
                req.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (bytes, response) = try await URLSession.shared.bytes(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SpeakerError.refused }
                for try await line in bytes.lines {
                    guard let self, my == self.generation else { return }
                    guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                    if obj["error"] != nil { throw SpeakerError.refused }
                    if obj["done"] != nil { break }
                    if let b64 = obj["audio"] as? String, let wav = Data(base64Encoded: b64) {
                        self.clips.append(Clip(text: obj["text"] as? String ?? "", wav: wav))
                        if self.player == nil { self.playNext(my) }
                    }
                }
                guard let self, my == self.generation else { return }
                self.streamEnded = true
                if self.player == nil { self.playNext(my) }
            } catch {
                guard let self, my == self.generation else { return }
                self.streamEnded = true
                if self.player == nil { self.playNext(my) }
            }
        }
    }

    func stop() {
        generation += 1
        task?.cancel(); task = nil
        player?.stop(); player = nil
        clips = []
        onSentence = nil; onEnd = nil
    }

    private func playNext(_ my: Int) {
        guard my == generation else { return }
        guard !clips.isEmpty else {
            if streamEnded { let end = onEnd; let any = playedAny; onSentence = nil; onEnd = nil; end?(any) }
            return
        }
        let clip = clips.removeFirst()
        guard let p = try? AVAudioPlayer(data: clip.wav) else { playNext(my); return }
        p.delegate = self
        p.enableRate = true
        p.rate = Self.stretch(wanted / madeAt)
        p.volume = volume
        player = p
        playedAny = true
        onSentence?(clip.text)
        p.play()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) { finished(p) }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error: Error?) { finished(p) }
    nonisolated private func finished(_ p: AVAudioPlayer) {
        nonisolated(unsafe) let p = p
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard p === self.player else { return }
                self.player = nil
                self.playNext(self.generation)
            }
        }
    }

    // MARK: Finding the speaker

    private static var warming = false
    /// Start the speaker now, so the first reply does not wait on a cold load (10s or more).
    static func warm(tools: ToolEnvironment?) {
        guard isInstalled, !warming, tools != nil else { return }
        warming = true
        Task { if (try? await ensurePort(tools: tools)) == nil { warming = false } }
    }

    private enum SpeakerError: Error { case notInstalled, noCLI, didNotStart, refused }

    private static func served() -> (port: Int, pid: Int32)? {
        guard let data = try? Data(contentsOf: home.appendingPathComponent("serve.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = obj["port"] as? Int, let pid = obj["pid"] as? Int else { return nil }
        return (port, Int32(pid))
    }
    private static func servedPort() -> Int? { served()?.port }

    private static func healthy(_ port: Int, timeout: TimeInterval) async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        req.timeoutInterval = timeout
        guard let (_, r) = try? await URLSession.shared.data(for: req) else { return false }
        return (r as? HTTPURLResponse)?.statusCode == 200
    }

    /// The speaker's port, starting it if none answers. The CLI's own client replaces a speaker
    /// running other code; this one takes whichever is up, so a newer bridge is never fought.
    private static func ensurePort(tools: ToolEnvironment?) async throws -> Int {
        guard isInstalled else { throw SpeakerError.notInstalled }
        if let port = servedPort(), await healthy(port, timeout: 8) { return port }
        // A live speaker that is slow (loading, or the Mac is swapping) is waited for, never doubled:
        // each holds about a gigabyte, and a second one under memory pressure makes both slower.
        if let s = served(), kill(s.pid, 0) == 0 {
            for _ in 0..<60 {
                if await healthy(s.port, timeout: 2) { return s.port }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            throw SpeakerError.didNotStart
        }
        guard let argv = tools?.genlockArgv, let exe = argv.first else { throw SpeakerError.noCLI }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = Array(argv.dropFirst()) + ["voice", "serve", "--quiet"]
        p.environment = tools?.environment
        p.currentDirectoryURL = home
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 200_000_000)
            if let port = servedPort(), await healthy(port, timeout: 1.5) { return port }
            if !p.isRunning { break }
        }
        throw SpeakerError.didNotStart
    }
}
