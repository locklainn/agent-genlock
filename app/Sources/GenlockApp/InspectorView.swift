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
                            Text("Set up Genlock here to see goals and tasks live.").font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
                            Button("Set up Genlock") { model.setupTarget = projectID }.buttonStyle(GlassButtonStyle(active: true))
                        }
                    } else {
                        content(snap, changed: state.recentlyChanged)
                    }
                } else if state.error == nil {
                    WorkingIndicator(label: "Loading")
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
        let others = s.rankedGoals.filter { ($0.status == "active" || $0.status == "parked") && $0.id != s.currentGoal }
        let focus = s.taskFocus()
        let open = s.rankedTasks
        let reviews = s.openReviews

        if !reviews.isEmpty {
            InspectorCard(title: "To review", symbol: "doc.text.magnifyingglass", count: reviews.count, color: Theme.cyan) {
                ForEach(reviews) { ReviewRow(review: $0, projectID: projectID, root: s.root, changed: changed.contains($0.id)) }
            }
        }
        if !s.questionsForUser.isEmpty {
            InspectorCard(title: "Waiting on you", symbol: "person.fill.questionmark", count: s.questionsForUser.count, color: Theme.violet) {
                WaitingList(questions: s.questionsForUser, changed: changed)
            }
        }
        InspectorCard(title: "Goal", symbol: "scope", color: Theme.tint(tier)[0]) {
            if let current {
                RankedRow(id: current.id, title: current.title, rank: current.rank, due: current.due, daysUntil: current.daysUntil, projectID: projectID) {
                    GoalBlock(goal: current, changed: changed, tier: tier)
                }
            } else {
                Text(s.goalsDeclined == true ? "No goals for this project." : "None yet. Claude will pick one up as you work.")
                    .font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
            }
        }
        InspectorCard(title: "Now", symbol: "bolt.fill", count: focus.active.isEmpty ? nil : focus.active.count, color: Theme.cyan) {
            if focus.active.isEmpty && focus.justFinished.isEmpty {
                Text(open.isEmpty ? "Nothing going on." : "Nothing going on right now.").font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
            }
            ForEach(focus.active) { t in
                RankedRow(id: t.id, title: t.title, rank: t.rank, due: t.due, daysUntil: t.daysUntil, projectID: projectID) {
                    TaskRow(ticket: t, changed: changed.contains(t.id))
                }
            }
            ForEach(focus.justFinished) { TaskRow(ticket: $0, changed: changed.contains($0.id)) }
        }
        let stops = (current?.forbids ?? []) + open.flatMap(\.forbids)
        if !stops.isEmpty {
            InspectorCard(title: "Do not", symbol: "hand.raised.fill", color: Theme.red) {
                ForEach(stops.indices, id: \.self) { i in
                    Text(stops[i].text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                }
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
        if !focus.backlog.isEmpty || !others.isEmpty {
            BacklogCard(tasks: focus.backlog, goals: others, changed: changed, tier: tier, projectID: projectID)
        }
    }
}

/// A goal or task with its place in the order. Drag the handle onto another of its kind to take
/// that place. The order itself lives in `genlock rank`, shared with every agent.
struct RankedRow<Content: View>: View {
    @Environment(AppModel.self) private var model
    let id: String
    let title: String
    let rank: Int?
    let due: String?
    let daysUntil: Int?
    let projectID: String
    @ViewBuilder let content: Content
    @State private var targeted = false

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            if let rank {
                VStack(spacing: 3) {
                    Text("\(rank)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(Theme.textSecondary)
                    Image(systemName: "line.3.horizontal").font(.system(size: 9)).foregroundStyle(Theme.textTertiary)
                }
                .frame(width: 16)
                .padding(.vertical, 2)
                .contentShape(Rectangle())
                .draggable(id) { Text(title).font(.system(size: 12.5, weight: .semibold)).padding(8).background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8)) }
                .help("Drag to change its rank")
                .accessibilityLabel("Rank \(rank)")
            }
            VStack(alignment: .leading, spacing: 4) {
                content
                DueControl(id: id, due: due, daysUntil: daysUntil, projectID: projectID)
            }
            Spacer(minLength: 0)
        }
        .overlay(alignment: .top) {
            if targeted { Rectangle().fill(Theme.cyan).frame(height: 2).offset(y: -4) }
        }
        .dropDestination(for: String.self) { items, _ in
            guard let moved = items.first, let rank, moved != id, moved.prefix(2) == id.prefix(2) else { return false }
            model.rank(moved, to: rank, in: projectID)
            return true
        } isTargeted: { targeted = $0 }
    }
}

