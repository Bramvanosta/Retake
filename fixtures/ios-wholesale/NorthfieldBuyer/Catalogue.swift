// The invented catalogue of the fixture app, taken from fixtures/wholesale's seed (server/seed.mjs).
// Every name here is fictional. Prices are per kg for 5 kg bags, in EUR.

import Foundation

struct Product: Identifiable, Hashable {
    let sku: String
    let name: String
    let origin: String
    let process: String
    let notes: [String]
    let pricePerKg: Double

    var id: String { sku }
}

enum Catalogue {
    static let products: [Product] = [
        Product(sku: "NF-26-014", name: "Finca Lirandel — Geisha", origin: "Colombia", process: "Anaerobic washed",
                notes: ["Jasmine", "Bergamot", "White peach"], pricePerKg: 79.5),
        Product(sku: "NF-26-031", name: "Mountfern AA", origin: "Kenya", process: "Washed, double fermentation",
                notes: ["Blackcurrant", "Pink grapefruit", "Cane sugar"], pricePerKg: 34.2),
        Product(sku: "NF-26-029", name: "Selowa Ridge", origin: "Ethiopia", process: "Washed",
                notes: ["Bergamot", "Lemon blossom", "Honey"], pricePerKg: 36.4),
        Product(sku: "NF-26-008", name: "Finca Neblivar — Gesha Natural", origin: "Panama", process: "Natural",
                notes: ["Mango", "Jasmine", "Passion fruit"], pricePerKg: 72.0),
        Product(sku: "NF-26-027", name: "Wendaro — Natural", origin: "Ethiopia", process: "Natural",
                notes: ["Strawberry", "Blueberry", "Dark chocolate"], pricePerKg: 33.8),
        Product(sku: "NF-26-011", name: "Fazenda Corvelha — Yellow Bourbon", origin: "Brazil", process: "Natural",
                notes: ["Milk chocolate", "Hazelnut", "Dried apricot"], pricePerKg: 24.6),
        Product(sku: "NF-26-019", name: "Finca Tzunavel — Caturra", origin: "Guatemala", process: "Washed",
                notes: ["Red grape", "Brown sugar", "Orange zest"], pricePerKg: 27.9),
        Product(sku: "NF-26-024", name: "Orvane Lot 7", origin: "Rwanda", process: "Washed",
                notes: ["Red currant", "Black tea", "Molasses"], pricePerKg: 29.4),
        Product(sku: "NF-26-016", name: "Hacienda Velmora — Pacamara", origin: "El Salvador", process: "Red honey",
                notes: ["Plum", "Cocoa", "Caramel"], pricePerKg: 31.5),
        Product(sku: "NF-26-033", name: "Tembralo Peaberry", origin: "Kenya", process: "Washed",
                notes: ["Hibiscus", "Red plum", "Lime"], pricePerKg: 30.6),
        Product(sku: "NF-26-005", name: "Highplain Lot 21", origin: "Brazil", process: "Pulped natural",
                notes: ["Cocoa", "Roasted almond", "Orange"], pricePerKg: 21.9),
        Product(sku: "NF-26-022", name: "Rumavelo Hills — Natural", origin: "Burundi", process: "Natural",
                notes: ["Raspberry", "Cola", "Tamarind"], pricePerKg: 30.2),
        Product(sku: "NF-26-013", name: "Pelantar Highlands — Wet hulled", origin: "Indonesia", process: "Wet hulled",
                notes: ["Cedar", "Dark cocoa", "Black pepper"], pricePerKg: 26.4),
    ]

    static func product(sku: String) -> Product? {
        products.first { $0.sku.caseInsensitiveCompare(sku) == .orderedSame }
    }

    static func euros(_ value: Double) -> String {
        String(format: "€%.2f", value)
    }
}
