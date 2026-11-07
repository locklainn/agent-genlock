import AppKit
import GenlockCore
import SwiftUI

struct CompletingGoal: Equatable {
    let goal: Snapshot.Goal
    let projectID: String
}

extension AppModel {
    /// Finished goals across every project, newest first.
    var completedGoals: [(goal: Snapshot.Goal, projectID: String)] {
        store.projects.flatMap { p in (state(for: p.id).snapshot?.completedGoals ?? []).map { (goal: $0, projectID: p.id) } }
            .sorted { ($0.goal.completedAt ?? "") > ($1.goal.completedAt ?? "") }
    }

    var completedGoalCount: Int { store.projects.reduce(0) { $0 + (states[$1.id]?.snapshot?.completedGoals.count ?? 0) } }
}

private let completedDate: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .none
    return f
}()

func completedDay(_ goal: Snapshot.Goal) -> String {
    GoalCompletion.date(goal.completedAt).map(completedDate.string(from:)) ?? ""
}

struct CompleteGoalButton: View {
    @Environment(AppModel.self) private var model
    let goal: Snapshot.Goal
    let projectID: String

    var body: some View {
        Button { model.completingGoal = CompletingGoal(goal: goal, projectID: projectID) } label: {
            Label("Complete goal", systemImage: "checkmark.seal")
        }
        .buttonStyle(GlassButtonStyle())
    }
}

/// Finishing a goal is yours to say, and it asks what shows it, which is what the record keeps.
struct CompleteGoalSheet: View {
    @Environment(AppModel.self) private var model
    let completing: CompletingGoal
    @State private var evidence = ""

    private var open: [Snapshot.Ticket] {
        model.state(for: completing.projectID).snapshot?.openTasks(of: completing.goal) ?? []
    }

    private var defaultEvidence: String { GoalCompletion.defaultEvidence(completing.goal) }

    private func complete() {
        let typed = evidence.trimmingCharacters(in: .whitespacesAndNewlines)
        model.completeGoal(completing.goal, evidence: typed.isEmpty ? defaultEvidence : typed, in: completing.projectID)
        model.completingGoal = nil
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { model.completingGoal = nil }
            VStack(alignment: .leading, spacing: 14) {
                Text("Complete this goal?").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                Text(completing.goal.title).font(.system(size: 20, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if open.isEmpty {
                    TextField("What shows it is done? (\(defaultEvidence))", text: $evidence)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(complete)
                } else {
                    Text(open.count == 1 ? "1 task has to finish or be dropped first:" : "\(open.count) tasks have to finish or be dropped first:")
                        .font(.system(size: 12.5)).foregroundStyle(Theme.amber)
                    ForEach(open) { t in
                        Text(t.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary).lineLimit(2)
                    }
                }
                HStack {
                    Spacer()
                    Button(open.isEmpty ? "Not yet" : "Close") { model.completingGoal = nil }.buttonStyle(GlassButtonStyle())
                    if open.isEmpty {
                        Button("Complete goal", action: complete).buttonStyle(GlowButtonStyle())
                    }
                }
            }
            .padding(24)
            .frame(width: 460)
            .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.brand, lineWidth: 1.5))
        }
    }
}

/// Finished goals in one project, out of the way until asked for.
struct CompletedCard: View {
    let goals: [Snapshot.Goal]
    let projectID: String
    @State private var expanded = false

    var body: some View {
        InspectorCard(title: "Completed", symbol: "checkmark.seal.fill", count: goals.count, color: Theme.green) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.textTertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(expanded ? "Latest first" : "Latest: \(goals[0].heading)")
                        .font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(goals) { CompletedRow(goal: $0, projectID: projectID) }
            }
        }
    }
}

/// When it finished up front. What showed it, and the way back, a click away.
struct CompletedRow: View {
    @Environment(AppModel.self) private var model
    let goal: Snapshot.Goal
    let projectID: String
    var projectName: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.spring(duration: 0.28)) { expanded.toggle() } } label: {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 13)).foregroundStyle(Theme.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(goal.heading).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                            .multilineTextAlignment(.leading).lineLimit(2)
                        Text([projectName, completedDay(goal), GoalCompletion.summary(goal)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: 11)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    if goal.heading != goal.title {
                        Text(goal.title).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if let evidence = goal.evidence, !evidence.isEmpty {
                        Text(evidence).font(.system(size: 11.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Button("Reopen") { model.reopenGoal(goal, in: projectID) }.buttonStyle(LinkButtonStyle())
                }
                .padding(.leading, 20)
            }
        }
    }
}

/// Every goal you have finished, across projects.
struct CompletedGoalsSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { model.showingCompleted = false }
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Completed goals").font(.system(size: 20, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Button("Close") { model.showingCompleted = false }.buttonStyle(GlassButtonStyle())
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.completedGoals, id: \.goal.id) { item in
                            CompletedRow(goal: item.goal, projectID: item.projectID, projectName: model.store.project(item.projectID)?.name)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollIndicators(.never)
            }
            .padding(24)
            .frame(width: 520, height: 520)
            .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.brand, lineWidth: 1.5))
        }
    }
}
