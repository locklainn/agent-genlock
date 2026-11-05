import AppKit
import GenlockCore
import SwiftUI

/// Goals, tasks and files to review for one project, live.
struct InspectorView: View {
    @Environment(AppModel.self) private var model
    let projectID: String

    private var tier: Tier { model.store.project(projectID)?.tier ?? .soon }

    var body: some View {
        let state = model.state(for: projectID)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = state.error {
                    Label(error.description, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.amber).textSelection(.enabled)
                }
                if let snap = state.snapshot {
                    if !snap.initialized {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Not on the signal yet").font(.system(size: 16, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                            Text("Set up genlock here to see goals and tasks live.").font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
                            Button("Set up genlock") { model.setupTarget = projectID }.buttonStyle(GlowButtonStyle())
                        }
                    } else {
                        content(snap, changed: state.recentlyChanged)
                    }
                } else if state.error == nil {
                    Waveform(level: 0.4, bars: 16, height: 18, colors: Theme.tint(tier))
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        .background(Color(hex: 0x0B0D16))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 1) }
    }

    @ViewBuilder private func content(_ s: Snapshot, changed: Set<String>) -> some View {
        let current = s.goal(s.currentGoal)
        let others = s.goals.filter { ($0.status == "active" || $0.status == "parked") && $0.id != s.currentGoal }
        let open = s.activeTickets.sorted { $0.updated > $1.updated }
        let reviews = s.openReviews

        if !reviews.isEmpty {
            InspectorCard(title: "To review", symbol: "doc.text.magnifyingglass", count: reviews.count, color: Theme.cyan) {
                ForEach(reviews) { ReviewRow(review: $0, projectID: projectID, root: s.root, changed: changed.contains($0.id)) }
            }
        }
        if !s.questionsForUser.isEmpty {
            InspectorCard(title: "Waiting on you", symbol: "person.fill.questionmark", count: s.questionsForUser.count, color: Theme.violet) {
                ForEach(s.questionsForUser) { q in
                    Text(q.text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true).livePulse(changed.contains(q.id))
                }
            }
        }
        InspectorCard(title: "Goal", symbol: "scope", color: Theme.tint(tier)[0]) {
            if let current {
                GoalBlock(goal: current, changed: changed, tier: tier)
            } else {
                Text(s.goalsDeclined == true ? "No goals for this project." : "No goal yet. The agent will ask.")
                    .font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
            }
        }
        InspectorCard(title: "Tasks", symbol: "bolt.fill", count: open.count, color: Theme.cyan) {
            if open.isEmpty {
                Text("No open tasks.").font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
            }
            ForEach(open) { TaskRow(ticket: $0, changed: changed.contains($0.id)) }
        }
        let stops = (current?.forbids ?? []) + open.flatMap(\.forbids)
        if !stops.isEmpty {
            InspectorCard(title: "Do not", symbol: "hand.raised.fill", color: Theme.red) {
                ForEach(stops.indices, id: \.self) { i in
                    Text(stops[i].text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        if !others.isEmpty {
            InspectorCard(title: "Other goals", symbol: "square.stack.3d.up.fill", count: others.count, color: Theme.textSecondary) {
                ForEach(others) { OtherGoal(goal: $0, changed: changed, tier: tier) }
            }
        }
        if !s.claims.isEmpty {
            InspectorCard(title: "Being worked on", symbol: "lock.fill", color: Theme.amber) {
                ForEach(s.claims) { c in
                    Text((c.paths + c.resources).joined(separator: ", "))
                        .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                }
            }
        }
    }
}

struct InspectorCard<Content: View>: View {
    let title: String
    let symbol: String
    let count: Int?
    let color: Color
    @ViewBuilder let content: Content

    init(title: String, symbol: String, count: Int? = nil, color: Color, @ViewBuilder content: () -> Content) {
        self.title = title
        self.symbol = symbol
        self.count = count
        self.color = color
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 10.5, weight: .bold)).foregroundStyle(color)
                Text(title.uppercased()).font(.system(size: 10.5, weight: .heavy)).tracking(0.9).foregroundStyle(Theme.textSecondary)
                Spacer()
                if let count {
                    Text("\(count)").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(color)
                        .contentTransition(.numericText())
                }
            }
            content
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(corner: 14)
    }
}

