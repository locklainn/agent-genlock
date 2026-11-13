import GenlockCore
import SwiftUI

/// The sprint report in its own window: what got finished this sprint (one week, from one
/// Claude weekly reset to the next), a picker for past sprints, and any range of days. The
/// same `genlock sprint --all --json` the phone's Status tab shows.
struct SprintReportView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: SprintSelection = .sprint(0)
    @State private var report: SprintReport?
    @State private var error: String?
    @State private var loading = false
    @State private var picking = false
    @State private var from = Calendar.current.date(byAdding: .day, value: -6, to: Date()) ?? Date()
    @State private var to = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(20)
            Divider().overlay(Theme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error { Text(error).foregroundStyle(Theme.red) }
                    else if let report {
                        if report.projects.isEmpty {
                            Text("Nothing finished in this range.").foregroundStyle(Theme.textSecondary)
                        }
                        ForEach(report.projects) { ProjectBlock(project: $0) }
                    } else { ProgressView().frame(maxWidth: .infinity) }
                }
                .padding(20)
            }
        }
        .frame(minWidth: 520, minHeight: 480)
        .background(Theme.canvas)
        .preferredColorScheme(.dark)
        .task(id: selection) { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Menu {
                    ForEach(report?.sprints ?? []) { s in
                        Button((s.offset == 0 ? "This sprint · " : "") + "\(s.label)  ·  \(s.done) done") { selection = .sprint(s.offset) }
                    }
                    Divider()
                    Button("Date Range…") { picking = true }
                } label: { Text(pickerLabel) }
                .menuStyle(.borderlessButton)
                .fixedSize()
                if loading { ProgressView().controlSize(.small) }
                Spacer()
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh")
            }
            if let r = report {
                Text(totalLine(r)).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                if !r.reset.confirmed {
                    Text("Sprint days are provisional: set the weekly reset with genlock sprint --set-reset.")
                        .font(.caption).foregroundStyle(Theme.amber)
                } else {
                    Text("Sprints start \(r.reset.text)").font(.caption).foregroundStyle(Theme.textTertiary)
                }
            }
        }
        .popover(isPresented: $picking) {
            VStack(alignment: .leading, spacing: 12) {
                DatePicker("From", selection: $from, displayedComponents: .date)
                DatePicker("To", selection: $to, in: from..., displayedComponents: .date)
                HStack {
                    Spacer()
                    Button("Cancel") { picking = false }
                    Button("Show") { selection = .days(from: day(from), to: day(to)); picking = false }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(16).frame(width: 280)
        }
    }

    private var pickerLabel: String {
        guard let r = report else { return "This sprint" }
        if r.range.kind == "dates" { return r.range.label }
        return (r.range.current ? "This sprint · " : "Sprint · ") + r.range.label
    }

    private func totalLine(_ r: SprintReport) -> String {
        var s = r.totals.tasks == 1 ? "1 task done" : "\(r.totals.tasks) tasks done"
        if r.totals.goals > 0 { s += r.totals.goals == 1 ? " · 1 goal closed" : " · \(r.totals.goals) goals closed" }
        return s
    }

    private func day(_ d: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    private func load() async {
        guard let tools = model.tools else { error = "Genlock's tools are not ready yet."; return }
        loading = true
        let sel = selection
        let result = await Task.detached { GenlockCLI.sprint(sel, tools: tools) }.value
        loading = false
        switch result {
        case .success(let r): report = r; error = nil
        case .failure(let e): error = e.description
        }
    }
}

private struct ProjectBlock: View {
    let project: SprintReport.Project

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(project.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                Spacer()
                Text("\(project.tasks.count) done").font(.caption).foregroundStyle(Theme.textSecondary)
            }
            ForEach(project.goalsDone) { g in
                HStack(spacing: 8) {
                    Text("goal done").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.green)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.green.opacity(0.16), in: Capsule())
                    Text(g.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textPrimary)
                }
            }
            ForEach(project.byGoal, id: \.goal) { group in
                VStack(alignment: .leading, spacing: 6) {
                    Text(group.goal).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSecondary)
                    ForEach(group.tasks) { t in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(shortDay(t.closed)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.textTertiary)
                                .frame(width: 48, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(t.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.textPrimary)
                                if t.title != t.name {
                                    Text(t.title).font(.system(size: 11)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                                }
                            }
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private func shortDay(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "EEE d"
        return f.string(from: d)
    }
}
