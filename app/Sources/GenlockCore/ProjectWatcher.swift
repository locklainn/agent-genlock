import CoreServices
import Foundation

/// Calls back when a project's records or claims change. A repository can churn thousands of
/// files during a build, so everything else is filtered out before any work is scheduled.
public final class ProjectWatcher {
    private var stream: FSEventStreamRef?
    private let queue = DispatchQueue(label: "genlock.watcher")
    private let onChange: () -> Void
    private let debounce: TimeInterval
    private var pending: DispatchWorkItem?

    public init(folder: String, debounce: TimeInterval = 0.15, onChange: @escaping () -> Void) {
        self.onChange = onChange
        self.debounce = debounce

        var context = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<ProjectWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(paths, to: NSArray.self)
            for i in 0..<count {
                if let path = list[i] as? String, ProjectWatcher.isRelevant(path) {
                    watcher.schedule()
                    return
                }
            }
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        stream = FSEventStreamCreate(nil, callback, &context, [folder] as CFArray,
                                     FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.1, flags)
        if let stream {
            FSEventStreamSetDispatchQueue(stream, queue)
            FSEventStreamStart(stream)
        }
    }

    deinit { stop() }

    public func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    private func schedule() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.onChange() }
        pending = work
        queue.asyncAfter(deadline: .now() + debounce, execute: work)
    }

    public static func isRelevant(_ path: String) -> Bool {
        path.contains("/.genlock/records/") || path.hasSuffix("/.genlock/records")
            || path.contains("/.git/genlock/claims/")
    }
}
