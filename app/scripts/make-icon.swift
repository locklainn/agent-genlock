// Draws the app icon: a timing signal, with every source locked to it.
import AppKit

let out = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let inset = s * 0.09
    let body = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    NSColor(red: 0.09, green: 0.10, blue: 0.13, alpha: 1).setFill()
    NSBezierPath(roundedRect: body, xRadius: s * 0.19, yRadius: s * 0.19).fill()
    let colors: [NSColor] = [.systemOrange, .systemTeal, .systemPurple]
    for (i, color) in colors.enumerated() {
        let y = s * (0.66 - CGFloat(i) * 0.16)
        let path = NSBezierPath()
        path.lineWidth = s * 0.042
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        path.move(to: NSPoint(x: s * 0.2, y: y))
        for k in 0..<3 {
            let x = s * (0.2 + CGFloat(k) * 0.2)
            path.line(to: NSPoint(x: x + s * 0.1, y: y))
            path.line(to: NSPoint(x: x + s * 0.1, y: y + s * 0.09))
            path.line(to: NSPoint(x: x + s * 0.2, y: y + s * 0.09))
            path.line(to: NSPoint(x: x + s * 0.2, y: y))
        }
        color.setStroke()
        path.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try draw(size).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size).png"))
    try draw(size * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size)@2x.png"))
}
