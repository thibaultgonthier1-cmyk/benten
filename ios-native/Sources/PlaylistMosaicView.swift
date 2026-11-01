import SwiftUI

/// Pochette de playlist en MOSAÏQUE de 4 albums, comme Apple Music.
///
/// Constat du REA sur l'app Apple Music installée : une playlist n'affiche pas la pochette de son
/// premier morceau, mais une mosaïque 2×2 des pochettes qu'elle contient. C'est plus lisible — une
/// playlist se reconnaît à son mélange, pas à son premier titre — et c'est ce que fait déjà la
/// version PC de Benten (`PlaylistMosaic`).
///
/// Règles d'Apple conservées telles quelles :
/// - 1 pochette → plein cadre ;
/// - 2 → moitié gauche / moitié droite ;
/// - 3 ou 4 → grille 2×2 ; la quatrième case manquante est comblée par la première.
struct PlaylistMosaicView: View {
    let tracks: [Track]
    var cornerRadius: CGFloat = 9

    /// Jusqu'à 4 pochettes DISTINCTES : quatre morceaux du même album ne font pas une mosaïque.
    private var covers: [Track] {
        var seen = Set<String>()
        var result: [Track] = []
        for track in tracks where track.artworkURL != nil {
            let key = track.album + "||" + track.artist
            if seen.insert(key).inserted {
                result.append(track)
                if result.count == 4 { break }
            }
        }
        return result
    }

    var body: some View {
        ZStack {
            Theme.ink3

            switch covers.count {
            case 0:
                Image(systemName: "music.note.list")
                    .font(.system(size: 18))
                    .foregroundStyle(Theme.dim)

            case 1:
                ArtworkView(track: covers[0])

            case 2:
                HStack(spacing: 0) {
                    ArtworkView(track: covers[0])
                    ArtworkView(track: covers[1])
                }

            default:
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        ArtworkView(track: covers[0])
                        ArtworkView(track: covers[1])
                    }
                    HStack(spacing: 0) {
                        ArtworkView(track: covers[2])
                        // La case manquante reprend la première : sans elle, la mosaïque aurait un
                        // trou noir qui attire l'œil plus que les pochettes.
                        ArtworkView(track: covers.count > 3 ? covers[3] : covers[0])
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}
