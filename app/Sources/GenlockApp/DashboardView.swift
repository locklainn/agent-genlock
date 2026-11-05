import AppKit
import GenlockCore
import SwiftUI

struct DashboardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            DashboardHeader()
            if model.store.projects.isEmpty {
                Onboarding()
            } else {
                StatStrip().padding(.horizontal, 24).padding(.bottom, 16)
                HStack(alignment: .top, spacing: 16) {
                    ForEach(Tier.allCases) { TierColumn(tier: $0) }
                }
                .padding(.horizontal, 24).padding(.bottom, 24)
            }
        }
    }
}

struct DashboardHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 12) {
            SignalMark(size: 30)
            Text("GENLOCK").font(.system(size: 17, weight: .heavy, design: .rounded)).tracking(2.2)
                .foregroundStyle(Theme.brand)
            if model.markedCount > 0 {
                Pill(text: "\(model.markedCount) selected · release Shift to open", symbol: "rectangle.split.3x1.fill", color: Theme.cyan)
                    .transition(.scale.combined(with: .opacity))
            }
            Spacer()
            if !model.visible.isEmpty {
                Button { model.route = .sessions } label: {
                    Label("Back to \(model.visible.count == 1 ? "session" : "\(model.visible.count) sessions")", systemImage: "terminal.fill")
                }
                .buttonStyle(GlassButtonStyle())
            }
            Button { model.chooseFolders() } label: { Label("Add project", systemImage: "plus") }
                .buttonStyle(GlowButtonStyle())
        }
        .padding(.leading, 86).padding(.trailing, 24).padding(.top, 14).padding(.bottom, 16)
        .animation(.spring(duration: 0.3), value: model.markedCount)
    }
}

/// The whole portfolio at a glance. Numbers first, because they are what you scan for.
struct StatStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let cards = model.store.projects.compactMap { model.state(for: $0.id).snapshot }.map(CardSummary.init)
        HStack(spacing: 12) {
            StatTile(value: model.sessions.values.filter(\.isRunning).count, label: "Live sessions", symbol: "waveform.path.ecg", colors: [Theme.green, Theme.cyan])
            StatTile(value: cards.reduce(0) { $0 + $1.waitingOnYou }, label: "Waiting on you", symbol: "person.fill.questionmark", colors: [Theme.violet, Color(hex: 0x6D6AFF)])
            StatTile(value: cards.reduce(0) { $0 + $1.toReview }, label: "To review", symbol: "doc.text.magnifyingglass", colors: [Theme.cyan, Color(hex: 0x5B8CFF)])
            StatTile(value: cards.filter { $0.deadline != nil }.count, label: "Due this week", symbol: "flame.fill", colors: [Color(hex: 0xFF4D6D), Theme.amber])
        }
    }
}

