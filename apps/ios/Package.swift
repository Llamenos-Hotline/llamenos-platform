// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Llamenos",
    platforms: [.iOS(.v17)],
    dependencies: [
        // Linphone SDK. Same pin as the `packages:` block in project.yml — see the note
        // there for why it is a revision (tag 5.5.23-novideo), not a version.
        .package(
            url: "https://github.com/BelledonneCommunications/linphone-sdk-swift-ios",
            revision: "dc3c6e3601a2aceeee74d0420353f20d911eb802"
        ),
    ],
    targets: [
        .binaryTarget(
            name: "LlamenosCoreFFI",
            path: "LlamenosCoreFFI.xcframework"
        ),
        .target(
            name: "Llamenos",
            dependencies: [
                "LlamenosCoreFFI",
                .product(name: "linphonesw", package: "linphone-sdk-swift-ios"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "LlamenosTests",
            dependencies: ["Llamenos"],
            path: "Tests/Unit"
        ),
    ]
)
