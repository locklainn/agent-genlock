import GenlockCore
import SwiftUI

/// The design system. Every colour, surface and control comes from here, so the app reads as
/// one thing. The motif is the genlock itself: several signals locked to one clock.
enum Theme {
    static let canvas = Color(red: 0.035, green: 0.039, blue: 0.067)
    static let terminal = NSColor(red: 0.055, green: 0.059, blue: 0.09, alpha: 1)
    static let surface = Color.white.opacity(0.055)
    static let surfaceRaised = Color.white.opacity(0.09)
    static let hairline = Color.white.opacity(0.10)
    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.66)
    static let textTertiary = Color.white.opacity(0.42)

    static let brand = LinearGradient(colors: [Color(hex: 0x7C5CFF), Color(hex: 0x2DD4FF)], startPoint: .leading, endPoint: .trailing)
    static let hot = LinearGradient(colors: [Color(hex: 0xFF4D6D), Color(hex: 0xFF9F43)], startPoint: .leading, endPoint: .trailing)
    static let green = Color(hex: 0x34E5A0)
    static let red = Color(hex: 0xFF5C7A)
    static let amber = Color(hex: 0xFFB84D)
    static let violet = Color(hex: 0xB18CFF)
    static let cyan = Color(hex: 0x4FD8FF)

    static func tint(_ tier: Tier) -> [Color] {
        switch tier {
        case .today: return [Color(hex: 0xFF4D6D), Color(hex: 0xFFB347)]
        case .soon: return [Color(hex: 0x22D3EE), Color(hex: 0x5B8CFF)]
        case .later: return [Color(hex: 0xB069FF), Color(hex: 0x6D6AFF)]
        }
    }

    static func gradient(_ tier: Tier) -> LinearGradient {
        LinearGradient(colors: tint(tier), startPoint: .leading, endPoint: .trailing)
    }

    static func status(_ status: String) -> (name: String, color: Color) {
        switch status {
        case "done": return ("checkmark.circle.fill", green)
        case "in_progress": return ("bolt.circle.fill", cyan)
        case "blocked": return ("exclamationmark.octagon.fill", red)
        case "abandoned": return ("xmark.circle", textTertiary)
        case "draft": return ("circle.dashed", textTertiary)
        default: return ("circle", textSecondary)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// Slow colour moving behind everything. Stops when the system asks for reduced motion.
struct Aurora: View {
    var intensity: Double = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion)) { context in
            let t = reduceMotion ? 12.0 : context.date.timeIntervalSinceReferenceDate / 9
            Canvas { ctx, size in
                let blobs: [(Color, Double, Double, Double)] = [
                    (Color(hex: 0x6D3BFF), 0.18, 0.12, 0.62),
                    (Color(hex: 0x00C2FF), 0.82, 0.18, 0.50),
                    (Color(hex: 0xFF3D81), 0.72, 0.92, 0.46),
                    (Color(hex: 0x1EE3A8), 0.12, 0.92, 0.32),
                ]
                for (i, blob) in blobs.enumerated() {
                    let phase = t + Double(i) * 1.7
                    let x = (blob.1 + 0.08 * sin(phase)) * size.width
                    let y = (blob.2 + 0.10 * cos(phase * 0.8)) * size.height
                    let r = max(size.width, size.height) * blob.3
                    let rect = CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)
                    ctx.fill(Path(ellipseIn: rect), with: .radialGradient(
                        Gradient(colors: [blob.0.opacity(0.34 * intensity), blob.0.opacity(0)]),
                        center: CGPoint(x: x, y: y), startRadius: 0, endRadius: r))
                }
            }
        }
        .background(Theme.canvas)
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// Three signals, locked to one clock and running. The app's mark.
struct SignalMark: View {
    var size: CGFloat = 28
    var animated = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animated || reduceMotion)) { context in
            let phase = (animated && !reduceMotion) ? context.date.timeIntervalSinceReferenceDate * 0.45 : 0
            Canvas { ctx, s in
                let colors = [Color(hex: 0xFF6B6B), Color(hex: 0x2DD4FF), Color(hex: 0xA78BFF)]
                let period = s.width / 2
                let amp = s.height * 0.09
                for (i, color) in colors.enumerated() {
                    let baseY = s.height * (0.26 + Double(i) * 0.24)
                    var path = Path()
                    let start = -period + (phase.truncatingRemainder(dividingBy: 1)) * period
                    var x = start
                    path.move(to: CGPoint(x: x, y: baseY + amp))
                    while x < s.width + period {
                        path.addLine(to: CGPoint(x: x + period / 2, y: baseY + amp))
                        path.addLine(to: CGPoint(x: x + period / 2, y: baseY - amp))
                        path.addLine(to: CGPoint(x: x + period, y: baseY - amp))
                        path.addLine(to: CGPoint(x: x + period, y: baseY + amp))
                        x += period
                    }
                    ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: max(1.5, s.width * 0.055), lineCap: .round, lineJoin: .round))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
        .accessibilityHidden(true)
    }
}