struct StatTile: View {
    let value: Int
    let label: String
    let symbol: String
    let colors: [Color]

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                .foregroundStyle(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 36, height: 36)
                .background(colors[0].opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 0) {
                Text("\(value)").font(.system(size: 24, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(value > 0 ? Theme.textPrimary : Theme.textTertiary)
                    .contentTransition(.numericText())
                Text(label).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .glass(corner: 14)
        .animation(.spring(duration: 0.4), value: value)
        .accessibilityElement(children: .combine)
    }
}

/// First run. Sells the idea, then makes starting one gesture.
struct Onboarding: View {
    @Environment(AppModel.self) private var model
    @State private var isTargeted = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 8)
            SignalMark(size: 92)
                .shadow(color: Color(hex: 0x5B8CFF).opacity(0.6), radius: 28)
            VStack(spacing: 8) {
                Text("Every agent. One signal.")
                    .font(.system(size: 42, weight: .heavy, design: .rounded))
                    .foregroundStyle(LinearGradient(colors: [.white, Color(hex: 0xB9C6FF)], startPoint: .top, endPoint: .bottom))
                Text("All your projects, what each is trying to do, and a live Claude Code session one click away.")
                    .font(.system(size: 16)).foregroundStyle(Theme.textSecondary)
            }
            VStack(spacing: 14) {
                Image(systemName: "folder.badge.plus").font(.system(size: 30, weight: .medium))
                    .foregroundStyle(Theme.brand)
                Text("Drop your project folders here").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.textPrimary)
                Button { model.chooseFolders() } label: { Text("Browse for folders") }
                    .buttonStyle(GlowButtonStyle(large: true))
            }
            .frame(maxWidth: 560).padding(.vertical, 28)
            .background(Theme.surface.opacity(isTargeted ? 2.2 : 1), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: isTargeted ? 2.5 : 1.5, dash: [8, 6])))
            .scaleEffect(isTargeted ? 1.02 : 1)
            .animation(.spring(duration: 0.3), value: isTargeted)
            .dropDestination(for: URL.self) { urls, _ in
                let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                for url in folders { model.addProject(path: url.path) }
                return !folders.isEmpty
            } isTargeted: { isTargeted = $0 }

            if !model.suggestions.isEmpty {
                VStack(spacing: 10) {
                    Text("ALREADY RUNNING GENLOCK ON THIS MAC").font(.system(size: 11, weight: .bold)).tracking(1.1)
                        .foregroundStyle(Theme.textTertiary)
                    HStack(spacing: 10) {
                        ForEach(model.suggestions.prefix(4), id: \.self) { path in
                            Button { withAnimation(.spring(duration: 0.35)) { model.addProject(path: path) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "bolt.horizontal.circle.fill").foregroundStyle(Theme.brand).font(.system(size: 18))
                                    Text(URL(fileURLWithPath: path).lastPathComponent).font(.system(size: 13.5, weight: .semibold))
                                        .foregroundStyle(Theme.textPrimary).lineLimit(1)
                                    Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.textSecondary)
                                }
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .glass(corner: 12)
                            }
                            .buttonStyle(.plain)
                            .help(path)
                        }
                    }
                }
            }
            Spacer(minLength: 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 40)
    }
}

struct TierColumn: View {
    @Environment(AppModel.self) private var model
    let tier: Tier
    @State private var isTargeted = false

    var body: some View {
        let projects = model.store.inTier(tier)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(tier.title).font(.system(size: 14, weight: .heavy, design: .rounded)).tracking(1.6)
                    .foregroundStyle(Theme.gradient(tier))
                Text("\(projects.count)").font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.white.opacity(0.09), in: Capsule())
                Spacer()
            }
            Rectangle().fill(Theme.gradient(tier)).frame(height: 2).opacity(0.8)
                .shadow(color: Theme.tint(tier)[0].opacity(0.8), radius: 6)

            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(projects) { ProjectCard(project: $0, tier: tier) }
                }
                .padding(6)
            }
            .padding(-6)
            .scrollIndicators(.never)
            .overlay {
                if projects.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "arrow.down.to.line.compact").font(.system(size: 18)).foregroundStyle(Theme.gradient(tier))
                        Text("Drag a project here").font(.system(size: 12.5)).foregroundStyle(Theme.textTertiary)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(isTargeted ? Theme.tint(tier)[0].opacity(0.14) : Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(isTargeted ? AnyShapeStyle(Theme.gradient(tier)) : AnyShapeStyle(Color.white.opacity(0.06)), lineWidth: isTargeted ? 2 : 1))
        .animation(.easeOut(duration: 0.16), value: isTargeted)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            model.move(id, to: tier)
            return true
        } isTargeted: { isTargeted = $0 }
    }
}

