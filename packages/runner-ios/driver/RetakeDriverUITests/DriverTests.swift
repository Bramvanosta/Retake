// The Retake iOS driver: one UI test that serves a small HTTP API on 127.0.0.1 until it is told to quit.
// The port and the token come from the environment (xcodebuild passes TEST_RUNNER_RETAKE_DRIVER_PORT and
// TEST_RUNNER_RETAKE_DRIVER_TOKEN to the runner as RETAKE_DRIVER_PORT and RETAKE_DRIVER_TOKEN).
// Commands arrive on the listener's queue and run here, on the main thread, one at a time, only from this loop:
// XCUITest spins the main run loop inside its own calls, so work is never dispatched onto the main queue.
// Without a command for RETAKE_DRIVER_IDLE_S seconds (default 120; the host pings while it waits) the test ends by
// itself: a host that died leaves no driver running.

import XCTest

final class DriverTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        executionTimeAllowance = 24 * 60 * 60
    }

    func testServe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let portText = env["RETAKE_DRIVER_PORT"], let port = UInt16(portText), port > 0 else {
            XCTFail("RETAKE_DRIVER_PORT is not set")
            return
        }
        guard let token = env["RETAKE_DRIVER_TOKEN"], token.count >= 32 else {
            XCTFail("RETAKE_DRIVER_TOKEN is not set or too short")
            return
        }
        let inbox = Inbox()
        let server = try Server(port: port, token: token, inbox: inbox)
        try server.start()
        defer { server.stop() }
        let idle = Double(env["RETAKE_DRIVER_IDLE_S"] ?? "") ?? 120
        let commands = Commands()
        var lastDone = Date()
        while !commands.finished {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            while let job = inbox.next() {
                job.reply(commands.run(job.body))
                lastDone = Date()
                if commands.finished { break }
            }
            if Date().timeIntervalSince(max(lastDone, inbox.lastCommand)) > idle {
                print("retake-driver: no command for \(Int(idle)) s: quitting")
                break
            }
        }
        // Let the last reply leave before the listener closes.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
    }
}
