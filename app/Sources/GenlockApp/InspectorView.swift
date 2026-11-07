import AppKit
import GenlockCore
import SwiftUI

/// Goals, tasks and files to review for one project, live.
struct InspectorView: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    /// The session it sits beside, whose work it puts first.
    var sessionKey: String?

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
        .safeAreaInset(edge: .bottom, spacing: 0) { footer(state.snapshot) }
        .background(Color(hex: 0x0B0D16))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 1) }
    }

    /// What this session's panel shows, so the way to the whole project counts only the rest.
    private func sessionScope(_ s: Snapshot, _ session: TerminalSession) -> (focus: Snapshot.SessionFocus, ids: Set<String>, reviews: [Snapshot.Review], questions: [Snapshot.QuestionGroup]) {
        let found = session.focus(in: s)
        // The goal its own task serves, never the project's goal standing in for one.
        let goal = s.goal(found.working?.goal)
        let own = Snapshot.SessionFocus(goal: goal, mine: found.mine, lastFinished: found.lastFinished)
        let ids = Set(own.mine.map(\.id) + [goal?.id].compactMap { $0 })
        return (own, ids, s.openReviews.filter { $0.about.map(ids.contains) == true }, s.questionGroups(focus: own).filter(\.isCurrent))
    }

    /// Pinned to the bottom of a session's panel, whatever the cards above are doing.
    @ViewBuilder private func footer(_ snap: Snapshot?) -> some View {
        if let s = snap, s.initialized, let session = sessionKey.flatMap({ model.sessions[$0] }) {
            let scope = sessionScope(s, session)
            WholeProjectButton(projectID: projectID, sessionKey: sessionKey, snapshot: s, shownHere: scope.ids,
                               shownQuestions: scope.questions.reduce(0) { $0 + $1.questions.count }, shownReviews: scope.reviews.count)
                .padding(12)
                .background(Color(hex: 0x0B0D16))
                .overlay(alignment: .top) { Rectangle().fill(Theme.hairline).frame(height: 1) }
        }
    }

    @ViewBuilder private func content(_ s: Snapshot, changed: Set<String>) -> some View {
        if let session = sessionKey.flatMap({ model.sessions[$0] }) {
            sessionContent(s, session: session, changed: changed)
        } else {
            projectContent(s, changed: changed)
        }
    }

    /// Only what this session's agent is on. Everything project-wide is behind Whole project.
    @ViewBuilder private func sessionContent(_ s: Snapshot, session: TerminalSession, changed: Set<String>) -> some View {
        let scope = sessionScope(s, session)
        let own = scope.focus, goal = own.goal, reviews = scope.reviews, questions = scope.questions
        let stops = (goal?.forbids ?? []) + own.mine.flatMap(\.forbids)

        let status = session.status(in: s)
        // The status row already names the task it is on; list only the others it holds.
        let rest = status.task == nil ? own.mine : Array(own.mine.dropFirst())
        InspectorCard(title: "This session", symbol: "bolt.fill", count: own.mine.count > 1 ? own.mine.count : nil, color: Theme.tint(tier)[0]) {
            SessionStatusRow(status: status, tier: tier)
            ForEach(rest) { t in
                RankedRow(id: t.id, title: t.title, rank: t.rank, due: t.due, daysUntil: t.daysUntil, projectID: projectID) {
                    TaskRow(ticket: t, changed: changed.contains(t.id))
                }
            }
        }
        if let goal {
            InspectorCard(title: "Goal", symbol: "scope", color: Theme.tint(tier)[0]) {
                RankedRow(id: goal.id, title: goal.title, rank: goal.rank, due: goal.due, daysUntil: goal.daysUntil, projectID: projectID) {
                    GoalBlock(goal: goal, projectID: projectID, changed: changed, tier: tier)
                }
            }
        }
        if !questions.isEmpty {
            QuestionsCard(groups: questions, session: session, projectID: projectID, changed: changed)
        }
        if !reviews.isEmpty {
            InspectorCard(title: "To review", symbol: "doc.text.magnifyingglass", count: reviews.count, color: Theme.cyan) {
                ForEach(reviews) { ReviewRow(review: $0, projectID: projectID, root: s.root, changed: changed.contains($0.id)) }
            }
        }
        if !stops.isEmpty {
            InspectorCard(title: "Do not", symbol: "hand.raised.fill", color: Theme.red) {
                ForEach(stops.indices, id: \.self) { i in
                    Text(stops[i].text).font(.system(size: 12.5)).foregroundStyle(Theme.textPrimary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Everything in the project: its goals, all open work, every question and review, and what is held.
    @ViewBuilder private func projectContent(_ s: Snapshot, changed: Set<String>) -> some View {
        let own = Snapshot.SessionFocus(goal: s.goal(s.currentGoal), mine: [])
        let current = own.goal
        let others = s.rankedGoals.filter { ($0.status == "active" || $0.status == "parked") && $0.id != current?.id }
        let focus = s.taskFocus()
        let open = s.rankedTasks
        let reviews = s.openReviews

        InspectorCard(title: "Goal", symbol: "scope", color: Theme.tint(tier)[0]) {
            if let current {
                RankedRow(id: current.id, title: current.title, rank: current.rank, due: current.due, daysUntil: current.daysUntil, projectID: projectID) {
                    GoalBlock(goal: current, projectID: projectID, changed: changed, tier: tier)
                }
            } else {
                Text(s.goalsDeclined == true ? "No goals for this project." : "None yet. Claude will pick one up as you work.")
                    .font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
            }
        }
        if !s.questionsForUser.isEmpty {
            QuestionsCard(groups: s.questionGroups(focus: own), session: nil, projectID: projectID, changed: changed)
        }
        if !reviews.isEmpty {
            InspectorCard(title: "To review", symbol: "doc.text.magnifyingglass", count: reviews.count, color: Theme.cyan) {
                ForEach(reviews) { ReviewRow(review: $0, projectID: projectID, root: s.root, changed: changed.contains($0.id)) }
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
        if !s.completedGoals.isEmpty {
            CompletedCard(goals: s.completedGoals, projectID: projectID)
        }
    }
}

/// The way from one session to the rest of its project, saying what is waiting there.
struct WholeProjectButton: View {
    let projectID: String
    /// The session whose panel this is, which picks are typed into.
    var sessionKey: String?
    let snapshot: Snapshot
    /// Tasks and goals already in the session panel, so the count is only what is elsewhere.
    let shownHere: Set<String>
    let shownQuestions: Int
    let shownReviews: Int
    @State private var showing = false

    private var summary: String? {
        let s = snapshot
        var parts: [String] = []
        let tasks = s.rankedTasks.filter { !shownHere.contains($0.id) }.count
        let questions = s.questionsForUser.count - shownQuestions
        let reviews = s.openReviews.count - shownReviews
        if questions > 0 { parts.append(questions == 1 ? "1 question" : "\(questions) questions") }
        if reviews > 0 { parts.append("\(reviews) to review") }
        if tasks > 0 { parts.append(tasks == 1 ? "1 other task" : "\(tasks) other tasks") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        Button { showing = true } label: {
            HStack(spacing: 7) {
                Image(systemName: "square.stack.3d.up").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Whole project").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                    if let summary { Text(summary).font(.system(size: 11)).foregroundStyle(Theme.textSecondary).lineLimit(1) }
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 9.5, weight: .bold)).foregroundStyle(Theme.textTertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Everything in this project beyond this session: its goals, other work, every question and review, backlog and completed goals")
        .wholeProjectSheet(projectID: projectID, session: sessionKey, isPresented: $showing)
    }
}

/// Everything project-wide, in a sheet: the panel with no session to narrow it.
struct WholeProjectView: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    /// Where picked tasks and goals are typed. Nil from the dashboard: the session shown last.
    var session: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let project = model.store.project(projectID) { ProjectIconView(project: project, size: 22) }
                Text(model.store.project(projectID)?.name ?? "Project").font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                Text("Whole project").font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary)
                Spacer()
                Label("Shift-click for several", systemImage: "text.badge.plus")
                    .font(.system(size: 11)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                Button("Done") { dismiss() }.buttonStyle(GlassButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(12)
            .background(Color(hex: 0x0B0D16))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
            InspectorView(projectID: projectID, sessionKey: nil)
                .environment(\.promptPicking, PickContext(project: projectID, session: session))
        }
        // Once picks are typed, the prompt is where you carry on.
        .onChange(of: model.picksTyped) { dismiss() }
        .frame(minWidth: 420, idealWidth: 460, minHeight: 480, idealHeight: 640)
    }
}

extension View {
    func wholeProjectSheet(projectID: String, session: String? = nil, isPresented: Binding<Bool>) -> some View {
        modifier(WholeProjectSheet(projectID: projectID, session: session, isPresented: isPresented))
    }
}

private struct WholeProjectSheet: ViewModifier {
    @Environment(AppModel.self) private var model
    let projectID: String
    var session: String?
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content.sheet(isPresented: $isPresented) { WholeProjectView(projectID: projectID, session: session).environment(model) }
    }
}

/// A goal or task with its place in the order. Drag the handle onto another of its kind to take
/// that place. The order itself lives in `genlock rank`, shared with every agent.
/// Where a pick from Whole project is typed. Absent everywhere else, so rows there have no pick button.
struct PickContext: Equatable {
    var project: String
    var session: String?
}

extension EnvironmentValues {
    @Entry var promptPicking: PickContext? = nil
}

/// Types a task or goal into the prompt; Shift-click several and they go in together when Shift comes up.
struct PickButton: View {
    @Environment(AppModel.self) private var model
    let pick: PromptPick
    let context: PickContext
    @State private var hovering = false

    var body: some View {
        let order = model.pickOrder(pick)
        Button { model.clickPick(pick, project: context.project, session: context.session) } label: {
            Group {
                if let order {
                    Text("\(order)").font(.system(size: 10.5, weight: .bold, design: .rounded)).foregroundStyle(.black)
                        .frame(width: 18, height: 18).background(Theme.cyan, in: Circle())
                } else {
                    Image(systemName: "text.badge.plus").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(hovering ? Theme.textPrimary : Theme.textTertiary)
                }
            }
            .frame(width: 24, height: 22).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Type into the prompt as \(PromptPicks.text(for: [pick]).trimmingCharacters(in: .whitespaces)). Shift-click to pick several")
        .accessibilityLabel(order.map { "Picked \($0)" } ?? "Add to prompt")
    }
}

struct RankedRow<Content: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.promptPicking) private var picking
    let id: String
    let title: String
    let rank: Int?
    let due: String?
    let daysUntil: Int?
    let projectID: String
    @ViewBuilder let content: Content
    @State private var targeted = false
    @State private var hovering = false

    /// Open tasks and goals only: there is nothing to ask an agent to do about a finished one.
    private var pick: PromptPick? {
        let snap = model.state(for: projectID).snapshot
        if id.hasPrefix("G-"), let g = snap?.goal(id), ["active", "parked", "proposed"].contains(g.status) { return PromptPick(kind: .goal, id: id, short: g.short) }
        if id.hasPrefix("T-"), let t = snap?.ticket(id), !["done", "abandoned"].contains(t.status) { return PromptPick(kind: .task, id: id, short: t.short) }
        return nil
    }

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
                DueControl(id: id, due: due, daysUntil: daysUntil, projectID: projectID, offerAdding: hovering)
            }
            Spacer(minLength: 0)
            if let picking, let pick { PickButton(pick: pick, context: picking) }
        }
        .onHover { hovering = $0 }
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
    /// Without a date this stays out of the way until the row is hovered.
    var offerAdding = true
    @State private var picking = false
    @State private var day = Date()

    private static let format: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    @ViewBuilder var body: some View {
        if due != nil || offerAdding || picking { control }
    }

    private var control: some View {
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
                        OtherGoal(goal: g, projectID: projectID, changed: changed, tier: tier)
                    }
                }
            }
        }
    }
}

