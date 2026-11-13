import GenlockCore
import SwiftUI

/// Samples the machine every few seconds while the load panel is on, and not at all while it is
/// off: switching it off stops the timer and drops the history.
@MainActor @Observable
final class LoadMonitor {
    static let every: TimeInterval = 5
    /// Ten minutes of trend at one reading every five seconds.
    static let kept = 120

    private(set) var history = LoadHistory(capacity: LoadMonitor.kept)
    @ObservationIgnored private var sampler: LoadSampler?
    @ObservationIgnored private var timer: Timer?

    var enabled = UserDefaults.standard.object(forKey: "loadPanel") as? Bool ?? true {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: "loadPanel")
            enabled ? start() : stop()
        }
    }

    func start() {
        guard enabled, timer == nil else { return }
        let sampler = LoadSampler()
        self.sampler = sampler
        _ = sampler.sample() // primes the CPU ticks; the first busy share needs two readings
        timer = Timer.scheduledTimer(withTimeInterval: Self.every, repeats: true) { _ in
            MainActor.assumeIsolated { AppModel.shared.load.tick() }
        }
        timer?.tolerance = 1
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
        sampler = nil
        history = LoadHistory(capacity: Self.kept)
        pending = nil
        try? FileManager.default.removeItem(at: Self.latestFile)
    }

    private func tick() {
        guard let sampler else { return }
        let reading = sampler.sample()
        history.append(reading)
        if let json = reading.json() { try? json.write(to: Self.latestFile, options: .atomic) }
        let before = alerts
        handleRequests()
        if alertsEnabled, let alert = alerts.observe(reading) { raise(alert) }
        if alerts != before { alerts.save() }
        deliverPending()
    }

    /// The latest reading, for `genlock load`. Removed when the panel is off, so no stale numbers.
    static var latestFile: URL { VoiceChannel.defaultBase.appendingPathComponent("load.json") }

    // MARK: alerts

    /// One alert per red episode, to the Assistant. Off whenever the panel is off, since nothing is sampled then.
    var alertsEnabled = UserDefaults.standard.object(forKey: "loadAlerts") as? Bool ?? true {
        didSet { UserDefaults.standard.set(alertsEnabled, forKey: "loadAlerts") }
    }
    @ObservationIgnored private var alerts = LoadAlerts.load()
    /// Composed but not yet delivered: the Assistant was mid-turn.
    @ObservationIgnored private var pending: (text: String, mayStart: Bool)?

    /// The usage poll's newest reading. Only while the panel and alerts are both on.
    func observe(_ usage: UsageReading) {
        guard enabled, alertsEnabled, timer != nil else { return }
        let before = alerts
        if let alert = alerts.observe(usage) { raise(alert, usage: usage) }
        if alerts != before { alerts.save() }
        deliverPending()
    }

    private func handleRequests() {
        for request in LoadRequest.take() {
            switch request.op {
            case .snooze: alerts.snooze(request.metric)
            case .test: if alertsEnabled { raise(LoadAlert(at: Date(), metrics: [request.metric]), test: true) }
            }
        }
    }

    private func raise(_ alert: LoadAlert, usage: UsageReading? = nil, test: Bool = false) {
        let text = LoadAlertMessage.text(alert, readings: history.readings, usage: usage ?? AppModel.shared.usage,
                                         topProcesses: alert.limitsOnly ? [] : Self.topProcesses(), test: test)
        // A later alert replaces one still waiting, keeping the right to start an Assistant if either had it.
        pending = (text, !alert.limitsOnly || (pending?.mayStart ?? false))
        deliverPending()
    }

    private func deliverPending() {
        guard let p = pending else { return }
        switch AppModel.shared.tellAssistant(p.text, mayStart: p.mayStart) {
        case .delivered: pending = nil
        case .busy: break
        case .notRunning:
            pending = nil
            Notifier.postLoad(p.text)
        }
    }

    /// The five busiest processes: "pid %cpu MB name". Run only when an alert fires.
    static func topProcesses() -> [String] {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-Aro", "pid=,pcpu=,rss=,comm="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return [] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        return String(decoding: data, as: UTF8.self).split(separator: "\n").prefix(5).compactMap { line in
            let f = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard f.count == 4 else { return nil }
            let mb = (Double(f[2]) ?? 0) / 1024
            return "\(f[0]) \(f[1]) \(Int(mb)) \((f[3] as Substring).split(separator: "/").last.map(String.init) ?? String(f[3]))"
        }
    }
}

