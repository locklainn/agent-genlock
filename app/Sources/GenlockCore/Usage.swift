import Foundation

/// The plan's two usage bars, as the server last reported them. Sessions in the app print no
/// status line (an empty one still takes a row), so the app asks the server and shows them itself.
public struct UsageReading: Equatable, Sendable {
    public struct Bar: Equatable, Sendable {
        public let used: Double
        public let resetsAt: Date?
    }

    public let at: Date
    public let session: Bar?
    public let weekly: Bar?

    public init(at: Date, session: Bar?, weekly: Bar?) {
        self.at = at
        self.session = session
        self.weekly = weekly
    }

    public static func file(base: URL = VoiceChannel.defaultBase) -> URL { base.appendingPathComponent("usage.json") }

    public static func load(from url: URL = file()) -> UsageReading? {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let at = json["at"] as? Double else { return nil }
        func bar(_ key: String) -> Bar? {
            guard let b = json[key] as? [String: Any], let used = b["used"] as? Double else { return nil }
            return Bar(used: used, resetsAt: (b["resetsAt"] as? Double).map { Date(timeIntervalSince1970: $0) })
        }
        return UsageReading(at: Date(timeIntervalSince1970: at / 1000), session: bar("session"), weekly: bar("weekly"))
    }

    /// A reply from the endpoint /usage reads: `{"five_hour": {"utilization": 18.0, "resets_at": "..."}, "seven_day": {...}}`.
    public static func fromServer(_ data: Data, at: Date = Date()) -> UsageReading? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        func bar(_ key: String) -> Bar? {
            guard let b = json[key] as? [String: Any], let used = (b["utilization"] as? NSNumber)?.doubleValue else { return nil }
            return Bar(used: used, resetsAt: (b["resets_at"] as? String).flatMap(serverDate))
        }
        let reading = UsageReading(at: at, session: bar("five_hour"), weekly: bar("seven_day"))
        return reading.session == nil && reading.weekly == nil ? nil : reading
    }

    /// "2026-11-09T02:20:00.019920+00:00": six fractional digits, which ISO8601DateFormatter refuses.
    static func serverDate(_ s: String) -> Date? {
        let trimmed = s.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: trimmed)
    }

    /// The same shape `genlock status-line` writes, so either source feeds the meter.
    public func save(to url: URL = file()) throws {
        func bar(_ b: Bar?) -> Any { b.map { ["used": $0.used, "resetsAt": $0.resetsAt.map { $0.timeIntervalSince1970 } as Any] } ?? NSNull() }
        let json: [String: Any] = ["at": (at.timeIntervalSince1970 * 1000).rounded(), "session": bar(session), "weekly": bar(weekly)]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
    }

    /// Where even use would put the weekly bar by now: the share of its seven days already gone.
    public func pace(now: Date = Date()) -> Int? {
        guard let reset = weekly?.resetsAt else { return nil }
        let week: TimeInterval = 7 * 24 * 3600
        let gone = now.timeIntervalSince(reset.addingTimeInterval(-week)) / week
        guard gone >= 0, gone <= 1 else { return nil }
        return Int((gone * 100).rounded())
    }

    /// Ahead of even pace by this many points (negative when under it).
    public func overPace(now: Date = Date()) -> Int? {
        guard let weekly, let pace = pace(now: now) else { return nil }
        return Int(weekly.used.rounded()) - pace
    }

    /// A bar whose reset has passed is no longer known, so it is not shown as current.
    public func isCurrent(_ bar: Bar?, now: Date = Date()) -> Bool {
        guard let bar else { return false }
        return bar.resetsAt.map { $0 > now } ?? true
    }

    /// "Sun 11:20am", or "11:20am" when it is today.
    public static func resetLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = calendar.isDate(date, inSameDayAs: now) ? "h:mma" : "EEE h:mma"
        return f.string(from: date).replacingOccurrences(of: "AM", with: "am").replacingOccurrences(of: "PM", with: "pm")
    }
}
