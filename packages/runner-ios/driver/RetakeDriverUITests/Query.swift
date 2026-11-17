// Element queries: {text?, label?, id?, role?, roles?, placeholder?, exact?, nth?} → an XCUIElement of the app.
// role names an XCUIElement type, roles several (any of them matches): a SwiftUI .searchable field is a searchField,
// a multi-line TextField a textView;
// text matches the label or the value; without exact, an exact match is preferred, then a case-insensitive substring.

import XCTest

struct Query {
    let text: String?
    let label: String?
    let id: String?
    let types: [XCUIElement.ElementType]
    let placeholder: String?
    let exact: Bool
    let nth: Int?

    static let roles: [String: XCUIElement.ElementType] = [
        "button": .button,
        "textField": .textField,
        "searchField": .searchField,
        "textView": .textView,
        "secureTextField": .secureTextField,
        "staticText": .staticText,
        "cell": .cell,
        "switch": .switch,
    ]

    init(_ json: [String: Any]) throws {
        text = json["text"] as? String
        label = json["label"] as? String
        id = json["id"] as? String
        var names = json["roles"] as? [String] ?? []
        if let role = json["role"] as? String { names.append(role) }
        types = try names.map { name in
            guard let type = Query.roles[name] else { throw CommandError.invalid("unknown role") }
            return type
        }
        placeholder = json["placeholder"] as? String
        exact = json["exact"] as? Bool ?? false
        nth = json["nth"] as? Int
        if text == nil && label == nil && id == nil && types.isEmpty && placeholder == nil {
            throw CommandError.invalid("empty query")
        }
        if let nth, nth < 0 { throw CommandError.invalid("nth must be ≥ 0") }
    }

    /// The element for this query, with exact or substring matching.
    func element(in app: XCUIApplication, substring: Bool) -> XCUIElement {
        var matches = app.descendants(matching: types.count == 1 ? types[0] : .any)
        if types.count > 1 {
            let raw = types.map { NSNumber(value: $0.rawValue) }
            matches = matches.matching(NSPredicate(format: "elementType IN %@", raw))
        }
        for predicate in predicates(substring: substring) {
            matches = matches.matching(predicate)
        }
        if let nth { return matches.element(boundBy: nth) }
        return matches.firstMatch
    }

    private func predicates(substring: Bool) -> [NSPredicate] {
        var list: [NSPredicate] = []
        if let id { list.append(NSPredicate(format: "identifier == %@", id)) }
        let op = substring ? "CONTAINS[c]" : "=="
        if let label { list.append(NSPredicate(format: "label \(op) %@", label)) }
        if let text { list.append(NSPredicate(format: "label \(op) %@ OR value \(op) %@", text, text)) }
        if let placeholder { list.append(NSPredicate(format: "placeholderValue \(op) %@", placeholder)) }
        return list
    }

    /// Polls until the element exists or the timeout passes; returns the element (existing or not).
    func resolve(in app: XCUIApplication, timeout: TimeInterval) -> XCUIElement {
        let deadline = Date(timeIntervalSinceNow: timeout)
        let usesSubstring = !exact && (text != nil || label != nil || placeholder != nil)
        while true {
            let exactMatch = element(in: app, substring: false)
            if exactMatch.exists { return exactMatch }
            if usesSubstring {
                let loose = element(in: app, substring: true)
                if loose.exists { return loose }
            }
            if Date() >= deadline { return exactMatch }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
        }
    }
}
