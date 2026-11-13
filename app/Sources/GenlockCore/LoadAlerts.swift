import Foundation

/// Turns streams of load and usage readings into rare alerts for the Assistant: one per red
/// episode, never on a brief spike, never again while a metric stays red. TJ, 13 Nov 2026: "i dont
/// want these hooks to cause constant agentic churn and analysis... staying in 'red alert zone'
/// triggering the assisstant would just be waste". Pure: time comes in with each reading, so tests
/// drive it with synthetic clocks, and the state is Codable so a relaunch does not re-alert.
public enum LoadMetric: String, Codable, CaseIterable, Sendable {
    case cpu, memory, battery, session, weekly

    /// Claude-limit alerts never start an Assistant; only machine alerts may.
    public var isLimit: Bool { self == .session || self == .weekly }
}

/// What one reading says about one metric.
public enum LoadVerdict: Equatable, Sendable {
    /// Over the line; an episode starts once it has stayed red this long.
    case red(sustain: TimeInterval)
    /// Back under the exit line (lower than the entry line: hysteresis).
    case clear
    /// Between the lines, or unknown: holds whatever state the metric is in.
    case between
}

/// Every threshold in one place, so they are easy to tune. These are mine, not TJ's (he did not
/// know what they should be): too tight churns the Assistant, too loose misses slowdowns.
public struct LoadThresholds: Equatable, Sendable {
    public var cpuRed = 90.0, cpuRedFor: TimeInterval = 180, cpuClear = 70.0
    /// Kernel level 2 (warning) for this long; level 4 (critical) at once.
    public var memoryWarningFor: TimeInterval = 120
    public var batteryLow = 15.0, batteryLowFor: TimeInterval = 60, drainingOnACFor: TimeInterval = 600
    public var sessionRed = 85.0, sessionClear = 50.0
    public var weeklyOverPaceRed = 15, weeklyOverPaceClear = 5
    /// Clear must hold this long before an episode ends (usage clears at once: it is polled slowly).
    public var clearFor: TimeInterval = 300
    /// After an alert, the same metric stays quiet this long even if a new episode starts.
    public var cooldown: TimeInterval = 3600
    /// No more alerts than this in any 24 hours.
    public var dailyCap = 6

    public init() {}

    public func verdict(_ metric: LoadMetric, _ r: LoadReading) -> LoadVerdict {
        switch metric {
        case .cpu:
            guard let cpu = r.cpu else { return .between }
            return cpu >= cpuRed ? .red(sustain: cpuRedFor) : cpu < cpuClear ? .clear : .between
        case .memory:
            switch r.pressureLevel {
            case 4?: return .red(sustain: 0)
            case 2?: return .red(sustain: memoryWarningFor)
            case 1?: return .clear
            default: return .between
            }
        case .battery:
            guard let b = r.battery else { return .clear }
            let draining = !b.charging && (b.drainWatts.map { $0 > 0.1 } ?? !b.onAC)
            if draining && b.level <= batteryLow { return .red(sustain: batteryLowFor) }
            if draining && b.onAC { return .red(sustain: drainingOnACFor) }
            return draining ? .between : .clear
        case .session, .weekly:
            return .between
        }
    }

    public func verdict(_ metric: LoadMetric, _ u: UsageReading) -> LoadVerdict {
        switch metric {
        case .session:
            guard u.isCurrent(u.session, now: u.at), let used = u.session?.used else { return .clear }
            return used >= sessionRed ? .red(sustain: 0) : used < sessionClear ? .clear : .between
        case .weekly:
            guard u.isCurrent(u.weekly, now: u.at), let over = u.overPace(now: u.at) else { return .clear }
            return over >= weeklyOverPaceRed ? .red(sustain: 0) : over <= weeklyOverPaceClear ? .clear : .between
        default:
            return .between
        }
    }

    /// Usage readings come every few minutes and a reset is final, so they leave red at once.
    func clearFor(_ metric: LoadMetric) -> TimeInterval { metric.isLimit ? 0 : clearFor }
}

/// One alert: every metric that went red in the same reading, merged into one message.
public struct LoadAlert: Equatable, Sendable {
    public let at: Date
    public let metrics: [LoadMetric]

    /// True when every metric is a Claude limit, so no Assistant may be started for it.
    public var limitsOnly: Bool { metrics.allSatisfy(\.isLimit) }

