// The catalogue: a searchable list of coffees, a quote button in the toolbar.

import SwiftUI

struct CatalogueView: View {
    @EnvironmentObject private var store: QuoteStore
    @State private var search = ""

    private var shown: [Product] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return Catalogue.products }
        return Catalogue.products.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.origin.localizedCaseInsensitiveContains(query)
                || $0.notes.contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        NavigationStack(path: $store.path) {
            List(shown) { product in
                NavigationLink(value: product) {
                    ProductRow(product: product)
                }
                .accessibilityIdentifier("product-row-\(product.sku)")
            }
            .listStyle(.plain)
            .accessibilityIdentifier("catalogue-list")
            .overlay {
                if shown.isEmpty {
                    Text("No coffee matches “\(search)”")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("catalogue-empty")
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search coffees")
            .navigationTitle("Catalogue")
            .navigationDestination(for: Product.self) { ProductView(product: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.showingQuote = true
                    } label: {
                        Label("Quote (\(store.lines.count))", systemImage: "doc.text")
                            .labelStyle(.titleAndIcon)
                    }
                    .accessibilityIdentifier("open-quote")
                }
            }
        }
        .sheet(isPresented: $store.showingQuote) {
            QuoteView().environmentObject(store)
        }
    }
}

struct ProductRow: View {
    let product: Product

    /// A stable colour per product (String.hashValue changes between launches).
    private var hue: Double {
        Double(product.sku.unicodeScalars.reduce(0) { ($0 * 31 + Int($1.value)) % 360 }) / 360
    }

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(hue: hue, saturation: 0.35, brightness: 0.55))
                .frame(width: 44, height: 44)
                .overlay(Text(String(product.origin.prefix(2)).uppercased()).font(.caption.bold()).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 2) {
                Text(product.name).font(.body.weight(.medium))
                Text("\(product.origin) · \(product.process)").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Text(Catalogue.euros(product.pricePerKg) + "/kg").font(.subheadline.monospacedDigit())
        }
        .padding(.vertical, 4)
    }
}
