import GenlockCore
import SwiftUI

/// What a pane shows. CLI is the session's terminal; Tasks is only its goal and tasks, so a grid
/// of sessions reads as what is being worked on, without the agents' prose.
enum PaneMode: String, CaseIterable {
    case cli, tasks
    var label: String { self == .cli ? "CLI" : "Tasks" }
    var symbol: String { self == .cli ? "terminal" : "checklist.checked" }
}

/// The CLI | Tasks switch in the top bar.
struct PaneModeToggle: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Picker("Pane mode", selection: $model.paneMode) {
            ForEach(PaneMode.allCases, id: \.self) { mode in
                Label(mode.label, systemImage: mode.symbol).tag(mode)
            }
        }
        .pickerStyle(.segmented).labelsHidden().fixedSize()
        .help("CLI shows each session's terminal. Tasks shows only the goal and task each is on, and its latest updates. ⌘T switches.")
        .accessibilityLabel("Show terminals or tasks")
    }
}

/// One session in Tasks mode: the goal its work serves, then each task it holds with its proof
/// progress and recent moves. Nothing the agent said, only what the records say.
struct TaskPaneView: View {
    @Environment(AppModel.self) private var model
    let session: TerminalSession
    let tier: Tier

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let snap = model.state(for: session.projectID).snapshot, snap.initialized {
                    let found = session.focus(in: snap)
                    if let goal = snap.goal(found.working?.goal) { GoalLine(goal: goal, tier: tier) }
                    if found.mine.isEmpty {
                        Text("No task recorded").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.amber)
                        if let last = found.lastFinished {
                            Text("Last finished").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Theme.textTertiary)
                            TaskCard(task: last, tier: tier, events: 2)
                        }
                    } else {
                        ForEach(found.mine.prefix(3)) { TaskCard(task: $0, tier: tier, events: 4) }
                        if found.mine.count > 3 {
                            Text("+\(found.mine.count - 3) more").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textTertiary)
                        }
                    }
                } else {
                    Text("No goals or tasks in this project yet").foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: Theme.terminal))
    }
}

/// Several projects at once, or one: each active goal, and under it the tasks open on it. What the
/// Assistant's pane shows in Tasks mode, since it works across them.
struct TaskBoardView: View {
    @Environment(AppModel.self) private var model
    /// Nil for every project.
    let projectID: String?

    private var projects: [Project] {
        model.store.projects.filter { $0.exists && (projectID == nil || $0.id == projectID) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(projects) { project in
                    if let snap = model.state(for: project.id).snapshot, snap.initialized, !snap.activeTickets.isEmpty || projectID != nil {
                        ProjectTasks(project: project, snap: snap, showName: projectID == nil)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: Theme.terminal))
    }
}

private struct ProjectTasks: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let snap: Snapshot
    let showName: Bool

    /// Who is on a task: the tab of the open session whose agent owns it.
    private func holder(_ task: Snapshot.Ticket) -> String? {
        guard let owner = task.owner else { return nil }
        return model.sessions.first { $0.value.projectID == project.id && $0.value.agents.contains(owner) }.map { model.tabLabel($0.key) }
    }

    var body: some View {
        let goals = snap.goals.filter { $0.status == "active" }.sorted { ($0.rank ?? .max) < ($1.rank ?? .max) }
        let order = ["in_progress": 0, "blocked": 1, "open": 2]
        let tasks = snap.rankedTasks.sorted { (order[$0.status] ?? 3, $0.rank ?? .max) < (order[$1.status] ?? 3, $1.rank ?? .max) }
        let loose = tasks.filter { (t: Snapshot.Ticket) -> Bool in !goals.contains { (g: Snapshot.Goal) -> Bool in g.id == t.goal } }
        VStack(alignment: .leading, spacing: 10) {
            if showName {
                HStack(spacing: 8) {
                    ProjectIconView(project: project, size: 18)
                    Text(project.name).font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(Theme.gradient(project.tier))
                }
            }
            ForEach(goals, id: \.id) { (goal: Snapshot.Goal) in
                let mine = tasks.filter { (t: Snapshot.Ticket) -> Bool in t.goal == goal.id }
                if !mine.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        GoalLine(goal: goal, tier: project.tier)
                        ForEach(mine) { BoardTaskRow(task: $0, holder: holder($0)) }
                    }
                }
            }
            if !loose.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No goal").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textTertiary)
                    ForEach(loose) { BoardTaskRow(task: $0, holder: holder($0)) }
                }
            }
            if tasks.isEmpty { Text("No open tasks").font(.system(size: 12)).foregroundStyle(Theme.textTertiary) }
        }
    }
}

