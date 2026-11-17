// The driver's operations. Each takes a JSON object {op, …} and answers {ok, t_begin, t_end, …}; t_begin / t_end
// are wall-clock epoch milliseconds (the simulator shares the host's clock), t_act is taken right before the touch.
// Coordinates and frames are in screen points. Nothing here logs a command's payload or an element's text.

import XCTest

enum CommandError: Error {
    case invalid(String)
    case failed(String)
    case expired
}

final class Commands {
    private(set) var finished = false
    private var app: XCUIApplication?

    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    func run(_ body: Data) -> Data {
        let begin = Commands.now()
        var reply: [String: Any]
        do {
            guard let json = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let op = json["op"] as? String else {
                throw CommandError.invalid("the body must be a JSON object with an op")
            }
            // The host gave up on a command it reaches past its deadline: it is dropped, not played late.
            if let deadline = json["deadline_ms"] as? Double, begin > deadline {
                throw CommandError.expired
            }
            reply = try perform(op, json)
            reply["ok"] = true
        } catch CommandError.invalid(let message) {
            reply = ["ok": false, "error": message, "code": "invalid"]
        } catch CommandError.failed(let message) {
            reply = ["ok": false, "error": message, "code": "failed"]
        } catch CommandError.expired {
            reply = ["ok": false, "error": "dropped: it arrived past its deadline", "code": "expired"]
        } catch {
            reply = ["ok": false, "error": "malformed JSON", "code": "invalid"]
        }
        reply["t_begin"] = begin
        reply["t_end"] = Commands.now()
        return (try? JSONSerialization.data(withJSONObject: reply)) ?? Server.error("unencodable reply")
    }

    private func perform(_ op: String, _ json: [String: Any]) throws -> [String: Any] {
        switch op {
        case "launch": return try launch(json)
        case "terminate":
            try target().terminate()
            return [:]
        case "activate":
            try target().activate()
            return ["state": Commands.stateName(try target().state)]
        case "state": return ["state": Commands.stateName(app?.state ?? .unknown)]
        case "ping": return [:]
        case "open": return try open(json)
        case "find": return try find(json)
        case "tap": return try tap(json)
        case "swipe": return try swipe(json)
        case "type": return try type(json)
        case "key": return try key(json)
        case "tree":
            let limit = json["limit"] as? Int ?? 65536
            return ["tree": String(try target().debugDescription.prefix(max(0, limit)))]
        case "quit":
            finished = true
            return [:]
        default:
            throw CommandError.invalid("unknown op")
        }
    }

    private func target() throws -> XCUIApplication {
        guard let app else { throw CommandError.failed("no app launched") }
        return app
    }

    private func launch(_ json: [String: Any]) throws -> [String: Any] {
        guard let bundleId = json["bundleId"] as? String, !bundleId.isEmpty else {
            throw CommandError.invalid("launch needs a bundleId")
        }
        let next = XCUIApplication(bundleIdentifier: bundleId)
        next.launchArguments = json["args"] as? [String] ?? []
        next.launchEnvironment = json["env"] as? [String: String] ?? [:]
        next.launch()
        app = next
        return ["state": Commands.stateName(next.state)]
    }

    /// Opens a URL in the launched app (XCUIApplication.open: no "Open in …?" system prompt, unlike simctl openurl).
    private func open(_ json: [String: Any]) throws -> [String: Any] {
        guard let text = json["url"] as? String, let url = URL(string: text), url.scheme != nil else {
            throw CommandError.invalid("open needs a url")
        }
        let app = try target()
        app.open(url)
        return ["state": Commands.stateName(app.state)]
    }

    private func find(_ json: [String: Any]) throws -> [String: Any] {
        let query = try Query(try object(json, "query"))
        let timeout = Double(json["timeout_ms"] as? Int ?? 0) / 1000
        let element = query.resolve(in: try target(), timeout: timeout)
        return Commands.describe(element)
    }

    private func tap(_ json: [String: Any]) throws -> [String: Any] {
        let app = try target()
        let duration = Double(json["duration_ms"] as? Int ?? 0) / 1000
        var point: CGPoint
        var found: [String: Any] = [:]
        if let queryJson = json["query"] as? [String: Any] {
            let element = try Query(queryJson).resolve(in: app, timeout: Double(json["timeout_ms"] as? Int ?? 0) / 1000)
            guard element.exists else { throw CommandError.failed("no element matches the query") }
            let frame = element.frame
            point = CGPoint(x: frame.midX, y: frame.midY)
            found = Commands.describe(element)
        } else {
            point = CGPoint(x: try number(json, "x"), y: try number(json, "y"))
        }
        let coordinate = origin(of: app, via: json["via"] as? String).withOffset(CGVector(dx: point.x, dy: point.y))
        let act = Commands.now()
        if duration > 0 {
            coordinate.press(forDuration: duration)
        } else {
            coordinate.tap()
        }
        found["t_act"] = act
        found["point"] = ["x": point.x, "y": point.y]
        return found
    }

