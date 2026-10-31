import SwiftUI
import UIKit

/// Mise en page calculée d'après l'écran réel de l'appareil.
///
/// Sur un iPhone SE, deux colonnes de pochettes suffisent ; sur un Pro Max ou un iPad, trois ou
/// quatre. On ne devine pas : on lit la largeur utile et on en déduit le nombre de colonnes, comme
/// le fait la grille du bureau (`adaptiveMinTile`).
struct DeviceLayout {
    let screenWidth: CGFloat
    let screenHeight: CGFloat
    let scale: CGFloat

    static var current: DeviceLayout {
        let bounds = UIScreen.main.bounds
        return DeviceLayout(screenWidth: bounds.width, screenHeight: bounds.height, scale: UIScreen.main.scale)
    }

    /// Nom lisible de l'appareil (« iPhone 13 mini », « iPad »…) — affiché dans les Réglages.
    var deviceName: String {
        var system = utsname()
        uname(&system)
        let identifier = withUnsafePointer(to: &system.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 32) { String(cString: $0) }
        }
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: return "iPad (\(identifier))"
        default: break
        }
        if identifier.hasPrefix("iPhone") || identifier.hasPrefix("iPad") {
            return identifier // simulateur
        }
        return "iPhone \(formatted(size: screenWidth))"
    }

    /// Taille approximative en pouces, utile pour l'affichage.
    private func formatted(size: CGFloat) -> String {
        switch size {
        case ..<340: return "SE"
        case ..<400: return "mini"
        case ..<430: return "standard"
        default: return "Pro Max"
        }
    }

    /// Colonnes de la grille : 2 sur petit écran, 3 au-delà de 400 pt, 4 sur iPad.
    var gridColumns: Int {
        let idiom = UIDevice.current.userInterfaceIdiom
        if idiom == .pad { return screenWidth > 900 ? 5 : 4 }
        if screenWidth >= 430 { return 3 }
        if screenWidth >= 390 { return 3 }
        return 2
    }

    /// Espacement et rayon : plus serré sur un petit écran, plus généreux ailleurs.
    var gridSpacing: CGFloat { screenWidth < 390 ? 12 : 16 }
    var tileRadius: CGFloat { screenWidth < 390 ? 10 : 14 }
    var pagePadding: CGFloat { screenWidth < 390 ? 14 : 18 }
}

extension DeviceLayout {
    /// Colonnes prêtes pour `LazyVGrid`.
    var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: gridSpacing), count: gridColumns)
    }
}
