// Northfield Buyer: the invented iOS fixture app the iOS runner films (a café orders green coffee from a roaster).

import SwiftUI

@main
struct NorthfieldBuyerApp: App {
    @StateObject private var store = QuoteStore()

    var body: some Scene {
        WindowGroup {
            CatalogueView()
                .environmentObject(store)
                .onOpenURL { store.open($0) }
                .fullScreenCover(isPresented: $store.showingCalibration) {
                    CalibrationView { store.showingCalibration = false }
                }
        }
    }
}
