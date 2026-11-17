// The buyer's quote being put together, and where the app is (catalogue path, open sheets).

import SwiftUI

struct QuoteLine: Identifiable, Hashable {
    let product: Product
    var kilograms: Int

    var id: String { product.sku }
    var total: Double { product.pricePerKg * Double(kilograms) }
}

@MainActor
final class QuoteStore: ObservableObject {
    @Published var lines: [QuoteLine] = []
    @Published var notes: String = ""
    @Published var path: [Product] = []
    @Published var showingQuote = false
    @Published var showingCalibration = false
    @Published var sentReference: String?

    private var sent = 0

    var total: Double { lines.reduce(0) { $0 + $1.total } }

    func add(_ product: Product, kilograms: Int) {
        if let index = lines.firstIndex(where: { $0.product == product }) {
            lines[index].kilograms += kilograms
        } else {
            lines.append(QuoteLine(product: product, kilograms: kilograms))
        }
    }

    func remove(_ line: QuoteLine) {
        lines.removeAll { $0.id == line.id }
    }

    func send() {
        sent += 1
        sentReference = String(format: "QR-2611-%03d", 40 + sent)
        lines = []
        notes = ""
    }

    /// Opens a deep link: northfield://product/<sku>, northfield://catalogue, northfield://quote, northfield://calibrate.
    func open(_ url: URL) {
        guard url.scheme?.lowercased() == "northfield" else { return }
        let parts = [url.host ?? ""] + url.pathComponents.filter { $0 != "/" }
        switch parts.first?.lowercased() {
        case "product":
            if parts.count > 1, let product = Catalogue.product(sku: parts[1]) {
                showingQuote = false
                showingCalibration = false
                path = [product]
            }
        case "catalogue":
            showingQuote = false
            showingCalibration = false
            path = []
        case "quote":
            showingCalibration = false
            showingQuote = true
        case "calibrate":
            showingQuote = false
            showingCalibration = true
        default:
            break
        }
    }
}
