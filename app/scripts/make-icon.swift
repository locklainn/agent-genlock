// Draws the app icon: a timing signal, with every source locked to it.
//
//   swift make-icon.swift OUT          the .iconset that build.sh turns into Genlock.icns
//   swift make-icon.swift OUT --logo   the logo assets in assets/logo: SVG and PNGs of the icon and the bare mark
//
// Both come from the one geometry below, so the logo can never drift from the app icon.
import AppKit

let out = CommandLine.arguments[1]
let logo = CommandLine.arguments.contains("--logo")
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

// Everything is a fraction of the icon's side, in AppKit's y-up coordinates.
let inset = 0.09, radius = 0.19, lineWidth = 0.042
let tile = NSColor(red: 0.09, green: 0.10, blue: 0.13, alpha: 1)
// Resolved to fixed sRGB in the light appearance, so the icon is the same whatever mode the Mac is in when it builds.
let colors: [NSColor] = {
    var resolved: [NSColor] = []
    NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
        resolved = [NSColor.systemOrange, .systemTeal, .systemPurple].map { $0.usingColorSpace(.sRGB)! }
    }
    return resolved
}()

/// Each signal row as points: start at the left, then three periods of a square wave.
func rows() -> [[CGPoint]] {
    (0..<3).map { i in
        // Three rows, each y to y + 0.09, spaced 0.16 apart: 0.34 to 0.75 tall as a block would sit high,
        // so the block is centred on the icon at 0.5.
        let y = 0.615 - Double(i) * 0.16
        var points = [CGPoint(x: 0.2, y: y)]
        for k in 0..<3 {
            let x = 0.2 + Double(k) * 0.2
            points += [CGPoint(x: x + 0.1, y: y), CGPoint(x: x + 0.1, y: y + 0.09),
                       CGPoint(x: x + 0.2, y: y + 0.09), CGPoint(x: x + 0.2, y: y)]
        }
        return points
    }
}

func draw(_ px: Int, withTile: Bool = true) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    if withTile {
        let body = NSRect(x: s * inset, y: s * inset, width: s * (1 - 2 * inset), height: s * (1 - 2 * inset))
        tile.setFill()
        NSBezierPath(roundedRect: body, xRadius: s * radius, yRadius: s * radius).fill()
    }
    for (points, color) in zip(rows(), colors) {
        let path = NSBezierPath()
        path.lineWidth = s * lineWidth
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.move(to: NSPoint(x: s * points[0].x, y: s * points[0].y))
        for p in points.dropFirst() { path.line(to: NSPoint(x: s * p.x, y: s * p.y)) }
        color.setStroke()
        path.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

/// The same drawing as SVG on a 1024 grid. SVG is y-down, so every y is flipped.
func svg(withTile: Bool) -> String {
    let s = 1024.0
    func n(_ v: Double) -> String { String(format: "%g", (v * 1000).rounded() / 1000) }
    func hex(_ c: NSColor) -> String {
        String(format: "#%02X%02X%02X", Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()),
               Int((c.blueComponent * 255).rounded()))
    }
    var body = ""
    if withTile {
        body += "  <rect x=\"\(n(s * inset))\" y=\"\(n(s * inset))\" width=\"\(n(s * (1 - 2 * inset)))\" height=\"\(n(s * (1 - 2 * inset)))\" rx=\"\(n(s * radius))\" fill=\"\(hex(tile.usingColorSpace(.sRGB)!))\"/>\n"
    }
    body += "  <g fill=\"none\" stroke-width=\"\(n(s * lineWidth))\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n"
    for (points, color) in zip(rows(), colors) {
        let d = points.enumerated().map { "\($0.offset == 0 ? "M" : "L")\(n(s * $0.element.x)) \(n(s * (1 - $0.element.y)))" }
        body += "    <path stroke=\"\(hex(color))\" d=\"\(d.joined(separator: " "))\"/>\n"
    }
    body += "  </g>\n"
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\" width=\"1024\" height=\"1024\">\n<title>Genlock</title>\n\(body)</svg>\n"
}

func write(_ data: Data, _ name: String) throws { try data.write(to: URL(fileURLWithPath: "\(out)/\(name)")) }

if logo {
    try write(Data(svg(withTile: true).utf8), "genlock-icon.svg")
    try write(Data(svg(withTile: false).utf8), "genlock-mark.svg")
    for size in [16, 32, 64, 128, 256, 512, 1024] {
        try write(draw(size), "genlock-icon-\(size).png")
        try write(draw(size, withTile: false), "genlock-mark-\(size).png")
    }
} else {
    for size in [16, 32, 128, 256, 512] {
        try write(draw(size), "icon_\(size)x\(size).png")
        try write(draw(size * 2), "icon_\(size)x\(size)@2x.png")
    }
}
