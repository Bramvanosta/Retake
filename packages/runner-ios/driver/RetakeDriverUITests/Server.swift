// A minimal HTTP/1.1 server on 127.0.0.1 only (Network.framework), one request per connection.
// GET /status takes no token: it answers the X-Retake-Nonce it is given with the proof that it holds the token
// (hex HMAC-SHA256 of the nonce, keyed by the token), so the host never sends the token or a command to a program that
// took the port first. POST /cmd needs the X-Retake-Token header (compared in constant time) and is queued for the
// main loop. A request whose Content-Length is not a length up to 1 MiB is refused. Request bodies are never logged.

import CryptoKit
import Foundation
import Network

/// A queued command: its JSON body and how to answer it.
struct Job {
    let body: Data
    let reply: (Data) -> Void
}

/// Commands handed from the listener's queue to the main loop; posting wakes the main run loop.
final class Inbox {
    private let lock = NSLock()
    private var jobs: [Job] = []
    private var lastPost = Date()
    private let runLoop = CFRunLoopGetMain()
    private let source: CFRunLoopSource

    init() {
        var context = CFRunLoopSourceContext()
        context.perform = { _ in }
        source = CFRunLoopSourceCreate(kCFAllocatorDefault, 0, &context)
        CFRunLoopAddSource(runLoop, source, .commonModes)
    }

    deinit {
        CFRunLoopRemoveSource(runLoop, source, .commonModes)
    }

    func post(_ job: Job) {
        lock.lock()
        jobs.append(job)
        lastPost = Date()
        lock.unlock()
        CFRunLoopSourceSignal(source)
        CFRunLoopWakeUp(runLoop)
    }

    func next() -> Job? {
        lock.lock()
        defer { lock.unlock() }
        return jobs.isEmpty ? nil : jobs.removeFirst()
    }

    /// When the last command arrived.
    var lastCommand: Date {
        lock.lock()
        defer { lock.unlock() }
        return lastPost
    }
}

enum ServerError: Error {
    case listenerFailed(String)
}

final class Server {
    private static let maxRequest = 1 << 20
    private let listener: NWListener
    private let queue = DispatchQueue(label: "retake.driver.server")
    private let token: [UInt8]
    private let inbox: Inbox

    init(port: UInt16, token: String, inbox: Inbox) throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = false
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
        self.token = Array(token.utf8)
        self.inbox = inbox
    }

    /// Starts listening; returns once the listener is ready, throws when it cannot bind.
    func start() throws {
        let ready = DispatchSemaphore(value: 0)
        var failure: String?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let error):
                failure = "\(error)"
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + 10) == .timedOut {
            failure = "not ready after 10 s"
        }
        if let failure {
            // The host side reads this line from the xcodebuild log and retries on another port.
            print("retake-driver: listener failed: \(failure)")
            listener.cancel()
            throw ServerError.listenerFailed(failure)
        }
        print("retake-driver: listening")
    }

    func stop() {
        listener.cancel()
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if buffer.count > Self.maxRequest {
                self.send(connection, status: 413, body: Self.error("request too large"))
                return
            }
            switch HttpRequest.parse(buffer, maxBody: Self.maxRequest) {
            case .request(let request):
                self.handle(request, on: connection)
            case .invalid:
                self.send(connection, status: 400, body: Self.error("bad request"))
            case .incomplete where complete || error != nil:
                connection.cancel()
            case .incomplete:
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private func handle(_ request: HttpRequest, on connection: NWConnection) {
        switch (request.method, request.path) {
        case ("GET", "/status"):
            var answer: [String: Any] = ["ok": true]
            if let nonce = request.headers["x-retake-nonce"], !nonce.isEmpty, nonce.utf8.count <= 128 {
                answer["proof"] = proof(nonce)
            }
            send(connection, status: 200, body: (try? JSONSerialization.data(withJSONObject: answer)) ?? Data())
        case ("POST", "/cmd"):
            guard authorised(request.headers["x-retake-token"]) else {
                send(connection, status: 403, body: Self.error("forbidden"))
                return
            }
            inbox.post(Job(body: request.body) { [weak self] reply in
                self?.queue.async { self?.send(connection, status: 200, body: reply) }
            })
        default:
            send(connection, status: 404, body: Self.error("not found"))
        }
    }

    /// Hex HMAC-SHA256 of the nonce, keyed by the token.
    private func proof(_ nonce: String) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: SymmetricKey(data: Data(token)))
        return code.map { String(format: "%02x", $0) }.joined()
    }

    /// Constant-time comparison: the time taken does not depend on where the tokens differ.
    private func authorised(_ given: String?) -> Bool {
        let given = Array((given ?? "").utf8)
        var diff = UInt8(given.count == token.count ? 0 : 1)
        for index in 0..<token.count {
            diff |= token[index] ^ (index < given.count ? given[index] : 0)
        }
        return diff == 0
    }

    private func send(_ connection: NWConnection, status: Int, body: Data) {
        let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large"][status] ?? "Error"
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var data = Data(head.utf8)
        data.append(body)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }

    static func error(_ message: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": message])) ?? Data()
    }
}

/// What the bytes received so far make: a request, more needed, or never a request.
enum Parsed {
    case request(HttpRequest)
    case incomplete
    case invalid
}

struct HttpRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    /// A complete request from the bytes received so far; `.incomplete` while more are needed, `.invalid` for a head
    /// that is not one or a Content-Length that is not a length up to `maxBody`.
    static func parse(_ buffer: Data, maxBody: Int) -> Parsed {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
        guard let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return .invalid }
        let lines = head.components(separatedBy: "\r\n")
        let start = lines[0].split(separator: " ")
        guard start.count >= 2 else { return .invalid }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard let length = Int(headers["content-length"] ?? "0"), length >= 0, length <= maxBody else { return .invalid }
        let bodyStart = end.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= length else { return .incomplete }
        let body = buffer[bodyStart..<(bodyStart + length)]
        return .request(HttpRequest(method: String(start[0]), path: String(start[1]), headers: headers, body: Data(body)))
    }
}
