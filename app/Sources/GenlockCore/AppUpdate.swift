import Foundation

/// When the app should rebuild itself from its own source.
public enum AppUpdate {
    /// Long enough that an agent partway through an edit is not built.
    public static let quietSeconds: TimeInterval = 20

    public enum Next: Equatable { case nothing, build, offerRestart }

    /// - Parameters:
    ///   - running: when the running app's build began.
    ///   - available: when the newest finished build began, if there is one.
    ///   - newestSource: when a source file last changed.
    ///   - lastAttempt: when the last build began, so a failure waits for the next change.
    public static func next(running: TimeInterval, available: TimeInterval?, newestSource: TimeInterval,
                            lastAttempt: TimeInterval?, now: TimeInterval) -> Next {
        let built = max(running, available ?? 0, lastAttempt ?? 0)
        if newestSource > built {
            return now - newestSource >= quietSeconds ? .build : .nothing
        }
        if let available, available > running, available > newestSource { return .offerRestart }
        return .nothing
    }

    /// Replaces the app once it has quit, then opens the new one. Sessions are unaffected: they
    /// belong to their hosts, and a running host does not mind its file being replaced.
    public static let swapScript = """
    while kill -0 "$1" 2>/dev/null; do sleep 0.1; done
    rm -rf "$3.new"
    if cp -R "$2" "$3.new"; then
      rm -rf "$3"
      mv "$3.new" "$3"
    fi
    open "$3"
    """

    /// The line of a failed build worth showing.
    public static func failure(from log: String) -> String {
        let lines = log.split(separator: "\n").map(String.init)
        return lines.first { $0.contains("error:") }?.trimmingCharacters(in: .whitespaces)
            ?? lines.last ?? "The build failed."
    }
}
