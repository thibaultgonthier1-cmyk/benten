import CoreImage
import UIKit

extension UIImage {
    /// Teinte dominante de l'image, pour le halo derrière la pochette.
    ///
    /// Vraie moyenne (16 échantillons lissés) au lieu d'un dessin dans UN pixel : un dessin 1 × 1
    /// ne lit que quelques points de l'image et la teinte changeait d'une taille de vignette à
    /// l'autre. Quelques microsecondes, appelable hors du fil principal.
    var dominantColor: UIColor {
        let gold = UIColor(red: 0.831, green: 0.667, blue: 0.314, alpha: 1)
        guard let average = regionColors(columns: 1, rows: 1)?.first else { return gold }
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard average.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return gold }

        // Un gris très sombre ne fait pas un beau halo : on retombe sur l'or de la DA.
        let brightest = max(red, max(green, blue))
        if brightest < 0.18 { return gold }
        // On ravive un peu : une moyenne de pochette est toujours terne.
        return UIColor(red: min(1, red * 1.25), green: min(1, green * 1.25), blue: min(1, blue * 1.25), alpha: 1)
    }

    /// Couleurs MOYENNES de chaque zone de l'image, découpée en `columns` × `rows` (ligne par
    /// ligne, de haut en bas, de gauche à droite). Sert au fond du lecteur : la couleur du haut de
    /// la pochette se prolonge en haut de l'écran, celle du bas en bas, etc.
    ///
    /// L'image est réduite à 4 × 4 points par zone (lissage haute qualité), puis chaque bloc est
    /// moyenné : stable, sans dépendre d'un pixel isolé. Sans état partagé : appelable hors du fil
    /// principal.
    func regionColors(columns: Int, rows: Int) -> [UIColor]? {
        guard columns > 0, rows > 0 else { return nil }
        let candidate: CGImage? = cgImage ?? ciImage.flatMap { CIContext().createCGImage($0, from: $0.extent) }
        guard let source = candidate else { return nil }

        let samples = 4
        let width = columns * samples
        let height = rows * samples
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .high
            context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }

        // Mémoire du contexte : la première ligne est le HAUT de l'image.
        var colors: [UIColor] = []
        colors.reserveCapacity(columns * rows)
        let count = CGFloat(samples * samples) * 255
        for row in 0..<rows {
            for column in 0..<columns {
                var red = 0, green = 0, blue = 0
                for y in (row * samples)..<(row * samples + samples) {
                    for x in (column * samples)..<(column * samples + samples) {
                        let index = (y * width + x) * 4
                        red += Int(pixels[index])
                        green += Int(pixels[index + 1])
                        blue += Int(pixels[index + 2])
                    }
                }
                colors.append(UIColor(red: CGFloat(red) / count, green: CGFloat(green) / count,
                                      blue: CGFloat(blue) / count, alpha: 1))
            }
        }
        return colors
    }
}

extension UIColor {
    /// Version plus vive (saturation ×`saturation`) et plafonnée en luminosité : une couleur de
    /// fond ne doit jamais éblouir ni rendre le texte blanc illisible.
    func vivid(saturation boost: CGFloat = 1.2, maxBrightness: CGFloat = 0.9) -> UIColor {
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        guard getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return self }
        return UIColor(hue: hue, saturation: min(1, saturation * boost),
                       brightness: min(maxBrightness, brightness), alpha: 1)
    }

    /// Même teinte, assombrie (`factor` < 1).
    func darkened(_ factor: CGFloat) -> UIColor {
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        guard getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return self }
        return UIColor(hue: hue, saturation: saturation, brightness: brightness * factor, alpha: 1)
    }
}
