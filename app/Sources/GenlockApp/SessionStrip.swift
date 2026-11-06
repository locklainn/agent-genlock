import GenlockCore
import SwiftUI

extension TerminalSession {
    /// The ids its agent has gone by, which is how a task says whose it is.
    var agents: Set<String> { Set([conversation, spawn?.session].compactMap { $0 }) }

    func focus(in snapshot: Snapshot) -> Snapshot.SessionFocus {
        snapshot.sessionFocus(agents: agents, ticket: spawn?.ticket)
    }
}

/// What one session is on, in the least room that says it. Replaces the panel in a split, where
/// a panel per pane mostly repeats the same project and squeezes the terminals.
struct SessionStrip: View {
    @Environment(AppModel.self) private var model
    let session: TerminalSession
    let tier: Tier
    let openPanel: () -> Void

    var body: some View {
        if let snap = model.state(for: session.projectID).snapshot, snap.initialized {
            let own = session.focus(in: snap)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Image(systemName: "scope").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.tint(tier)[0])
                    Text(own.goal.map { Snapshot.heading(short: $0.short, title: $0.title) } ?? "No goal yet")
                        .font(.system(size: 12.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                    if let progress = own.goal?.progress, progress.total > 0 {
                        Text("\(progress.done)/\(progress.total)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textTertiary)
                    }
                    Spacer(minLength: 6)
                    if !snap.questionsForUser.isEmpty {
                        Button(action: openPanel) {
                            Label("\(snap.questionsForUser.count)", systemImage: "person.fill.questionmark")
                                .font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.violet)
                        }
                        .buttonStyle(.plain)
                        .help("Waiting on you. Opens goals and tasks.")
                    }
                }
                if let task = own.working {
                    WorkingOnRow(task: task, more: own.mine.count - 1, working: session.phase == "working", tier: tier)
                } else {
                    Text("Not on a task yet").font(.system(size: 11.5)).foregroundStyle(Theme.textTertiary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.white.opacity(0.02))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
        }
    }
}

/// The task this session is on, marked out from every other task in the project. It pulses only
/// while the agent is actually working, so a still one means it has stopped.
struct WorkingOnRow: View {
    let task: Snapshot.Ticket
    var more = 0
    let working: Bool
    let tier: Tier

    var body: some View {
        let symbol = task.status == "blocked" ? Theme.status(task.status) : (name: "bolt.fill", color: Theme.tint(tier)[0])
        HStack(spacing: 6) {
            Image(systemName: symbol.name).font(.system(size: 10.5, weight: .bold)).foregroundStyle(symbol.color)
            Text(Snapshot.heading(short: task.short, title: task.title))
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
            Spacer(minLength: 4)
            if more > 0 { Text("+\(more)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textSecondary) }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .modifier(WorkingGlow(active: working, tier: tier))
        .accessibilityLabel("This session is on \(task.title)")
    }
}

struct WorkingGlow: ViewModifier {
    let active: Bool
    let tier: Tier
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.phaseAnimator([0.15, 1.0]) { view, strength in
                look(view, strength: strength)
            } animation: { _ in .easeInOut(duration: 1.1) }
        } else {
            look(content, strength: active ? 1 : 0)
        }
    }

    private func look<V: View>(_ view: V, strength: Double) -> some View {
        let tint = Theme.tint(tier)
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        return view
            .background(LinearGradient(colors: tint.map { $0.opacity(0.24) }, startPoint: .leading, endPoint: .trailing), in: shape)
            .overlay(shape.strokeBorder(LinearGradient(colors: tint, startPoint: .leading, endPoint: .trailing), lineWidth: 1).opacity(0.45 + 0.55 * strength))
            .shadow(color: tint[0].opacity(0.75 * strength), radius: 8)
    }
}
