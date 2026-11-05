// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "Genlock",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(name: "GenlockCore"),
        .executableTarget(
            name: "Genlock",
            dependencies: ["GenlockCore", .product(name: "SwiftTerm", package: "SwiftTerm")],
            path: "Sources/GenlockApp"
        ),
        .testTarget(name: "GenlockCoreTests", dependencies: ["GenlockCore"]),
    ]
)