/// A live waveform. Follows `level` when there is one, and idles gently otherwise.
struct Waveform: View {
    var level: Double = 0.5
    var bars = 28
    var height: CGFloat = 26
    var colors: [Color] = [Color(hex: 0xFF4D6D), Color(hex: 0xFFB347)]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private func barHeight(_ index: Int, _ t: Double) -> CGFloat {
        let i = Double(index)
        let half = Double(bars) / 2
        let wave: Double = (sin(t + i * 0.62) + sin(t * 0.63 + i * 0.27)) / 4 + 0.5
        let centre: Double = 1 - abs(i - half) / half
        let loudness: Double = 0.25 + 0.75 * level
        let shape: Double = 0.35 + 0.65 * centre
        let fraction: Double = 0.14 + 0.86 * wave * loudness * shape
        return max(3, height * CGFloat(fraction))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate * 7
            HStack(alignment: .center, spacing: 2.5) {
                ForEach(0..<bars, id: \.self) { i in
                    Capsule()
                        .fill(LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top))
                        .frame(width: 3, height: barHeight(i, t))
                }
            }
            .frame(height: height)
        }
        .accessibilityHidden(true)
    }
}

struct LiveChip: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 5) {
            ZStack {
                Circle().fill(Theme.green.opacity(0.4)).frame(width: 13, height: 13)
                    .scaleEffect(pulse ? 1 : 0.4).opacity(pulse ? 0 : 1)
                Circle().fill(Theme.green).frame(width: 7, height: 7)
            }
            .frame(width: 13, height: 13)
            Text("LIVE").font(.system(size: 10, weight: .heavy)).tracking(0.8).foregroundStyle(Theme.green)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.3).repeatForever(autoreverses: false)) { pulse = true }
        }
        .accessibilityLabel("Session running")
    }
}

struct ProgressRing: View {
    let done: Int
    let total: Int
    var colors: [Color]
    var size: CGFloat = 44

    var body: some View {
        let fraction = total > 0 ? Double(done) / Double(total) : 0
        ZStack {
            Circle().stroke(Color.white.opacity(0.10), lineWidth: size * 0.11)
            Circle()
                .trim(from: 0, to: max(fraction, 0.001))
                .stroke(AngularGradient(colors: colors + [colors[0]], center: .center),
                        style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: colors[0].opacity(0.7), radius: 5)
            Text("\(done)/\(total)")
                .font(.system(size: size * 0.27, weight: .bold, design: .rounded))
                .monospacedDigit().foregroundStyle(Theme.textPrimary).minimumScaleFactor(0.6)
        }
        .frame(width: size, height: size)
        .animation(.spring(duration: 0.6), value: fraction)
        .accessibilityLabel("\(done) of \(total) tasks done")
    }
}

struct Pill: View {
    let text: String
    var symbol: String?
    var color: Color

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .bold)) }
            Text(text).font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(color.opacity(0.15), in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.28), lineWidth: 1))
        .lineLimit(1).fixedSize()
    }
}

/// Filled, glowing, and the one thing on screen to press.
struct GlowButtonStyle: ButtonStyle {
    var gradient: LinearGradient = Theme.brand
    var glow: Color = Color(hex: 0x6D5BFF)
    var large = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: large ? 15 : 13, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, large ? 22 : 14).padding(.vertical, large ? 12 : 8)
            .background(gradient, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.28), lineWidth: 1))
            .shadow(color: glow.opacity(hovering ? 0.8 : 0.45), radius: hovering ? 18 : 10, y: 3)
            .scaleEffect(configuration.isPressed ? 0.96 : (hovering ? 1.03 : 1))
            .animation(.spring(duration: 0.25), value: hovering)
            .animation(.spring(duration: 0.18), value: configuration.isPressed)
            .onHover { hovering = $0 }
            .contentShape(Capsule())
    }
}

/// Quiet glass, for everything that is not the main action.
struct GlassButtonStyle: ButtonStyle {
    var active = false
    var compact = false
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(active ? Theme.textPrimary : Theme.textSecondary)
            .padding(.horizontal, compact ? 8 : 12).padding(.vertical, compact ? 5 : 7)
            .background(active ? Color.white.opacity(0.16) : (hovering ? Theme.surfaceRaised : Theme.surface), in: Capsule())
            .overlay(Capsule().strokeBorder(active ? Color.white.opacity(0.28) : Theme.hairline, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.14), value: hovering)
            .onHover { hovering = $0 }
            .contentShape(Capsule())
    }
}

struct IconButtonStyle: ButtonStyle {
    var tint: Color = Theme.textSecondary
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(hovering ? Theme.textPrimary : tint)
            .frame(width: 28, height: 28)
            .background(hovering ? Theme.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 8))
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .onHover { hovering = $0 }
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct Glass: ViewModifier {
    var corner: CGFloat = 16
    var fill: Color = Theme.surface

    func body(content: Content) -> some View {
        content
            .background(fill, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 1))
    }
}

extension View {
    func glass(corner: CGFloat = 16, fill: Color = Theme.surface) -> some View {
        modifier(Glass(corner: corner, fill: fill))
    }
}
