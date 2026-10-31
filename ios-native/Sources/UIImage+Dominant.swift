import UIKit

extension UIImage {
    /// Teinte dominante de l'image, pour le halo derrière la pochette.
    ///
    /// On réduit l'image à UN pixel : c'est une moyenne, exactement ce qu'on veut pour un halo, et
    /// ça coûte quelques microsecondes (contrairement à un échantillonnage complet).
    var dominantColor: UIColor {
        var pixel: [UInt8] = [0, 0, 0, 0]
        let space = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return UIColor(red: 0.831, green: 0.667, blue: 0.314, alpha: 1) }

        context.draw(cgImage ?? CIImage(image: self).flatMap { CIContext().createCGImage($0, from: $0.extent) } ?? cgImage!, in: CGRect(x: 0, y: 0, width: 1, height: 1))

        // Un gris très sombre ne fait pas un beau halo : on retombe sur l'or de la DA.
        let red = CGFloat(pixel[0]) / 255
        let green = CGFloat(pixel[1]) / 255
        let blue = CGFloat(pixel[2]) / 255
        let brightest = max(red, max(green, blue))
        if brightest < 0.18 {
            return UIColor(red: 0.831, green: 0.667, blue: 0.314, alpha: 1)
        }
        // On ravive un peu : une moyenne de pochette est toujours terne.
        return UIColor(
            red: min(1, red * 1.25),
            green: min(1, green * 1.25),
            blue: min(1, blue * 1.25),
            alpha: 1
        )
    }
}
