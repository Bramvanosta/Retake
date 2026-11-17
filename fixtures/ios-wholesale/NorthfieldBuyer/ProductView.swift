// A coffee's detail: origin, tasting notes, a quantity stepper and "Add to quote".

import SwiftUI

struct ProductView: View {
    @EnvironmentObject private var store: QuoteStore
    let product: Product
    @State private var kilograms = 5
    @State private var added = false

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(product.name).font(.title2.bold()).accessibilityIdentifier("product-name")
                    Text("\(product.origin) · \(product.process)").foregroundStyle(.secondary)
                    Text(product.notes.joined(separator: " · ")).font(.subheadline)
                        .accessibilityIdentifier("product-notes")
                }
                .padding(.vertical, 4)
                LabeledContent("Lot", value: product.sku).accessibilityIdentifier("product-sku")
                LabeledContent("Price", value: Catalogue.euros(product.pricePerKg) + " per kg")
                    .accessibilityIdentifier("product-price")
            }
            Section("Quantity") {
                Stepper(value: $kilograms, in: 5...200, step: 5) {
                    Text("\(kilograms) kg").monospacedDigit()
                }
                .accessibilityIdentifier("quantity-stepper")
                LabeledContent("Line total", value: Catalogue.euros(product.pricePerKg * Double(kilograms)))
                    .accessibilityIdentifier("line-total")
            }
            Section {
                Button {
                    store.add(product, kilograms: kilograms)
                    added = true
                } label: {
                    Text("Add to quote").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("add-to-quote")
                if added {
                    Text("Added to your quote").foregroundStyle(.green).accessibilityIdentifier("added-banner")
                }
            }
        }
        .navigationTitle(product.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
