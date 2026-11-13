import XCTest
@testable import GenlockCore

final class SystemLoadTests: XCTestCase {
    func testBusyShareFromTicks() {
        let a = CPUTicks(user: 100, system: 50, idle: 800, nice: 50)
        let b = CPUTicks(user: 160, system: 70, idle: 900, nice: 70)
        XCTAssertEqual(b.busy(since: a)!, 50, accuracy: 0.001)
        XCTAssertNil(a.busy(since: a), "no ticks passed")
        XCTAssertEqual(CPUTicks(user: 100, system: 50, idle: 798, nice: 50).busy(since: a), nil, "a step back counts as zero, so nothing passed")
        let wrapped = CPUTicks(user: 10, system: 50, idle: 900, nice: 50).busy(since: CPUTicks(user: UInt64(UInt32.max) - 9, system: 50, idle: 880, nice: 50))
        XCTAssertEqual(wrapped!, 50, accuracy: 0.001, "a 32-bit wrap is 20 ticks, not a step back")
    }

    func testDrainWattsReadsUnsignedAmperageAsSigned() {
        // ioreg on TJ's Mac: Amperage = 18446744073709551360 (−256 mA), Voltage = 10856 mV.
        let w = LoadSampler.drainWatts(amperage: NSNumber(value: UInt64(18446744073709551360)), voltageMV: 10856)
        XCTAssertEqual(w, 2.779, accuracy: 0.001)
        XCTAssertEqual(LoadSampler.drainWatts(amperage: NSNumber(value: 1000), voltageMV: 12000), -12, accuracy: 0.001, "charging is negative drain")
    }

    func testHistoryIsCapped() {
        var h = LoadHistory(capacity: 3)
        for i in 0..<5 {
            h.append(LoadReading(at: Date(timeIntervalSince1970: Double(i)), cpu: Double(i), loadAverage: 0, cores: 1,
                                 memoryPressure: nil, pressureLevel: nil, swapUsedMB: nil, battery: nil))
        }
        XCTAssertEqual(h.readings.map(\.cpu), [2, 3, 4])
    }

    func testLiveSampleAndJSON() throws {
        let s = LoadSampler()
        _ = s.sample()
        sleep(2) // well past the kernel's burst limit, in case another test just hammered it
        let r = s.sample()
        let cpu = try XCTUnwrap(r.cpu)
        XCTAssert((0...100).contains(cpu))
        XCTAssert((0...100).contains(try XCTUnwrap(r.memoryPressure)))
        let json = try XCTUnwrap(r.json())
        let back = try JSONSerialization.jsonObject(with: json) as? [String: Any]
        XCTAssertNotNil(back?["cpu"])
    }
}

final class SystemLoadCostTests: XCTestCase {
    /// Requirement: sampling costs under 1% CPU. At one reading per 5 s, 1% is 50 ms of CPU per reading.
    func testSampleCostIsFarUnderOnePercent() {
        let s = LoadSampler()
        let n = 200
        let start = clock()
        for _ in 0..<n { _ = s.sample() }

        let msPer = Double(clock() - start) / Double(CLOCKS_PER_SEC) * 1000 / Double(n)
        print("LOADCOST ms of CPU per sample: \(msPer); share of one core at 5 s cadence: \(msPer / 5000 * 100)%")
        XCTAssertLessThan(msPer, 5)
    }
}
