import GenlockCore
import SwiftUI

extension TerminalSession {
    /// The ids its agent has gone by, which is how a task says whose it is.
    var agents: Set<String> { Set([conversation, spawn?.session].compactMap { $0 }) }

    func focus(in snapshot: Snapshot) -> Snapshot.SessionFocus {
        snapshot.sessionFocus(agents: agents, ticket: spawn?.ticket)
    }

    func status(in snapshot: Snapshot) -> Snapshot.SessionStatus {
        Snapshot.sessionStatus(phase: phase, isRunning: isRunning, message: attentionMessage, focus: focus(in: snapshot), wait: wait)
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
        let here = questionCount(snap, own)
        return here == 1 ? "1 question" : "\(here) questions"
    }

    /// Only questions about this session's own task or the goal it serves.
    private func questionCount(_ snap: Snapshot, _ own: Snapshot.SessionFocus) -> Int {
        snap.questionGroups(focus: own).filter(\.isCurrent).reduce(0) { $0 + $1.questions.count }
    }

    var body: some View {
        if let snap = model.state(for: session.projectID).snapshot, snap.initialized {
            let found = session.focus(in: snap)
            // Only the goal its own task serves: with no task, nothing project-wide stands in.
            let own = Snapshot.SessionFocus(goal: snap.goal(found.working?.goal), mine: found.mine, lastFinished: found.lastFinished)
            // One line: what it is doing first, the goal it serves after. The detail is in the tooltip.
            HStack(spacing: 8) {
                SessionStatusRow(status: session.status(in: snap), more: max(0, own.mine.count - 1), tier: tier, compact: true, wait: session.wait)
                    .layoutPriority(1)
                if let goal = own.goal {
                    HStack(spacing: 4) {
                        Image(systemName: "scope").font(.system(size: 9.5, weight: .bold)).foregroundStyle(Theme.tint(tier)[0])
                        Text(goal.heading).font(.system(size: 11.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        if goal.progress.total > 0 {
                            Text("\(goal.progress.done)/\(goal.progress.total)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textTertiary).fixedSize()
                        }
                    }
                    .help("Goal: \(goal.heading)")
                }
                if questionCount(snap, own) > 0 {
                    Button(action: openPanel) {
                        Label(questionLabel(snap, own), systemImage: "person.fill.questionmark")
                            .font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.violet).lineLimit(1).fixedSize()
                    }
                    .buttonStyle(.plain)
                    .help("Questions agents have for you. Opens the panel, where you can answer them.")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
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
    /// One line, the detail only in the tooltip: for a pane in a grid.
    var compact = false
    /// The wait itself, when known, so the row can say how long it has run.
    var wait: SessionWait? = nil

    private var symbol: (name: String, color: Color) {
        switch status.kind {
        case .working: return ("bolt.fill", Theme.tint(tier)[0])
        case .workingUnrecorded: return ("bolt.fill", Theme.amber)
        case .needsYou: return ("bell.fill", Theme.red)
        case .waitingOn: let st = status.waitState ?? .running; return (st.symbol, st.color)
        case .paused: return ("pause.fill", Theme.textSecondary)
        case .untracked: return ("exclamationmark.triangle.fill", Theme.amber)
        case .waitingForWork: return ("hourglass", Theme.textTertiary)
        case .ended: return ("powerplug.fill", Theme.textTertiary)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if status.kind == .waitingOn {
                    WaitGlyph(state: status.waitState ?? .running, size: 10.5)
                    // What it is on is the news here, so it reads in its state's color and may truncate.
                    Text(status.headline).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(symbol.color)
                        .lineLimit(1).truncationMode(.tail)
                    if let wait {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(wait.elapsed(now: context.date)).font(.system(size: 11, weight: .semibold)).monospacedDigit()
                                .foregroundStyle(symbol.color.opacity(0.75)).fixedSize()
                        }
                    }
                } else {
                    Image(systemName: symbol.name).font(.system(size: 10.5, weight: .bold)).foregroundStyle(symbol.color)
                    Text(status.headline).font(.system(size: 11.5, weight: status.task == nil ? .semibold : .medium))
                        .foregroundStyle(status.task == nil ? symbol.color : Theme.textSecondary).fixedSize()
                }
                if let task = status.task {
                    Text(task.heading).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                }
                if !compact { Spacer(minLength: 4) }
                if more > 0 { Text("+\(more)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textSecondary) }
            }
            if !compact, let detail = status.detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(Theme.textSecondary).lineLimit(1).help(detail)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, compact ? 2 : 4)
        .frame(maxWidth: compact ? nil : .infinity, alignment: .leading)
        .help(compact ? (status.detail ?? "") : "")
        .modifier(StatusSurface(kind: status.kind, tier: tier, wait: status.waitState))
        .accessibilityElement(children: .combine)
    }
}

private struct StatusSurface: ViewModifier {
    let kind: Snapshot.SessionStatus.Kind
    let tier: Tier
    var wait: SessionWait.State? = nil

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        switch kind {
        case .working: content.modifier(WorkingGlow(active: true, tier: tier))
        case .needsYou: content.background(Theme.red.opacity(0.14), in: shape).overlay(shape.strokeBorder(Theme.red.opacity(0.8), lineWidth: 1))
        case .workingUnrecorded, .untracked: content.background(Theme.amber.opacity(0.1), in: shape).overlay(shape.strokeBorder(Theme.amber.opacity(0.6), lineWidth: 1))
        case .waitingOn:
            let st = wait ?? .running
            content.background(st.color.opacity(st.isWork ? 0.12 : 0.05), in: shape)
                .overlay(shape.strokeBorder(st.color.opacity(st.isWork ? 0.5 : 0.25), style: StrokeStyle(lineWidth: 1, dash: st.isWork ? [] : [3, 2])))
        case .paused: content.background(Color.white.opacity(0.05), in: shape).overlay(shape.strokeBorder(Theme.hairline, lineWidth: 1))
        case .waitingForWork, .ended: content
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
