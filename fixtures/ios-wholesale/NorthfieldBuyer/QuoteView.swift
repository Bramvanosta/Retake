// The quote sheet: the lines, a notes field, "Send request", then the confirmation.

import SwiftUI

struct QuoteView: View {
    @EnvironmentObject private var store: QuoteStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let reference = store.sentReference {
                    ConfirmationView(reference: reference) {
                        store.sentReference = nil
                        dismiss()
                    }
                } else {
                    form
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }.accessibilityIdentifier("close-quote")
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section("Lines") {
                if store.lines.isEmpty {
                    Text("No coffee in this quote yet").foregroundStyle(.secondary)
                        .accessibilityIdentifier("quote-empty")
                }
                ForEach(store.lines) { line in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(line.product.name)
                            Text("\(line.kilograms) kg × \(Catalogue.euros(line.product.pricePerKg))")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(Catalogue.euros(line.total)).monospacedDigit()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("quote-line-\(line.product.sku)")
                }
                .onDelete { offsets in offsets.map { store.lines[$0] }.forEach(store.remove) }
                if !store.lines.isEmpty {
                    LabeledContent("Total", value: Catalogue.euros(store.total)).font(.headline)
                        .accessibilityIdentifier("quote-total")
                }
            }
            Section("Notes for the roaster") {
                TextField("Delivery window, grind, labels…", text: $store.notes, axis: .vertical)
                    .lineLimit(3...6)
                    .accessibilityIdentifier("quote-notes")
            }
            Section {
                Button {
                    store.send()
                } label: {
                    Text("Send request").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.lines.isEmpty)
                .accessibilityIdentifier("send-request")
            }
        }
        .navigationTitle("Quote request")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ConfirmationView: View {
    let reference: String
    let done: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
            Text("Request sent").font(.title.bold()).accessibilityIdentifier("confirmation-title")
            Text("The roaster answers within one working day. Reference \(reference).")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
                .accessibilityIdentifier("confirmation-reference")
            Button("Back to the catalogue", action: done)
                .buttonStyle(.bordered)
                .accessibilityIdentifier("confirmation-done")
        }
        .padding(32)
        .navigationTitle("Quote request")
        .navigationBarTitleDisplayMode(.inline)
    }
}