    public init(at: Date, metrics: [LoadMetric]) { self.at = at; self.metrics = metrics }
}

public struct LoadAlerts: Codable, Equatable, Sendable {
    public struct Track: Codable, Equatable, Sendable {
        /// When the metric first read red in the current run of red readings (not yet an episode).
        var redSince: Date?
        /// In an episode: it stayed red long enough. Only one alert per episode, whatever happens.
        var inEpisode = false
        /// When it first read clear during an episode.
        var clearSince: Date?
        var lastAlert: Date?
        /// Snoozed until its current or next episode ends.
        var snoozed = false
    }

    public private(set) var tracks: [LoadMetric: Track] = [:]
    /// Alert times in the last 24 hours, for the daily cap.
    public private(set) var recent: [Date] = []
    public var thresholds = LoadThresholds()

    enum CodingKeys: String, CodingKey { case tracks, recent }

    public init(thresholds: LoadThresholds = LoadThresholds()) { self.thresholds = thresholds }

    public func inEpisode(_ m: LoadMetric) -> Bool { tracks[m]?.inEpisode == true }
    public func isSnoozed(_ m: LoadMetric) -> Bool { tracks[m]?.snoozed == true }

    /// The Assistant has it in hand: no alert for this metric until its episode ends.
    public mutating func snooze(_ m: LoadMetric) { tracks[m, default: Track()].snoozed = true }

    public mutating func observe(_ r: LoadReading) -> LoadAlert? {
        step([.cpu, .memory, .battery].map { ($0, thresholds.verdict($0, r)) }, at: r.at)
    }

    public mutating func observe(_ u: UsageReading) -> LoadAlert? {
        step([.session, .weekly].map { ($0, thresholds.verdict($0, u)) }, at: u.at)
    }

    private mutating func step(_ verdicts: [(LoadMetric, LoadVerdict)], at now: Date) -> LoadAlert? {
        recent.removeAll { now.timeIntervalSince($0) >= 24 * 3600 }
        var fired: [LoadMetric] = []
        for (m, verdict) in verdicts {
            var t = tracks[m] ?? Track()
            switch verdict {
            case .red(let sustain):
                t.clearSince = nil
                if !t.inEpisode {
                    let since = t.redSince ?? now
                    t.redSince = since
                    if now.timeIntervalSince(since) >= sustain {
                        t.inEpisode = true
                        let cooled = t.lastAlert.map { now.timeIntervalSince($0) >= thresholds.cooldown } ?? true
                        if cooled && !t.snoozed { fired.append(m) }
                    }
                }
            case .clear:
                t.redSince = nil
                // Snoozed while already clear: nothing to hold, and it must not swallow a later episode.
                if !t.inEpisode { t.snoozed = false }
                if t.inEpisode {
                    let since = t.clearSince ?? now
                    t.clearSince = since
                    if now.timeIntervalSince(since) >= thresholds.clearFor(m) {
                        t = Track(lastAlert: t.lastAlert)
                    }
                }
            case .between:
                // Not red enough to keep counting toward an episode; not clear enough to end one.
                t.redSince = nil
                t.clearSince = nil
            }
            tracks[m] = t
        }
        guard !fired.isEmpty, recent.count < thresholds.dailyCap else { return nil }
        for m in fired { tracks[m]?.lastAlert = now }
        recent.append(now)
        return LoadAlert(at: now, metrics: fired)
    }

    // MARK: persistence

    public static func file(base: URL = VoiceChannel.defaultBase) -> URL { base.appendingPathComponent("load-alerts.json") }

    public static func load(from url: URL = file()) -> LoadAlerts {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return (try? Data(contentsOf: url)).flatMap { try? d.decode(LoadAlerts.self, from: $0) } ?? LoadAlerts()
    }

    public func save(to url: URL = file()) {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        e.outputFormatting = .sortedKeys
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? e.encode(self).write(to: url, options: .atomic)
    }
}

/// What agents ask of the alerts, through `genlock load snooze|test`: a JSON array the app reads
/// and removes, `[{"op": "snooze", "metric": "battery"}, {"op": "test", "metric": "cpu"}]`.
public struct LoadRequest: Codable, Equatable, Sendable {
    public enum Op: String, Codable, Sendable { case snooze, test }
    public let op: Op
    public let metric: LoadMetric

    public init(op: Op, metric: LoadMetric) { self.op = op; self.metric = metric }