struct ProjectCard: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let tier: Tier
    @State private var isHovered = false
    @State private var isDropTarget = false

    private var state: ProjectState { model.state(for: project.id) }
    private var isRunning: Bool { model.hasRunningSession(project: project.id) }

    var body: some View {
        let marked = model.isMarked(project.id)
        let order = model.markOrder(project.id)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: "folder.fill").font(.system(size: 10.5)).foregroundStyle(Theme.gradient(tier))
                Text(project.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.textSecondary).lineLimit(1)
                Spacer(minLength: 4)
                if isRunning { LiveChip() }
                if let order {
                    Text("\(order)").font(.system(size: 12, weight: .heavy, design: .rounded)).foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(Theme.brand, in: Circle())
                        .transition(.scale)
                }
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isHovered ? Theme.surfaceRaised : Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(marked || isHovered ? AnyShapeStyle(marked ? Theme.brand : Theme.gradient(tier)) : AnyShapeStyle(Theme.hairline),
                              lineWidth: marked ? 2.5 : (isHovered ? 1.5 : 1))
        }
        .overlay(alignment: .top) {
            if isDropTarget { Capsule().fill(Theme.gradient(tier)).frame(height: 3).offset(y: -8) }
        }
        .shadow(color: (marked ? Color(hex: 0x6D5BFF) : Theme.tint(tier)[0]).opacity(marked ? 0.55 : (isHovered ? 0.4 : 0)), radius: 18, y: 5)
        .scaleEffect(isHovered ? 1.018 : 1)
        .animation(.spring(duration: 0.26), value: isHovered)
        .animation(.spring(duration: 0.26), value: marked)
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .background(GeometryReader { geo in
            Color.clear
                .onAppear { model.cardFrames[project.id] = geo.frame(in: .global) }
                .onChange(of: geo.frame(in: .global)) { _, f in model.cardFrames[project.id] = f }
        })
        .onHover { hovering in
            isHovered = hovering
            if hovering { model.hoveredCard = project.id }
            else if model.hoveredCard == project.id { model.hoveredCard = nil }
        }
        .onTapGesture { model.clickCard(project.id) }
        .draggable(project.id)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, id != project.id else { return false }
            model.move(id, to: tier, before: project.id)
            return true
        } isTargeted: { isDropTarget = $0 }
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var content: some View {
        if !project.exists {
            Label("This folder no longer exists", systemImage: "questionmark.folder.fill").font(.system(size: 13)).foregroundStyle(Theme.amber)
        } else if let error = state.error {
            Label(error.description, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12.5)).foregroundStyle(Theme.amber)
                .textSelection(.enabled)
        } else if let snap = state.snapshot {
            summary(snap)
        } else {
            Waveform(level: 0.4, bars: 16, height: 18, colors: Theme.tint(tier))
        }
    }

    @ViewBuilder private func summary(_ s: Snapshot) -> some View {
        let c = CardSummary(s)
        if c.needsSetup {
            Text("Not on the signal yet").font(.system(size: 17, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
            Text("Set up genlock to track goals and tasks here. You can still open a session.")
                .font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary).fixedSize(horizontal: false, vertical: true)
            Button("Set up genlock") { model.setupTarget = project.id }
                .buttonStyle(GlowButtonStyle(gradient: Theme.gradient(tier), glow: Theme.tint(tier)[0]))
        } else {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(c.goalTitle ?? "No goal yet").font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(c.goalTitle == nil ? Theme.textTertiary : Theme.textPrimary)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    if let next = c.nextThing {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "arrow.right").font(.system(size: 9.5, weight: .heavy)).foregroundStyle(Theme.gradient(tier))
                            Text(next).font(.system(size: 12.5)).foregroundStyle(Theme.textSecondary).lineLimit(2)
                        }
                    }
                }
                Spacer(minLength: 0)
                if let g = s.goal(s.currentGoal), g.progress.total > 0 {
                    ProgressRing(done: g.progress.done, total: g.progress.total, colors: Theme.tint(tier))
                }
            }
            if let task = c.lastTaskTitle, let status = c.lastTaskStatus {
                let symbol = Theme.status(status)
                HStack(spacing: 7) {
                    Image(systemName: symbol.name).foregroundStyle(symbol.color).font(.system(size: 12))
                        .accessibilityLabel(Status.label(status))
                    Text(task).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.textPrimary.opacity(0.85)).lineLimit(1)
                    Spacer(minLength: 4)
                    if let when = c.lastTaskUpdated {
                        Text(ISODate.age(when)).font(.system(size: 11)).foregroundStyle(Theme.textTertiary).fixedSize()
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 7)
                .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            badges(c)
        }
    }

    @ViewBuilder private func badges(_ c: CardSummary) -> some View {
        if c.waitingOnYou > 0 || c.toReview > 0 || c.deadline != nil || c.extraGoals > 0 {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { pills(c) }
                VStack(alignment: .leading, spacing: 6) { pills(c) }
            }
        }
    }

    @ViewBuilder private func pills(_ c: CardSummary) -> some View {
        if let d = c.deadline {
            Pill(text: d.label, symbol: "flame.fill", color: d.isOverdue || d.daysUntil <= 1 ? Theme.red : Theme.amber).help(d.text)
        }
        if c.waitingOnYou > 0 { Pill(text: "\(c.waitingOnYou) for you", symbol: "person.fill.questionmark", color: Theme.violet) }
        if c.toReview > 0 { Pill(text: "\(c.toReview) to review", symbol: "doc.text.fill", color: Theme.cyan) }
        if c.extraGoals > 0 { Pill(text: "+\(c.extraGoals) goals", symbol: nil, color: Theme.textSecondary) }
    }

    @ViewBuilder private var menu: some View {
        Menu("Move To") {
            ForEach(Tier.allCases) { t in
                Button(t.title) { model.move(project.id, to: t) }.disabled(t == tier)
            }
        }
        Divider()
        Button("Open Session") { model.openSessions([project.id]) }
        Button("Resume Last Conversation") { model.restart(project.id, resume: true); model.openSessions([project.id]) }
        if model.sessions[project.id] != nil {
            Button("End Session") { model.endSession(project.id) }
        }
        Divider()
        if state.snapshot?.initialized == false { Button("Set Up genlock…") { model.setupTarget = project.id } }
        Button("Reveal in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: project.path) }
        Button("Remove from Genlock") { model.removeProject(project.id) }
    }
}

