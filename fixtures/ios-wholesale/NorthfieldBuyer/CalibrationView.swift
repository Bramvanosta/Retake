// northfield://calibrate: a full-screen view, white while a finger is down, black otherwise. The iOS runner's timing
// calibration taps it while recording and compares its tap times with the first white frame of the video.
// UIKit touches (not a SwiftUI gesture) so the colour changes in the touch-down event itself. The surface's
// accessibility value carries the wall-clock times (epoch ms) of the last touch-down and lift and a touch count, so a
// test can compare its own tap times with the app's.

import SwiftUI
import UIKit

struct CalibrationView: View {
    let close: () -> Void

    var body: some View {
        TouchColourView()
            .ignoresSafeArea()
            .accessibilityIdentifier("calibration-surface")
            .overlay(alignment: .bottom) {
                Button("Done", action: close)
                    .foregroundStyle(.gray)
                    .padding(.bottom, 24)
                    .accessibilityIdentifier("calibration-done")
            }
            .statusBarHidden(true)
    }
}

private struct TouchColourView: UIViewRepresentable {
    func makeUIView(context: Context) -> TouchColourSurface { TouchColourSurface() }
    func updateUIView(_ view: TouchColourSurface, context: Context) {}
}

final class TouchColourSurface: UIView {
    private var down = 0
    private var touches = 0
    private var lastDown = 0.0
    private var lastUp = 0.0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        isMultipleTouchEnabled = true
        isAccessibilityElement = true
        accessibilityLabel = "Calibration surface"
        accessibilityTraits = .allowsDirectInteraction
        record()
    }

    required init?(coder: NSCoder) { nil }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        down += touches.count
        backgroundColor = .white
        self.touches += touches.count
        lastDown = Date().timeIntervalSince1970 * 1000
        record()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { lift(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { lift(touches) }

    private func lift(_ touches: Set<UITouch>) {
        down = max(0, down - touches.count)
        if down == 0 { backgroundColor = .black }
        lastUp = Date().timeIntervalSince1970 * 1000
        record()
    }

    private func record() {
        accessibilityValue = String(format: "touches=%d down=%.1f up=%.1f", touches, lastDown, lastUp)
    }
}
