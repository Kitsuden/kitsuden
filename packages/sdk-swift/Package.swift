// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Kitsuden",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8)],
    products: [
        .library(name: "Kitsuden", targets: ["Kitsuden"]),
    ],
    targets: [
        .target(name: "Kitsuden"),
        .testTarget(name: "KitsudenTests", dependencies: ["Kitsuden"]),
    ]
)