/// A goal as a heading: its name and how many of its tasks are done.
private struct GoalLine: View {
    let goal: Snapshot.Goal
    let tier: Tier

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "scope").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.tint(tier)[0])
            Text(goal.heading).font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary).lineLimit(2)
            if goal.progress.total > 0 {
                Text("\(goal.progress.done)/\(goal.progress.total)").font(.system(size: 11, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(Theme.textTertiary).fixedSize()
            }
        }
        .help(goal.title)
    }
}

/// One task in full: status, title, proof progress, and its last few moves.
private struct TaskCard: View {
    let task: Snapshot.Ticket
    let tier: Tier
    let events: Int

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                StatusMark(status: task.status)
                Text(task.heading).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
            }
            ProofDots(requirements: task.requirements, summary: task.summary)
            if let reason = task.blockedReason {
                Text("Blocked: \(reason)").font(.system(size: 11.5)).foregroundStyle(Theme.red).lineLimit(3)
            }
            let feed = (task.recent ?? []).prefix(events)
            if feed.isEmpty, let latest = task.latest {
                EventRow(kind: "update", text: latest.text, at: latest.at)
            } else {
                ForEach(Array(feed.enumerated()), id: \.offset) { _, e in EventRow(kind: e.kind, text: e.text, at: e.at) }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04), in: shape)
        .overlay(shape.strokeBorder(task.status == "in_progress" ? Theme.tint(tier)[0].opacity(0.5) : Theme.hairline, lineWidth: 1))
    }
}

/// One task on the board: one line of status and name, one of who and how far, one of its latest.
private struct BoardTaskRow: View {
    let task: Snapshot.Ticket
    let holder: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                StatusMark(status: task.status)
                Text(task.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                Spacer(minLength: 6)
                if let holder {
                    Label(holder, systemImage: "terminal").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.cyan).lineLimit(1)
                }
                Text(task.summary).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.textTertiary).lineLimit(1).fixedSize()
            }
            if let latest = task.latest {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(latest.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                    if let d = ISODate.parse(latest.at) { Text(ISODate.age(d)).font(.system(size: 10)).foregroundStyle(Theme.textTertiary).fixedSize() }
                }
                .padding(.leading, 18)
            }
        }
        .help(task.title)
    }
}

private struct StatusMark: View {
    let status: String
    var body: some View {
        let s = Theme.status(status)
        Image(systemName: s.name).font(.system(size: 11, weight: .bold)).foregroundStyle(s.color)
            .help(status.replacingOccurrences(of: "_", with: " "))
    }
}

/// One dot per requirement: green proved, red failed, amber waived, hollow still open.
private struct ProofDots: View {
    let requirements: [Snapshot.Requirement]
    let summary: String

    var body: some View {
        HStack(spacing: 4) {
            ForEach(requirements) { r in
                Circle()
                    .fill(r.state == "met" ? Theme.green : r.state == "failed" ? Theme.red : r.state == "waived" ? Theme.amber : .clear)
                    .overlay(Circle().strokeBorder(r.state == "open" ? Theme.textTertiary : .clear, lineWidth: 1))
                    .frame(width: 7, height: 7)
                    .help("\(r.n). \(r.text)")
            }
            Text(summary).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.textTertiary).padding(.leading, 2)
        }
    }
}

/// One move on a task: a coloured tag for what happened, what, and how long ago.
private struct EventRow: View {
    let kind: String
    let text: String
    let at: String

    private var color: Color {
        switch kind {
        case "proved", "done": return Theme.green
        case "failed", "blocked": return Theme.red
        case "waived", "handed off": return Theme.amber
        case "started", "opened": return Theme.cyan
        default: return Theme.violet
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(kind).font(.system(size: 9.5, weight: .bold)).textCase(.uppercase).foregroundStyle(color)
                .frame(width: 62, alignment: .leading)
            Text(text.isEmpty ? "–" : text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let d = ISODate.parse(at) { Text(ISODate.age(d)).font(.system(size: 10)).foregroundStyle(Theme.textTertiary).fixedSize() }
        }
    }
}