/// CPU, memory pressure and battery beside the usage bars: a value and a ten-minute trend line each.
struct LoadMeter: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let load = model.load
        if load.enabled, let latest = load.history.latest {
            // Gives way when the header is crowded: trend lines go first, then the chips.
            ViewThatFits(in: .horizontal) {
                chips(latest, trends: true)
                chips(latest, trends: false)
                Color.clear.frame(width: 0, height: 0)
            }
            .layoutPriority(-1)
            .help(detail(latest))
            .contextMenu { Button("Hide System Load") { model.load.enabled = false } }
            .accessibilityElement(children: .combine)
        }
    }

    private func chips(_ latest: LoadReading, trends: Bool) -> some View {
        let rs = model.load.history.readings
        // Three separate chips in a row, one per reading, each with its own trend line.
        return HStack(spacing: 6) {
            if let cpu = latest.cpu {
                chip("cpu", rs.map { $0.cpu }, scale: 100, value: "\(Int(cpu.rounded()))%", color: cpuColor(cpu), trend: trends)
            }
            if let mem = latest.memoryPressure {
                chip("mem", rs.map { $0.memoryPressure }, scale: 100, value: "\(Int(mem.rounded()))%", color: memColor(latest), trend: trends)
            }
            if let bat = latest.battery {
                let drains = rs.map { $0.battery?.drainWatts.map { max(0, $0) } }
                let peak = max(20, drains.compactMap { $0 }.max() ?? 0)
                chip("bat", drains, scale: peak, value: batteryValue(bat), color: batColor(bat), trend: trends)
            }
        }
        .fixedSize()
    }

    private func chip(_ label: String, _ values: [Double?], scale: Double, value: String, color: Color, trend: Bool) -> some View {
        HStack(spacing: 5) {
            Text(label).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.textTertiary)
            if trend {
                Sparkline(values: values, scale: scale, slots: LoadMonitor.kept, color: color)
                    .frame(width: 34, height: 14)
            }
            Text(value).font(.system(size: 10.5, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(color)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(Color.white.opacity(0.05), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
    }

    private func batteryValue(_ b: LoadReading.Battery) -> String {
        let level = "\(Int(b.level.rounded()))%"
        guard let w = b.drainWatts, abs(w) >= 0.1 else { return level }
        return level + (w > 0 ? " −" : " +") + String(format: "%.1fW", abs(w))
    }

    private func cpuColor(_ cpu: Double) -> Color { cpu >= 85 ? Theme.red : cpu >= 60 ? Theme.amber : Theme.green }
    private func memColor(_ r: LoadReading) -> Color {
        switch r.pressureLevel {
        case 4?: return Theme.red
        case 2?: return Theme.amber
        default: return (r.memoryPressure ?? 0) >= 80 ? Theme.amber : Theme.green
        }
    }
    /// Draining matters more than level: low and falling is red, falling on AC is amber.
    private func batColor(_ b: LoadReading.Battery) -> Color {
        let draining = (b.drainWatts ?? 0) > 0.1
        if draining && b.level < 20 { return Theme.red }
        if draining && b.onAC { return Theme.amber }
        if b.level < 10 { return Theme.amber }
        return Theme.green
    }

    private func detail(_ r: LoadReading) -> String {
        var lines: [String] = []
        if let cpu = r.cpu {
            lines.append("CPU: \(Int(cpu.rounded()))% of \(r.cores) cores busy. Load average \(String(format: "%.1f", r.loadAverage)).")
        }
        if let mem = r.memoryPressure {
            let verdict = r.pressureLevel == 4 ? "critical" : r.pressureLevel == 2 ? "warning" : "normal"
            lines.append("Memory pressure: \(Int(mem.rounded()))% (\(verdict))" + (r.swapUsedMB.map { String(format: ", %.1f GB swapped", $0 / 1024) } ?? "") + ".")
        }
        if let b = r.battery {
            var s = "Battery: \(Int(b.level.rounded()))%, " + (b.charging ? "charging" : b.onAC ? "on power, not charging" : "on battery")
            if let w = b.drainWatts { s += w > 0.1 ? String(format: ", draining %.1f W", w) : w < -0.1 ? String(format: ", charging at %.1f W", -w) : "" }
            if b.onAC, (b.drainWatts ?? 0) > 0.1 { s += ". The adapter is not keeping up" }
            lines.append(s + ".")
        }
        lines.append("Trend lines cover the last \(LoadMonitor.kept * Int(LoadMonitor.every) / 60) minutes. The battery line is drain in watts. Right-click to hide.")
        return lines.joined(separator: "\n")
    }
}

/// A trend line filled from the right, so a short history sits at the recent end.
struct Sparkline: View {
    let values: [Double?]
    let scale: Double
    let slots: Int
    let color: Color

    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 2), with: .color(.white.opacity(0.06)))
            guard slots > 1, scale > 0 else { return }
            let step = size.width / Double(slots - 1)
            let start = slots - values.count
            var line = Path()
            var area = Path()
            var first: CGPoint?
            var last: CGPoint?
            for (i, v) in values.enumerated() {
                guard let v else { continue }
                let p = CGPoint(x: Double(start + i) * step, y: size.height - min(1, max(0, v / scale)) * (size.height - 1) - 0.5)
                if first == nil { line.move(to: p); area.move(to: CGPoint(x: p.x, y: size.height)); area.addLine(to: p); first = p }
                else { line.addLine(to: p); area.addLine(to: p) }
                last = p
            }
            guard let last else { return }
            area.addLine(to: CGPoint(x: last.x, y: size.height))
            area.closeSubpath()
            ctx.fill(area, with: .color(color.opacity(0.22)))
            ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))
        }
    }
}
