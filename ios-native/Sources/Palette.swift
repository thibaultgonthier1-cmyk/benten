import SwiftUI

/// Les six palettes de Benten, identiques à celles du bureau.
///
/// Le laque, l'encre et l'ivoire ne changent jamais : seule la teinte d'ACCENT bouge. C'est ce qui
/// garantit qu'aucune palette ne dégrade la lisibilité — même règle que sur le PC.
enum Palette: String, CaseIterable, Identifiable {
    case or, argent, indigo, jade, vermillon, brume

    var id: String { rawValue }

    var label: String {
        switch self {
        case .or: return "Or"
        case .argent: return "Argent"
        case .indigo: return "Indigo"
        case .jade: return "Jade"
        case .vermillon: return "Vermillon"
        case .brume: return "Brume"
        }
    }

    /// Couleur de référence, affichée dans le sélecteur.
    var swatch: Color { accent }

    var accent: Color {
        switch self {
        case .or: return Color(red: 0.831, green: 0.667, blue: 0.314)        // #D4AA50
        case .argent: return Color(red: 0.788, green: 0.812, blue: 0.839)     // #C9CFD6
        case .indigo: return Color(red: 0.435, green: 0.525, blue: 0.839)     // #6F86D6
        case .jade: return Color(red: 0.388, green: 0.788, blue: 0.627)       // #63C9A0
        case .vermillon: return Color(red: 0.878, green: 0.341, blue: 0.247)  // #E0573F
        case .brume: return Color(red: 0.725, green: 0.698, blue: 0.651)      // #B9B2A6
        }
    }

    var accentLight: Color {
        switch self {
        case .or: return Color(red: 0.941, green: 0.827, blue: 0.541)        // #F0D38A
        case .argent: return Color(red: 0.933, green: 0.949, blue: 0.965)     // #EEF2F6
        case .indigo: return Color(red: 0.659, green: 0.722, blue: 0.941)     // #A8B8F0
        case .jade: return Color(red: 0.612, green: 0.910, blue: 0.784)       // #9CE8C8
        case .vermillon: return Color(red: 0.961, green: 0.573, blue: 0.486)  // #F5927C
        case .brume: return Color(red: 0.890, green: 0.867, blue: 0.824)      // #E3DDD2
        }
    }

    var accentDeep: Color {
        switch self {
        case .or: return Color(red: 0.541, green: 0.392, blue: 0.125)        // #8A6420
        case .argent: return Color(red: 0.435, green: 0.459, blue: 0.486)     // #6F757C
        case .indigo: return Color(red: 0.235, green: 0.302, blue: 0.580)     // #3C4D94
        case .jade: return Color(red: 0.184, green: 0.490, blue: 0.369)       // #2F7D5E
        case .vermillon: return Color(red: 0.557, green: 0.165, blue: 0.102)  // #8E2A1A
        case .brume: return Color(red: 0.427, green: 0.404, blue: 0.365)      // #6D675D
        }
    }

    var gradient: LinearGradient {
        LinearGradient(colors: [accentLight, accent, accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
