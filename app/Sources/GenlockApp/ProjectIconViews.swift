import AppKit
import GenlockCore
import SwiftUI

/// A project's icon, on a tile in its tier's colour.
struct ProjectIconView: View {
    let project: Project
    var size: CGFloat = 34

    var body: some View {
        let corner = size * 0.27
        ZStack {
            switch project.icon {
            case .image(let path):
                if let image = NSImage(contentsOfFile: path) {
                    Image(nsImage: image).resizable().scaledToFill()
                } else {
                    initial
                }
            case .emoji(let emoji):
                Color.white.opacity(0.10)
                Text(emoji).font(.system(size: size * 0.6))
            case .symbol(let name):
                LinearGradient(colors: Theme.tint(project.tier), startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: name).font(.system(size: size * 0.48, weight: .semibold)).foregroundStyle(.white)
            case nil:
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
        .accessibilityHidden(true)
    }

    private var initial: some View {
        ZStack {
            LinearGradient(colors: Theme.tint(project.tier), startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(project.initial).font(.system(size: size * 0.5, weight: .heavy, design: .rounded)).foregroundStyle(.white)
        }
    }
}

/// Choosing a project's icon: its own screen, in keeping with the setup one.
struct IconPicker: View {
    @Environment(AppModel.self) private var model
    let projectID: String
    @State private var typed = ""

    private static let emoji = ["🚀", "🔥", "⚡️", "🌿", "🌊", "🎯", "🧠", "💰", "📊", "🏛️", "🏫", "🎃",
                                "🎮", "🎧", "📚", "🏠", "🛠️", "🧪", "🤖", "👻", "🦘", "🐙", "🦊", "🌙"]
    private static let symbols = ["bolt.fill", "flame.fill", "leaf.fill", "drop.fill", "star.fill", "heart.fill", "bubble.left.fill", "chart.bar.fill",
                                  "dollarsign.circle.fill", "building.columns.fill", "graduationcap.fill", "book.fill", "gamecontroller.fill", "music.note",
                                  "lightbulb.fill", "wand.and.stars", "cpu.fill", "terminal.fill", "globe", "lock.fill", "cart.fill", "person.2.fill", "map.fill", "paintpalette.fill"]

    var body: some View {
        let project = model.store.project(projectID)
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { model.iconTarget = nil }
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    if let project { ProjectIconView(project: project, size: 56) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project?.name ?? "").font(.system(size: 22, weight: .heavy, design: .rounded)).foregroundStyle(Theme.textPrimary)
                        Text("Choose how this project looks").font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    Button { model.chooseIconImage(for: projectID) } label: { Label("Use an image", systemImage: "photo.fill") }
                        .buttonStyle(GlowButtonStyle())
                }
                section("EMOJI") {
                    grid(Self.emoji) { e in
                        Button { model.setIcon(projectID, .emoji(e)) } label: {
                            Text(e).font(.system(size: 22)).frame(width: 40, height: 40).contentShape(Rectangle())
                        }
                        .buttonStyle(TileStyle(selected: project?.icon == .emoji(e)))
                    }
                    HStack(spacing: 8) {
                        TextField("", text: $typed, prompt: Text("Or type any emoji").foregroundStyle(Theme.textTertiary))
                            .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(Theme.textPrimary)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .glass(corner: 10)
                            .frame(width: 180)
                            .onSubmit(useTyped)
                        Button("Emoji picker") { NSApp.orderFrontCharacterPalette(nil) }.buttonStyle(GlassButtonStyle())
                        if !typed.isEmpty { Button("Use", action: useTyped).buttonStyle(GlassButtonStyle(active: true)) }
                    }
                }
                section("SYMBOLS") {
                    grid(Self.symbols) { name in
                        Button { model.setIcon(projectID, .symbol(name)) } label: {
                            Image(systemName: name).font(.system(size: 17, weight: .medium))
                                .foregroundStyle(project.map { Theme.gradient($0.tier) } ?? Theme.brand)
                                .frame(width: 40, height: 40).contentShape(Rectangle())
                        }
                        .buttonStyle(TileStyle(selected: project?.icon == .symbol(name)))
                        .accessibilityLabel(name)
                    }
                }
                HStack {
                    if project?.icon != nil {
                        Button("Back to the initial") { model.setIcon(projectID, nil) }.buttonStyle(GlassButtonStyle())
                    }
                    Spacer()
                    Button("Done") { model.iconTarget = nil }.buttonStyle(GlassButtonStyle(active: true))
                }
            }
            .padding(24)
            .frame(width: 620)
            .background(Color(hex: 0x12141F), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.brand, lineWidth: 1.5))
            .shadow(color: Color(hex: 0x6D5BFF).opacity(0.45), radius: 20)
        }
        .transition(.opacity)
    }

    private func useTyped() {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return }
        model.setIcon(projectID, .emoji(String(first)))
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 10.5, weight: .heavy)).tracking(1).foregroundStyle(Theme.textTertiary)
            content()
        }
    }

    private func grid<Cell: View>(_ items: [String], @ViewBuilder cell: @escaping (String) -> Cell) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(44), spacing: 4), count: 12), alignment: .leading, spacing: 4) {
            ForEach(items, id: \.self) { cell($0) }
        }
    }
}

struct TileStyle: ButtonStyle {
    var selected = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(selected ? Color.white.opacity(0.18) : (hovering ? Theme.surfaceRaised : Theme.surface), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Color.clear), lineWidth: 2))
            .scaleEffect(configuration.isPressed ? 0.92 : (hovering ? 1.08 : 1))
            .animation(.spring(duration: 0.2), value: hovering)
            .onHover { hovering = $0 }
    }
}
