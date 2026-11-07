import GenlockCore
import SwiftUI

extension TerminalSession {
    /// The ids its agent has gone by, which is how a task says whose it is.
    var agents: Set<String> { Set([conversation, spawn?.session].compactMap { $0 }) }

    func focus(in snapshot: Snapshot) -> Snapshot.SessionFocus {
        snapshot.sessionFocus(agents: agents, ticket: spawn?.ticket)
    }

    func status(in snapshot: Snapshot) -> Snapshot.SessionStatus {
        Snapshot.sessionStatus(phase: phase, isRunning: isRunning, message: attentionMessage, focus: focus(in: snapshot))
    }
}

/// What one session is on, in the least room that says it. Replaces the panel in a split, where
/// a panel per pane mostly repeats the same project and squeezes the terminals.
struct SessionStrip: View {
    @Environment(AppModel.self) private var model
    let session: TerminalSession
    let tier: Tier
    let openPanel: () -> Void

    private func questionLabel(_ snap: Snapshot, _ own: Snapshot.SessionFocus) -> String {
        let here = snap.questionGroups(focus: own).filter(\.isCurrent).reduce(0) { $0 + $1.questions.count }
        let all = snap.questionsForUser.count
        return here > 0 ? "\(here) for this goal" : (all == 1 ? "1 question" : "\(all) questions")
    }

    var body: some View {
        if let snap = model.state(for: session.projectID).snapshot, snap.initialized {
            let own = session.focus(in: snap)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Image(systemName: "scope").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(own.working == nil ? Theme.textTertiary : Theme.tint(tier)[0])
                    // With no task of its own, the goal is the project's and not what this session is on.
                    if own.working == nil { Text("Project goal").font(.system(size: 11)).foregroundStyle(Theme.textTertiary) }
                    Text(own.goal?.heading ?? "No goal yet")
                        .font(.system(size: 12.5, weight: own.working == nil ? .medium : .bold, design: .rounded))
                        .foregroundStyle(own.working == nil ? Theme.textSecondary : Theme.textPrimary).lineLimit(1)
                    if own.working != nil, let progress = own.goal?.progress, progress.total > 0 {
                        Text("\(progress.done)/\(progress.total)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textTertiary)
                    }
                    Spacer(minLength: 6)
                    if !snap.questionsForUser.isEmpty {
                        Button(action: openPanel) {
                            Label(questionLabel(snap, own), systemImage: "person.fill.questionmark")
                                .font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.violet)
                        }
                        .buttonStyle(.plain)
                        .help("Questions agents have for you. Opens the panel, where you can answer them.")
                    }
                }
                SessionStatusRow(status: session.status(in: snap), more: max(0, own.mine.count - 1), tier: tier)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color.white.opacity(0.02))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
        }
    }
}

/// The one answer to what this session is doing. Only real work moves; anything still is stopped.
struct SessionStatusRow: View {
    let status: Snapshot.SessionStatus
    var more = 0
    let tier: Tier

    private var symbol: (name: String, color: Color) {
        switch status.kind {
        case .working: return ("bolt.fill", Theme.tint(tier)[0])
        case .workingUnrecorded: return ("bolt.fill", Theme.amber)
        case .needsYou: return ("bell.fill", Theme.red)
        case .paused: return ("pause.fill", Theme.textSecondary)
        case .nothing: return ("moon.zzz.fill", Theme.textTertiary)
        case .ended: return ("powerplug.fill", Theme.textTertiary)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: symbol.name).font(.system(size: 10.5, weight: .bold)).foregroundStyle(symbol.color)
                Text(status.headline).font(.system(size: 11.5, weight: status.task == nil ? .semibold : .medium))
                    .foregroundStyle(status.task == nil ? symbol.color : Theme.textSecondary).fixedSize()
                if let task = status.task {
                    Text(task.heading).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if more > 0 { Text("+\(more)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textSecondary) }
            }
            if let detail = status.detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(Theme.textSecondary).lineLimit(1).help(detail)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(StatusSurface(kind: status.kind, tier: tier))
        .accessibilityElement(children: .combine)
    }
}

private struct StatusSurface: ViewModifier {
    let kind: Snapshot.SessionStatus.Kind
    let tier: Tier

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        switch kind {
        case .working: content.modifier(WorkingGlow(active: true, tier: tier))
        case .needsYou: content.background(Theme.red.opacity(0.14), in: shape).overlay(shape.strokeBorder(Theme.red.opacity(0.8), lineWidth: 1))
        case .workingUnrecorded: content.background(Theme.amber.opacity(0.1), in: shape).overlay(shape.strokeBorder(Theme.amber.opacity(0.6), lineWidth: 1))
        case .paused: content.background(Color.white.opacity(0.05), in: shape).overlay(shape.strokeBorder(Theme.hairline, lineWidth: 1))
        case .nothing, .ended: content
        }
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
