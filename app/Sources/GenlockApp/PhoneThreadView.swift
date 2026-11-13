import SwiftUI
import GenlockCore

/// Reads the phone thread from every one of the Assistant's conversations, and again every few
/// seconds while it is showing, so a reply lands without reopening it.
@MainActor @Observable
final class PhoneThreadModel {
    private(set) var exchanges: [PhoneExchange] = []
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private let reader: PhoneThread.Reader

    init(assistantFolder: String) {
        reader = PhoneThread.Reader(folder: PhoneThread.transcriptFolder(for: assistantFolder))
    }

    func start() {
        reload()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    private func reload() {
        let reader = reader
        Task.detached(priority: .utility) {
            // The last two weeks is plenty to follow, and keeps the list quick to draw.
            let all = reader.read(since: Date().addingTimeInterval(-14 * 86_400))
            await MainActor.run { if all != self.exchanges { self.exchanges = all } }
        }
    }
}

/// Everything said from the phone and how the Assistant answered, in one thread on the Mac. The
/// Assistant's pane shows only its current conversation, and a status update starts a new one.
struct PhoneThreadView: View {
    @Environment(AppModel.self) private var model
    @State private var thread: PhoneThreadModel

    init(assistantFolder: String) {
        _thread = State(initialValue: PhoneThreadModel(assistantFolder: assistantFolder))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("From your phone", systemImage: "iphone").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(thread.exchanges.count) in the last two weeks").font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
            }
            .padding(12)
            Rectangle().fill(Theme.hairline).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if thread.exchanges.isEmpty {
                            Text("Nothing from the phone yet.").foregroundStyle(Theme.textSecondary).padding(.top, 20)
                        }
                        ForEach(thread.exchanges) { x in
                            exchange(x).id(x.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: thread.exchanges.last?.id) { _, last in
                    if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
                .onChange(of: thread.exchanges.last?.reply) { _, _ in
                    if let last = thread.exchanges.last?.id { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
                .onAppear {
                    if let last = thread.exchanges.last?.id { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
        .frame(width: 480, height: 620)
        .onAppear { thread.start() }
        .onDisappear { thread.stop() }
    }

    private func exchange(_ x: PhoneExchange) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            bubble(who: "You, from the phone", at: x.at, text: x.said, tint: Theme.cyan)
            if let reply = x.reply {
                bubble(who: model.assistantName, at: x.repliedAt ?? x.at, text: reply, tint: Theme.violet)
            } else {
                Text("\(model.assistantName) has not answered yet").font(.system(size: 11)).italic().foregroundStyle(Theme.textTertiary)
            }
        }
    }

    private func bubble(who: String, at: Date, text: String, tint: SwiftUI.Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(who).font(.system(size: 11, weight: .semibold)).foregroundStyle(tint)
                Text(at, format: Calendar.current.isDateInToday(at) ? .dateTime.hour().minute() : .dateTime.month().day().hour().minute())
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary)
            }
            Text(markdown(text)).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