struct GoalBlock: View {
    let goal: Snapshot.Goal
    let changed: Set<String>
    let tier: Tier

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(goal.title).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if goal.progress.blocked > 0 {
                        Pill(text: "\(goal.progress.blocked) blocked", symbol: "exclamationmark.octagon.fill", color: Theme.red)
                    }
                    if let waiting = goal.waitingOn, !waiting.isEmpty {
                        Text("Waiting on: \(waiting)").font(.system(size: 11.5)).foregroundStyle(Theme.amber)
                    }
                }
                Spacer(minLength: 0)
                if goal.progress.total > 0 {
                    ProgressRing(done: goal.progress.done, total: goal.progress.total, colors: Theme.tint(tier), size: 40)
                }
            }
            .livePulse(changed.contains(goal.id))
            ForEach(goal.next) { n in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(n.n)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        .frame(width: 18, height: 18)
                        .background(n.n == 1 ? AnyShapeStyle(Theme.gradient(tier)) : AnyShapeStyle(Color.white.opacity(0.12)), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary.opacity(0.92))
                            .fixedSize(horizontal: false, vertical: true)
                        if let days = n.daysUntil {
                            let d = CardSummary.Deadline(text: n.text, daysUntil: days)
                            Text(d.label).font(.system(size: 11, weight: .semibold)).foregroundStyle(days <= 1 ? Theme.red : Theme.amber)
                        }
                    }
                }
                .livePulse(changed.contains("\(goal.id)/next/\(n.text)"))
            }
        }
    }
}

struct OtherGoal: View {
    let goal: Snapshot.Goal
    let changed: Set<String>
    let tier: Tier
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(goal.title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.textPrimary).multilineTextAlignment(.leading)
                    if goal.status == "parked" { Text("parked").font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary) }
                }
            }
            .buttonStyle(.plain)
            if expanded { GoalBlock(goal: goal, changed: changed, tier: tier).padding(.leading, 12) }
        }
    }
}

struct TaskRow: View {
    let ticket: Snapshot.Ticket
    let changed: Bool
    @State private var expanded = false

    var body: some View {
        let symbol = Theme.status(ticket.status)
        VStack(alignment: .leading, spacing: 5) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: symbol.name).foregroundStyle(symbol.color).font(.system(size: 13))
                        .shadow(color: ticket.status == "in_progress" ? symbol.color : .clear, radius: 5)
                        .accessibilityLabel(Status.label(ticket.status))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ticket.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        Text(ticket.summary == "none" ? "Requirements not written yet" : ticket.summary)
                            .font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows requirements")
            if let blocked = ticket.blockedReason {
                Text(blocked).font(.system(size: 11.5)).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true).padding(.leading, 20)
            }
            if let latest = ticket.latest {
                Text(latest.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 20)
            }
            ForEach(ticket.hazards.indices, id: \.self) { i in
                Label(ticket.hazards[i].what, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true).padding(.leading, 20)
            }
            if expanded {
                ForEach(ticket.requirements) { r in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: r.state == "met" ? "checkmark.square.fill" : r.state == "failed" ? "xmark.square.fill" : r.state == "waived" ? "minus.square" : "square")
                            .font(.system(size: 11)).foregroundStyle(r.state == "met" ? Theme.green : r.state == "failed" ? Theme.red : Theme.textTertiary)
                        Text(r.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.leading, 20)
            }
        }
        .livePulse(changed)
    }
}

struct ReviewRow: View {
    @Environment(AppModel.self) private var model
    let review: Snapshot.Review
    let projectID: String
    let root: String
    let changed: Bool
    @State private var hovering = false

    var body: some View {
        let exists = review.exists(root: root)
        HStack(alignment: .top, spacing: 8) {
            Button { model.open(review, in: projectID) } label: {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: review.isURL ? "globe" : "doc.text.fill").font(.system(size: 14))
                        .foregroundStyle(exists ? Theme.cyan : Theme.textTertiary)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(exists ? displayName : "\(displayName) (missing)")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(exists ? Theme.textPrimary : Theme.textTertiary)
                                .lineLimit(2).multilineTextAlignment(.leading)
                            if exists && hovering {
                                Image(systemName: "arrow.up.right").font(.system(size: 9.5, weight: .bold)).foregroundStyle(Theme.cyan)
                            }
                        }
                        Text(review.why).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!exists)
            .help(review.path)
            Button { model.markReviewed(review, in: projectID) } label: { Image(systemName: "checkmark.circle") }
                .buttonStyle(IconButtonStyle())
                .help("Mark as reviewed").accessibilityLabel("Mark \(review.path) as reviewed")
        }
        .padding(8)
        .background(hovering ? Theme.surfaceRaised : Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onHover { hovering = $0 }
        .livePulse(changed)
    }

    private var displayName: String {
        review.isURL ? review.path : URL(fileURLWithPath: review.path).lastPathComponent
    }
}

extension View {
    /// Points at something that just changed, then fades.
    func livePulse(_ on: Bool) -> some View {
        padding(on ? 4 : 0)
            .background(on ? Theme.cyan.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                if on { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.cyan.opacity(0.7), lineWidth: 1) }
            }
            .shadow(color: on ? Theme.cyan.opacity(0.5) : .clear, radius: 8)
    }
}