/// Questions only you can answer, by what they are about. What this session is on comes first,
/// open. Everything else is one row per goal until you want it.
struct QuestionsCard: View {
    let groups: [Snapshot.QuestionGroup]
    let session: TerminalSession?
    let projectID: String
    let changed: Set<String>

    var body: some View {
        InspectorCard(title: "Questions for you", symbol: "person.fill.questionmark", count: groups.reduce(0) { $0 + $1.questions.count }, color: Theme.violet) {
            ForEach(groups) { QuestionGroupRow(group: $0, session: session, projectID: projectID, changed: changed) }
        }
    }
}

struct QuestionGroupRow: View {
    let group: Snapshot.QuestionGroup
    let session: TerminalSession?
    let projectID: String
    let changed: Set<String>
    @State private var expanded: Bool?

    private var isOpen: Bool { expanded ?? group.isCurrent }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded = !isOpen } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(group.label).font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(group.isCurrent ? Theme.textPrimary : Theme.textSecondary).lineLimit(1)
                    if group.isCurrent { Text("this goal").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.violet) }
                    Spacer(minLength: 4)
                    Text("\(group.questions.count)").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(Theme.violet)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(group.label): \(group.questions.count) questions")
            if isOpen {
                ForEach(group.questions) { QuestionRow(question: $0, session: session, projectID: projectID, changed: changed.contains($0.id)) }
            }
        }
    }
}

