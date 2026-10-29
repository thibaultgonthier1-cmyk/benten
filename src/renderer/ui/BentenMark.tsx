/**
 * Mark Benten : torii affiné (kasagi aux extrémités relevées) devant un soleil magenta — le dessin
 * validé de l'intro v2, simplifié pour les petites tailles. Purement vectoriel, sans texte.
 */
export interface BentenMarkProps {
  size?: number;
  /** Titre accessible ; sans lui, le mark est décoratif (`aria-hidden`). */
  title?: string;
  className?: string;
}

export function BentenMark({ size = 32, title, className }: BentenMarkProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
    >
      {/* Soleil */}
      <circle cx="24" cy="23.5" r="15" fill="var(--accent, #e73c82)" />
      <g stroke="#f4f4f6" strokeLinecap="round">
        {/* Kasagi : poutre haute, extrémités relevées */}
        <path d="M5 12.2 Q24 15.8 43 12.2" strokeWidth="3.2" />
        {/* Shimaki (sous-poutre) */}
        <path d="M11 16.6 H37" strokeWidth="1.6" />
        {/* Nuki (traverse) */}
        <path d="M10 24 H38" strokeWidth="2.1" />
        {/* Piliers, très légèrement évasés */}
        <path d="M15.2 15.6 L14.4 42" strokeWidth="2.7" />
        <path d="M32.8 15.6 L33.6 42" strokeWidth="2.7" />
      </g>
    </svg>
  );
}