/// Shows a due date and changes it, in place.
struct DueControl: View {
    @Environment(AppModel.self) private var model
    let id: String
    let due: String?
    let daysUntil: Int?
    let projectID: String
    @State private var picking = false
    @State private var day = Date()

    private static let format: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    var body: some View {
        Button {
            day = due.flatMap { Self.format.date(from: $0) } ?? Date()
            picking = true
        } label: {
            if let days = daysUntil {
                Label(CardSummary.Deadline(text: "", daysUntil: days).label, systemImage: "calendar")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(days <= 1 ? Theme.red : Theme.amber)
            } else {
                Label("Add due date", systemImage: "calendar").font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary)
            }
        }
        .buttonStyle(.plain)
        .help(due ?? "Set a due date")
        .popover(isPresented: $picking) {
            VStack(alignment: .leading, spacing: 10) {
                DatePicker("Due", selection: $day, displayedComponents: .date).datePickerStyle(.graphical).labelsHidden()
                HStack {
                    if due != nil {
                        Button("Remove") { model.setDue(id, to: nil, in: projectID); picking = false }.buttonStyle(GlassButtonStyle())
                    }
                    Spacer()
                    Button("Set") { model.setDue(id, to: Self.format.string(from: day), in: projectID); picking = false }
                        .buttonStyle(GlassButtonStyle(active: true))
                }
            }
            .padding(14)
        }
    }
}

/// Everything not going on right now, a click away so it does not bury what is.
struct BacklogCard: View {
    let tasks: [Snapshot.Ticket]
    let goals: [Snapshot.Goal]
    let changed: Set<String>
    let tier: Tier
    let projectID: String
    @State private var expanded = false

    private var summary: String {
        var parts: [String] = []
        if !tasks.isEmpty { parts.append(tasks.count == 1 ? "1 task" : "\(tasks.count) tasks") }
        if !goals.isEmpty { parts.append(goals.count == 1 ? "1 other goal" : "\(goals.count) other goals") }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        InspectorCard(title: "Backlog", symbol: "tray.full.fill", color: Theme.textSecondary) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(summary).font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Backlog: \(summary)")
            if expanded {
                ForEach(tasks) { t in
                    RankedRow(id: t.id, title: t.title, rank: t.rank, due: t.due, daysUntil: t.daysUntil, projectID: projectID) {
                        TaskRow(ticket: t, changed: changed.contains(t.id))
                    }
                }
                ForEach(goals) { g in
                    RankedRow(id: g.id, title: g.title, rank: g.rank, due: g.due, daysUntil: g.daysUntil, projectID: projectID) {
                        OtherGoal(goal: g, changed: changed, tier: tier)
                    }
                }
            }
        }
    }
}

/// Questions only you can answer, short until you ask for all of it.
struct WaitingList: View {
    let questions: [Snapshot.Question]
    let changed: Set<String>
    @State private var expanded = false
    private static let shown = 2

    var body: some View {
        let visible = expanded ? questions : Array(questions.prefix(Self.shown))
        ForEach(visible) { q in
            Text(q.text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary)
                .lineLimit(expanded ? nil : 2)
                .fixedSize(horizontal: false, vertical: true).livePulse(changed.contains(q.id))
        }
        if questions.count > Self.shown || expanded {
            Button(expanded ? "Show less" : "Show all \(questions.count)") { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } }
                .buttonStyle(LinkButtonStyle())
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
