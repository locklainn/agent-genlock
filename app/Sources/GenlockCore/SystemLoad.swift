import Darwin
import Foundation
import IOKit
import IOKit.ps

/// How pressured the Mac is right now: CPU, memory and battery, read from the kernel and the
/// battery's own gauge. Codable and plain on purpose: this is the shape agents will be handed
/// later (system-load goal), so nothing here knows about views.
public struct LoadReading: Equatable, Sendable, Codable {
    public struct Battery: Equatable, Sendable, Codable {
        /// 0–100, as the menu bar shows it.
        public let level: Double
        public let onAC: Bool
        public let charging: Bool
        /// Power out of the battery in watts: positive is drain, negative is charging. Nil when the
        /// gauge does not say. On AC this can still be positive, when the adapter falls short.
        public let drainWatts: Double?

        public init(level: Double, onAC: Bool, charging: Bool, drainWatts: Double?) {
            self.level = level
            self.onAC = onAC
            self.charging = charging
            self.drainWatts = drainWatts
        }
    }

    public let at: Date
    /// Share of all cores busy since the previous reading, 0–100. Nil on the first reading.
    public let cpu: Double?
    /// One-minute load average, and the cores it should be read against.
    public let loadAverage: Double
    public let cores: Int
    /// 0–100: the kernel's own measure (100 − kern.memorystatus_level), what Activity Monitor's
    /// memory pressure graph is built on.
    public let memoryPressure: Double?
    /// The kernel's verdict: 1 normal, 2 warning, 4 critical.
    public let pressureLevel: Int?
    public let swapUsedMB: Double?
    /// Nil on a Mac with no battery.
    public let battery: Battery?

    public init(at: Date, cpu: Double?, loadAverage: Double, cores: Int, memoryPressure: Double?,
                pressureLevel: Int?, swapUsedMB: Double?, battery: Battery?) {
        self.at = at
        self.cpu = cpu
        self.loadAverage = loadAverage
        self.cores = cores
        self.memoryPressure = memoryPressure
        self.pressureLevel = pressureLevel
        self.swapUsedMB = swapUsedMB
        self.battery = battery
    }

    /// One JSON object per reading, the form to hand an agent.
    public func json() -> Data? {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        e.outputFormatting = .sortedKeys
        return try? e.encode(self)
    }
}

/// Cumulative CPU ticks across all cores. Busy share is the difference between two of these.
public struct CPUTicks: Equatable, Sendable {
    public let user, system, idle, nice: UInt64

    public init(user: UInt64, system: UInt64, idle: UInt64, nice: UInt64) {
        self.user = user
        self.system = system
        self.idle = idle
        self.nice = nice
    }

    /// Busy share from `earlier` to `self`, 0–100; nil when no ticks passed. The kernel keeps these
    /// as 32-bit counters that wrap, and under heavy load a counter can step back by a few ticks
    /// (seen 13 Nov 2026 at load average 50), so a wrap is undone and a step back counts as zero.
    public func busy(since earlier: CPUTicks) -> Double? {
        func delta(_ now: UInt64, _ then: UInt64) -> UInt64 {
            let d = UInt32(truncatingIfNeeded: now) &- UInt32(truncatingIfNeeded: then)
            return d > UInt32.max / 2 ? 0 : UInt64(d)
        }
        let busy = delta(user, earlier.user) + delta(system, earlier.system) + delta(nice, earlier.nice)
        let total = busy + delta(idle, earlier.idle)
        return total == 0 ? nil : Double(busy) / Double(total) * 100
    }
}

/// The last readings, oldest first, capped so it never grows.
public struct LoadHistory: Equatable, Sendable {
    public let capacity: Int
    public private(set) var readings: [LoadReading] = []

    public init(capacity: Int) { self.capacity = capacity }

    public mutating func append(_ r: LoadReading) {
        readings.append(r)
        if readings.count > capacity { readings.removeFirst(readings.count - capacity) }
    }

    public var latest: LoadReading? { readings.last }
}

/// Reads the machine. Holds the previous CPU ticks, so one sampler per caller.
public final class LoadSampler {
    private var previous: CPUTicks?

    public init() {}

    public func sample(at now: Date = Date()) -> LoadReading {
        let ticks = Self.cpuTicks()
        let cpu = zip2(ticks, previous).flatMap { $0.busy(since: $1) }
        previous = ticks ?? previous
        var avg = [Double](repeating: 0, count: 3)
        getloadavg(&avg, 3)
        let level = Self.sysctlInt("kern.memorystatus_level")
        return LoadReading(
            at: now, cpu: cpu, loadAverage: avg[0], cores: ProcessInfo.processInfo.activeProcessorCount,
            memoryPressure: level.map { Double(100 - $0) }, pressureLevel: Self.sysctlInt("kern.memorystatus_vm_pressure_level"),
            swapUsedMB: Self.swapUsedMB(), battery: Self.battery())
    }

    private func zip2<A, B>(_ a: A?, _ b: B?) -> (A, B)? { a.flatMap { a in b.map { (a, $0) } } }

    /// Taken once: each mach_host_self() call adds a reference to the port name.
    nonisolated(unsafe) private static let host = mach_host_self()

    /// The kernel rate-limits these reads: a burst of a few hundred gets the same cached ticks
    /// back for a moment (measured 13 Nov 2026). Readings seconds apart are unaffected.
    static func cpuTicks() -> CPUTicks? {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(host, HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let t = info.cpu_ticks
        return CPUTicks(user: UInt64(t.0), system: UInt64(t.1), idle: UInt64(t.2), nice: UInt64(t.3))
    }

    static func sysctlInt(_ name: String) -> Int? {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return nil }
        return Int(value)
    }

    static func swapUsedMB() -> Double? {
        var usage = xsw_usage()
        var size = MemoryLayout<xsw_usage>.size
        guard sysctlbyname("vm.swapusage", &usage, &size, nil, 0) == 0 else { return nil }
        return Double(usage.xsu_used) / 1_048_576
    }

    static func battery() -> LoadReading.Battery? {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for source in list {
            guard let d = IOPSGetPowerSourceDescription(blob, source)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let current = d[kIOPSCurrentCapacityKey] as? Double,
                  let max = d[kIOPSMaxCapacityKey] as? Double, max > 0 else { continue }
            return LoadReading.Battery(
                level: current / max * 100,
                onAC: d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue,
                charging: d[kIOPSIsChargingKey] as? Bool ?? false,
                drainWatts: gaugeDrainWatts())
        }
        return nil
    }

    /// From the smart battery's own gauge: amperage (mA, negative out) times voltage (mV).
    static func gaugeDrainWatts() -> Double? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        func number(_ key: String) -> NSNumber? {
            IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber
        }
        guard let amps = number("InstantAmperage") ?? number("Amperage"), let volts = number("Voltage") else { return nil }
        return drainWatts(amperage: amps, voltageMV: volts.doubleValue)
    }

    /// The registry keeps amperage as a signed 64-bit number that some readers see as unsigned
    /// (ioreg prints −256 mA as 18446744073709551360), so the bits are reread as signed.
    public static func drainWatts(amperage: NSNumber, voltageMV: Double) -> Double {
        let mA = Double(Int64(bitPattern: amperage.uint64Value))
        return -mA * voltageMV / 1_000_000
    }
}