/// Where records go is a real choice, so it gets a real screen rather than a system alert.
struct SetupSheet: View {
    @Environment(AppModel.self) private var model
    let projectID: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { model.setupTarget = nil }
            VStack(spacing: 20) {
                VStack(spacing: 6) {
                    Text("Bring \(URL(fileURLWithPath: projectID).lastPathComponent) onto the signal")
                        .font(.system(size: 24, weight: .heavy, design: .rounded)).foregroundStyle(Theme.textPrimary)
                    Text("Records are permanent logs that can quote people. Where should they live?")
                        .font(.system(size: 14)).foregroundStyle(Theme.textSecondary)
                }
                HStack(spacing: 14) {
                    option(title: "Private", symbol: "lock.fill", colors: [Color(hex: 0xB069FF), Color(hex: 0x6D6AFF)],
                           text: "Stay on this Mac, excluded from git. Best for public or sensitive repositories.", flag: "--private")
                    option(title: "Shared", symbol: "arrow.triangle.branch", colors: [Color(hex: 0x22D3EE), Color(hex: 0x5B8CFF)],
                           text: "Committed with your work, so they have history and reach other machines.", flag: "--shared")
                }
                Button("Not now") { model.setupTarget = nil }.buttonStyle(GlassButtonStyle())
            }
            .padding(28)
            .frame(width: 640)
            .background(Color(hex: 0x12141F), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.brand, lineWidth: 1.5))
            .shadow(color: Color(hex: 0x6D5BFF).opacity(0.5), radius: 40)
        }
        .transition(.opacity)
    }

    private func option(title: String, symbol: String, colors: [Color], text: String, flag: String) -> some View {
        Button { model.setUp(projectID, flag: flag) } label: {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol).font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                Text(title).font(.system(size: 18, weight: .bold, design: .rounded)).foregroundStyle(Theme.textPrimary)
                Text(text).font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
            .glass(corner: 16, fill: colors[0].opacity(0.10))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