/// One question and what you can do about it: answer it here, or talk it through with the agent.
struct QuestionRow: View {
    @Environment(AppModel.self) private var model
    let question: Snapshot.Question
    let session: TerminalSession?
    let projectID: String
    let changed: Bool
    @State private var answering = false
    @State private var answer = ""
    @State private var expanded = Driver.expandQuestions
    @FocusState private var typing: Bool

    private func send() {
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.answerQuestion(question, text, in: projectID)
        answering = false
        answer = ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            // Selectable text ignores a line limit once clicked and draws over what follows, so
            // only text already shown whole can be selected.
            if expanded || answering {
                Text(question.text).font(.system(size: 12)).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if expanded && !answering {
                    Button("Show less") { withAnimation(.spring(duration: 0.28)) { expanded = false } }.buttonStyle(LinkButtonStyle())
                }
            } else {
                Text(question.text).font(.system(size: 12)).foregroundStyle(Theme.textPrimary)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.spring(duration: 0.28)) { expanded = true } }
                    .help("Show the whole question")
            }
            if answering {
                TextField("Your answer", text: $answer, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(1...5).focused($typing).onSubmit(send)
                    .onAppear { typing = true }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    Button("Cancel") { answering = false }.buttonStyle(GlassButtonStyle())
                    Button("Send answer", action: send).buttonStyle(GlowButtonStyle())
                        .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                HStack(spacing: 8) {
                    Button("Answer") { answering = true }.buttonStyle(GlassButtonStyle(active: true))
                    if let session, session.isRunning {
                        Button("Ask agent") { model.discuss(question, with: session) }.buttonStyle(GlassButtonStyle())
                            .help("Puts this question to the agent in this session, so you can talk it through.")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .livePulse(changed)
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

/// A goal at a glance: its name and what is next. Everything else is a click away.
struct GoalBlock: View {
    let goal: Snapshot.Goal
    let projectID: String
    let changed: Set<String>
    let tier: Tier
    @State private var expanded = false

    private var heading: String { goal.heading }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(heading).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.leading).lineLimit(2)
                        if !expanded, let next = goal.next.first {
                            Text(next.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if goal.progress.total > 0 {
                        ProgressRing(done: goal.progress.done, total: goal.progress.total, colors: Theme.tint(tier), size: 34)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? "Show less" : "Show details")
            .accessibilityHint(expanded ? "Shows less" : "Shows details")
            .livePulse(changed.contains(goal.id) || goal.next.contains { changed.contains("\(goal.id)/next/\($0.text)") })
            if goal.progress.blocked > 0 {
                Pill(text: "\(goal.progress.blocked) blocked", symbol: "exclamationmark.octagon.fill", color: Theme.red)
            }
            if expanded {
                GoalDetail(goal: goal, changed: changed, tier: tier)
                CompleteGoalButton(goal: goal, projectID: projectID)
            } else if GoalCompletion.looksReached(goal) {
                CompleteGoalButton(goal: goal, projectID: projectID)
            }
        }
    }
}

/// The full wording of a goal and everything next on it.
struct GoalDetail: View {
    let goal: Snapshot.Goal
    let changed: Set<String>
    let tier: Tier

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if goal.heading != goal.title {
                Text(goal.title).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            if let waiting = goal.waitingOn, !waiting.isEmpty {
                Text("Waiting on: \(waiting)").font(.system(size: 11.5)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(goal.next) { n in
                HStack(alignment: .top, spacing: 7) {
                    Text("\(n.n)").font(.system(size: 9.5, weight: .bold, design: .rounded)).foregroundStyle(.white)
                        .frame(width: 15, height: 15)
                        .background(n.n == 1 ? AnyShapeStyle(Theme.gradient(tier)) : AnyShapeStyle(Color.white.opacity(0.12)), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let days = n.daysUntil {
                            let d = CardSummary.Deadline(text: n.text, daysUntil: days)
                            Text(d.label).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(days <= 1 ? Theme.red : Theme.amber)
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
    let projectID: String
    let changed: Set<String>
    let tier: Tier
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(goal.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                        .multilineTextAlignment(.leading).lineLimit(2)
                    if goal.status == "parked" { Text("parked").font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                GoalDetail(goal: goal, changed: changed, tier: tier).padding(.leading, 12)
                CompleteGoalButton(goal: goal, projectID: projectID).padding(.leading, 12)
            }
        }
    }
}

/// A task at a glance: its name, and one line of where it stands. The rest is a click away.
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
                        Text(ticket.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.leading).lineLimit(2)
                        if !expanded, let line = ticket.blockedReason ?? ticket.latest?.text {
                            Text(line).font(.system(size: 11)).foregroundStyle(ticket.blockedReason != nil ? Theme.red : Theme.textSecondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(expanded ? "Shows less" : "Shows details")
            if !expanded && !ticket.hazards.isEmpty {
                Label(ticket.hazards.count == 1 ? "1 hazard" : "\(ticket.hazards.count) hazards", systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 11)).foregroundStyle(Theme.amber).padding(.leading, 20)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 5) {
                    if ticket.heading != ticket.title {
                        Text(ticket.title).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(ticket.summary == "none" ? "Requirements not written yet" : ticket.summary)
                        .font(.system(size: 10.5)).foregroundStyle(Theme.textTertiary)
                    if let blocked = ticket.blockedReason {
                        Text(blocked).font(.system(size: 11.5)).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
                    }
                    if let latest = ticket.latest {
                        Text(latest.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(ticket.hazards.indices, id: \.self) { i in
                        Label(ticket.hazards[i].what, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 11.5)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(ticket.requirements) { r in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: r.state == "met" ? "checkmark.square.fill" : r.state == "failed" ? "xmark.square.fill" : r.state == "waived" ? "minus.square" : "square")
                                .font(.system(size: 11)).foregroundStyle(r.state == "met" ? Theme.green : r.state == "failed" ? Theme.red : Theme.textTertiary)
                            Text(r.text).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                        }
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
