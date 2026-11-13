import XCTest
@testable import GenlockCore

final class LoadAlertsTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func reading(_ s: TimeInterval, cpu: Double? = 20, pressure: Int? = 1, battery: LoadReading.Battery? = nil) -> LoadReading {
        LoadReading(at: t0.addingTimeInterval(s), cpu: cpu, loadAverage: 0, cores: 10, memoryPressure: nil,
                    pressureLevel: pressure, swapUsedMB: nil, battery: battery)
    }

    /// Feeds one reading every 5 s from `from` to `to`, returning the alerts raised.
    func run(_ a: inout LoadAlerts, _ from: TimeInterval, _ to: TimeInterval, cpu: Double? = 20, pressure: Int? = 1,
             battery: LoadReading.Battery? = nil) -> [LoadAlert] {
        stride(from: from, to: to, by: 5).compactMap { a.observe(reading($0, cpu: cpu, pressure: pressure, battery: battery)) }
    }

    func testSustainedRedFiresOncePerEpisode() {
        var a = LoadAlerts()
        let alerts = run(&a, 0, 1800, cpu: 95)
        XCTAssertEqual(alerts.count, 1, "half an hour of red is one alert, not one per reading")
        XCTAssertEqual(alerts.first?.metrics, [.cpu])
        XCTAssertEqual(alerts.first?.at, t0.addingTimeInterval(180), "fires once red has held 3 minutes")
    }

    func testBriefSpikeDoesNotFire() {
        var a = LoadAlerts()
        var alerts: [LoadAlert] = []
        for minute in 0..<30 {
            let base = TimeInterval(minute * 60)
            alerts += run(&a, base, base + 120, cpu: 99) // two minutes red
            alerts += run(&a, base + 120, base + 180, cpu: 80) // a minute between the lines
        }
        XCTAssertEqual(alerts, [], "red never holds 3 minutes, so nothing fires")
    }

    func testFlappingAroundTheLineIsOneEpisode() {
        var a = LoadAlerts()
        var alerts = run(&a, 0, 200, cpu: 95)
        XCTAssertEqual(alerts.count, 1)
        // Dips under the red line but not under the clear line: still the same episode.
        for i in 0..<20 {
            let base = 200 + TimeInterval(i * 400)
            alerts += run(&a, base, base + 200, cpu: 75)
            alerts += run(&a, base + 200, base + 400, cpu: 95)
        }
        XCTAssertEqual(alerts.count, 1, "hysteresis: between 70 and 90 never ends the episode")
        XCTAssertTrue(a.inEpisode(.cpu))
        // A short clear does not end it either.
        alerts += run(&a, 9000, 9200, cpu: 30)
        alerts += run(&a, 9200, 9500, cpu: 95)
        XCTAssertEqual(alerts.count, 1, "clear must hold 5 minutes")
    }

    func testCooldownThenRearm() {
        var a = LoadAlerts()
        var alerts = run(&a, 0, 300, cpu: 95)
        alerts += run(&a, 300, 700, cpu: 30) // clears
        XCTAssertFalse(a.inEpisode(.cpu))
        alerts += run(&a, 700, 1200, cpu: 95) // second episode inside the hour
        XCTAssertEqual(alerts.count, 1, "cooldown: no second CPU alert within 60 minutes")
        alerts += run(&a, 1200, 1600, cpu: 30)
        alerts += run(&a, 4000, 4400, cpu: 95) // after the hour
        XCTAssertEqual(alerts.count, 2)
    }

    func testDailyCap() {
        var th = LoadThresholds()
        th.cooldown = 0
        var a = LoadAlerts(thresholds: th)
        var alerts: [LoadAlert] = []
        for i in 0..<12 {
            let base = TimeInterval(i * 1000)
            alerts += run(&a, base, base + 300, cpu: 95)
            alerts += run(&a, base + 300, base + 700, cpu: 30)
        }
        XCTAssertEqual(alerts.count, 6)
        let later = 24 * 3600 + 100.0
        alerts += run(&a, later, later + 300, cpu: 95)
        XCTAssertEqual(alerts.count, 7, "the cap is a rolling day")
    }

    func testSimultaneousMetricsMerge() {
        var a = LoadAlerts()
        let alerts = run(&a, 0, 600, cpu: 95, pressure: 4)
        XCTAssertEqual(alerts.map(\.metrics), [[.memory], [.cpu]], "critical memory fires at once, CPU after it holds")
        var b = LoadAlerts()
        _ = run(&b, 0, 60, cpu: 95)
        let merged = run(&b, 60, 600, cpu: 95, pressure: 2)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(Set(merged[0].metrics), [.cpu, .memory], "red together in one reading: one message")
    }

    func testSnoozeHoldsUntilClearThenRearms() {
        var th = LoadThresholds()
        th.cooldown = 0
        var a = LoadAlerts(thresholds: th)
        let low = LoadReading.Battery(level: 10, onAC: false, charging: false, drainWatts: 8)
        let charging = LoadReading.Battery(level: 12, onAC: true, charging: true, drainWatts: -30)
        var alerts = run(&a, 0, 120, battery: low)
        XCTAssertEqual(alerts.map(\.metrics), [[.battery]])
        a.snooze(.battery)
        alerts += run(&a, 120, 3000, battery: low)
        XCTAssertEqual(alerts.count, 1)
        // Plugged in for a moment, unplugged again: not a clear, so still snoozed.
        alerts += run(&a, 3000, 3060, battery: charging)
        alerts += run(&a, 3060, 3300, battery: low)
        XCTAssertEqual(alerts.count, 1)
        XCTAssertTrue(a.isSnoozed(.battery))
        // Charges properly: the episode ends and the snooze with it.
        alerts += run(&a, 3300, 3700, battery: charging)
        XCTAssertFalse(a.isSnoozed(.battery))
        alerts += run(&a, 3700, 3900, battery: low)
        XCTAssertEqual(alerts.count, 2, "re-armed after it cleared")
    }

    func testBatteryDrainingOnAC() {
        var a = LoadAlerts()
        let short = LoadReading.Battery(level: 70, onAC: true, charging: false, drainWatts: 5)
        XCTAssertEqual(run(&a, 0, 590, battery: short), [], "under 10 minutes is not yet an episode")
        XCTAssertEqual(run(&a, 590, 700, battery: short).map(\.metrics), [[.battery]])
        var b = LoadAlerts()
        XCTAssertEqual(run(&b, 0, 3600, battery: .init(level: 50, onAC: false, charging: false, drainWatts: 10)), [],
                       "draining on battery above 15% is normal use")
    }

    func usage(_ s: TimeInterval, session: Double, weekly: Double = 10) -> UsageReading {
        let at = t0.addingTimeInterval(s)
        // Weekly resets in 3.5 days, so even pace is 50%.
        return UsageReading(at: at, session: .init(used: session, resetsAt: at.addingTimeInterval(3600)),
                            weekly: .init(used: weekly, resetsAt: at.addingTimeInterval(3.5 * 86400)))
    }

    func testLimitAlertsAreMarkedAndClearOnReset() {
        var a = LoadAlerts()
        let first = a.observe(usage(0, session: 90))
        XCTAssertEqual(first?.metrics, [.session])
        XCTAssertEqual(first?.limitsOnly, true, "the app must not start an Assistant for this")
        XCTAssertNil(a.observe(usage(150, session: 95)))
        XCTAssertNil(a.observe(usage(300, session: 70)), "between the lines holds the episode")
        XCTAssertTrue(a.inEpisode(.session))
        XCTAssertNil(a.observe(usage(450, session: 2)), "the reset")
        XCTAssertFalse(a.inEpisode(.session), "usage clears at once")
        XCTAssertEqual(a.observe(usage(0, session: 10, weekly: 70))?.metrics, [.weekly], "20 over even pace")
        XCTAssertEqual(LoadAlert(at: t0, metrics: [.cpu, .session]).limitsOnly, false)
    }

    func testStateSurvivesARelaunch() throws {
        var a = LoadAlerts()
        _ = run(&a, 0, 300, cpu: 95)
        a.snooze(.cpu) // mid-episode, so it holds
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("load-alerts-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        a.save(to: url)
        var back = LoadAlerts.load(from: url)
        XCTAssertEqual(back, a)
        XCTAssertEqual(run(&back, 300, 1000, cpu: 95), [], "relaunching mid-episode does not alert again")
        XCTAssertTrue(back.isSnoozed(.cpu))
    }

    func testMessageNamesWhatWentRedAndHowToSnooze() {
        let r = reading(0, cpu: 96, pressure: 4)
        let text = LoadAlertMessage.text(LoadAlert(at: t0, metrics: [.cpu, .memory]), readings: [r], usage: nil,
                                         topProcesses: ["123 410.0 2048 swift-frontend"])
        XCTAssert(text.hasPrefix("[Load alert] CPU and Memory pressure went red."), text)
        XCTAssert(text.contains("CPU 96% of 10 cores"), text)
        XCTAssert(text.contains("(critical)"), text)
        XCTAssert(text.contains("swift-frontend"), text)
        XCTAssert(text.contains("genlock load snooze cpu|memory"), text)
        let limit = LoadAlertMessage.text(LoadAlert(at: t0, metrics: [.session]), readings: [], usage: usage(0, session: 91),
                                          topProcesses: ["123 410.0 2048 swift-frontend"])
        XCTAssert(limit.contains("5-hour window 91% used"), limit)
        XCTAssertFalse(limit.contains("swift-frontend"), "processes say nothing about Claude limits")
    }

    func testRequestsAreTakenOnce() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("load-requests-\(UUID()).json")
        try Data(#"[{"op":"snooze","metric":"battery"},{"op":"test","metric":"cpu"}]"#.utf8).write(to: url)
        XCTAssertEqual(LoadRequest.take(from: url), [LoadRequest(op: .snooze, metric: .battery), LoadRequest(op: .test, metric: .cpu)])
        XCTAssertEqual(LoadRequest.take(from: url), [], "removed once read")
    }

    func testSnoozeWhileClearIsDroppedAtOnce() {
        var a = LoadAlerts()
        a.snooze(.battery)
        _ = a.observe(reading(0, battery: .init(level: 60, onAC: true, charging: true, drainWatts: -20)))
        XCTAssertFalse(a.isSnoozed(.battery), "already clear: the snooze must not swallow a later episode")
        let alerts = run(&a, 5, 200, battery: .init(level: 10, onAC: false, charging: false, drainWatts: 8))
        XCTAssertEqual(alerts.map(\.metrics), [[.battery]])
    }

    func testLimitAlertsNeverStartAnAssistant() {
        let limit = LoadAlert(at: t0, metrics: [.session, .weekly])
        XCTAssertEqual(LoadDelivery.decide(running: false, working: false, dictating: false, mayStart: !limit.limitsOnly), .notify)
        XCTAssertEqual(LoadDelivery.decide(running: true, working: false, dictating: false, mayStart: !limit.limitsOnly), .submit,
                       "a running Assistant is told")
        XCTAssertEqual(LoadDelivery.decide(running: false, working: false, dictating: false, mayStart: true), .start)
        XCTAssertEqual(LoadDelivery.decide(running: true, working: true, dictating: false, mayStart: true), .wait)
        XCTAssertEqual(LoadDelivery.decide(running: true, working: false, dictating: true, mayStart: false), .wait)
    }
}