    private func swipe(_ json: [String: Any]) throws -> [String: Any] {
        let app = try target()
        let from = try object(json, "from")
        let to = try object(json, "to")
        let base = origin(of: app, via: json["via"] as? String)
        let a = CGPoint(x: try number(from, "x"), y: try number(from, "y"))
        let b = CGPoint(x: try number(to, "x"), y: try number(to, "y"))
        let start = base.withOffset(CGVector(dx: a.x, dy: a.y))
        let end = base.withOffset(CGVector(dx: b.x, dy: b.y))
        let press = Double(json["press_ms"] as? Int ?? 50) / 1000
        let hold = Double(json["hold_ms"] as? Int ?? 0) / 1000
        // duration_ms is the drag's length in time; XCUITest takes a velocity (points per second) instead.
        let distance = hypot(b.x - a.x, b.y - a.y)
        let drag = max(0.05, Double(json["duration_ms"] as? Int ?? 300) / 1000)
        let velocity = XCUIGestureVelocity(max(1, distance / drag))
        let act = Commands.now()
        start.press(forDuration: press, thenDragTo: end, withVelocity: velocity, thenHoldForDuration: hold)
        return ["t_act": act]
    }

    private func type(_ json: [String: Any]) throws -> [String: Any] {
        guard let text = json["text"] as? String else { throw CommandError.invalid("type needs a text") }
        let app = try target()
        if json["per_char"] as? Bool ?? false {
            var times: [Double] = []
            for character in text {
                app.typeText(String(character))
                times.append(Commands.now())
            }
            return ["char_t_end": times]
        }
        app.typeText(text)
        return [:]
    }

    private func key(_ json: [String: Any]) throws -> [String: Any] {
        let keys: [String: String] = ["return": "\n", "delete": XCUIKeyboardKey.delete.rawValue]
        guard let name = json["name"] as? String, let key = keys[name] else {
            throw CommandError.invalid("key must be return or delete")
        }
        let times = max(1, json["times"] as? Int ?? 1)
        try target().typeText(String(repeating: key, count: times))
        return [:]
    }

    /// The point (0, 0) of the screen; "springboard" synthesises the touch through the home screen's process.
    private func origin(of app: XCUIApplication, via: String?) -> XCUICoordinate {
        let base = via == "springboard" ? XCUIApplication(bundleIdentifier: "com.apple.springboard") : app
        return base.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    }

    private func object(_ json: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = json[key] as? [String: Any] else { throw CommandError.invalid("\(key) must be an object") }
        return value
    }

    private func number(_ json: [String: Any], _ key: String) throws -> Double {
        guard let value = json[key] as? NSNumber else { throw CommandError.invalid("\(key) must be a number") }
        return value.doubleValue
    }

    static func describe(_ element: XCUIElement) -> [String: Any] {
        guard element.exists else { return ["exists": false, "hittable": false] }
        let frame = element.frame
        return [
            "exists": true,
            "hittable": element.isHittable,
            "frame": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.size.width, "h": frame.size.height],
            "label": element.label,
            "value": (element.value as? String) ?? (element.value.map { "\($0)" } ?? ""),
            "placeholder": element.placeholderValue ?? "",
            "type": typeName(element.elementType),
        ]
    }

    static func typeName(_ type: XCUIElement.ElementType) -> String {
        if let name = Query.roles.first(where: { $0.value == type })?.key { return name }
        let others: [XCUIElement.ElementType: String] = [
            .other: "other", .image: "image", .link: "link", .navigationBar: "navigationBar",
            .tabBar: "tabBar", .table: "table", .collectionView: "collectionView", .scrollView: "scrollView",
            .window: "window", .application: "application", .stepper: "stepper",
            .keyboard: "keyboard", .key: "key", .alert: "alert", .sheet: "sheet", .toolbar: "toolbar",
        ]
        return others[type] ?? "type\(type.rawValue)"
    }

    static func stateName(_ state: XCUIApplication.State) -> String {
        switch state {
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "runningBackgroundSuspended"
        case .runningBackground: return "runningBackground"
        case .runningForeground: return "runningForeground"
        default: return "unknown"
        }
    }
}