    public static func file(base: URL = VoiceChannel.defaultBase) -> URL { base.appendingPathComponent("load-requests.json") }

    /// Reads and removes the waiting requests. Ones it cannot read are dropped, not retried.
    public static func take(from url: URL = file()) -> [LoadRequest] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        try? FileManager.default.removeItem(at: url)
        return (try? JSONDecoder().decode([LoadRequest].self, from: data)) ?? []
    }
}

/// The one message an alert sends the Assistant: what went red, the recent numbers, who is using
/// the machine, and what it may do about it. Short, because it lands in a conversation.
public enum LoadAlertMessage {
    public static func text(_ alert: LoadAlert, readings: [LoadReading], usage: UsageReading?,
                            topProcesses: [String], test: Bool = false) -> String {
        var lines = ["[Load alert\(test ? " (test)" : "")] " + alert.metrics.map(name).joined(separator: " and ") + " went red."]
        let latest = readings.last
        for m in alert.metrics {
            if let s = describe(m, latest: latest, readings: readings, usage: usage) { lines.append("- " + s) }
        }
        if !alert.limitsOnly, !topProcesses.isEmpty {
            lines.append("Top processes by CPU (pid %cpu MB name):")
            lines += topProcesses.map { "  " + $0 }
        }
        lines.append(alert.limitsOnly
            ? "Decide whether running sessions should slow down, pause or hand off. You will not be told again while it stays red."
            : "Decide whether to pause, slow or reschedule work (batches, builds, extra sessions) and tell TJ only if it needs him. "
              + "You will not be told again while it stays red.")
        lines.append("Read the live numbers with `genlock load`. If you have it in hand, `genlock load snooze "
                     + alert.metrics.map(\.rawValue).joined(separator: "|") + "` keeps it quiet until it clears.")
        return lines.joined(separator: "\n")
    }

    static func name(_ m: LoadMetric) -> String {
        switch m {
        case .cpu: return "CPU"
        case .memory: return "Memory pressure"
        case .battery: return "Battery"
        case .session: return "The 5-hour Claude limit"
        case .weekly: return "The weekly Claude limit"
        }
    }

    static func describe(_ m: LoadMetric, latest r: LoadReading?, readings: [LoadReading], usage: UsageReading?) -> String? {
        func pct(_ v: Double) -> String { "\(Int(v.rounded()))%" }
        switch m {
        case .cpu:
            guard let r, let cpu = r.cpu else { return nil }
            let recent = readings.suffix(36).compactMap(\.cpu)
            let avg = recent.isEmpty ? cpu : recent.reduce(0, +) / Double(recent.count)
            return "CPU \(pct(cpu)) of \(r.cores) cores (3-min average \(pct(avg))), load average \(String(format: "%.1f", r.loadAverage))."
        case .memory:
            guard let r else { return nil }
            let level = r.pressureLevel == 4 ? "critical" : r.pressureLevel == 2 ? "warning" : "normal"
            return "Memory pressure \(r.memoryPressure.map(pct) ?? "?") (\(level))"
                + (r.swapUsedMB.map { String(format: ", %.1f GB swapped", $0 / 1024) } ?? "") + "."
        case .battery:
            guard let b = r?.battery else { return nil }
            return "Battery \(pct(b.level)), " + (b.onAC ? "on power but draining (adapter not keeping up)" : "on battery")
                + (b.drainWatts.map { String(format: ", %.1f W out", $0) } ?? "") + "."
        case .session:
            guard let s = usage?.session else { return nil }
            return "5-hour window \(pct(s.used)) used" + (s.resetsAt.map { ", resets \(UsageReading.resetLabel($0))" } ?? "") + "."
        case .weekly:
            guard let u = usage, let w = u.weekly else { return nil }
            return "Weekly \(pct(w.used)) used, \(u.overPace(now: u.at) ?? 0) points over even pace" + (w.resetsAt.map { ", resets \(UsageReading.resetLabel($0))" } ?? "") + "."
        }
    }
}

/// Where an alert's message goes. Claude-limit alerts never start an Assistant (`mayStart` false):
/// with none running they become a Mac notification.
public enum LoadDelivery: Equatable, Sendable {
    case submit, wait, start, notify

    public static func decide(running: Bool, working: Bool, dictating: Bool, mayStart: Bool) -> LoadDelivery {
        if running { return working || dictating ? .wait : .submit }
        return mayStart ? .start : .notify
    }
}
