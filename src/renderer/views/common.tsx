import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ICON_STROKE } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";

/** En-tête de page : sur-titre (mincho, accent), titre mincho, sous-titre en chiffres tabulaires. */
export function PageHeader({
  eyebrow,
  title,
  sub,
  aside,
}: {
  eyebrow?: string;
  title: string;
  sub?: string | null;
  /** Contrôles alignés à droite (tri, filtres). */
  aside?: ReactNode;
}): JSX.Element {
  return (
    <header className={`page-head${aside ? " has-aside" : ""}`}>
      <div className="page-head__text">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub num">{sub}</p> : null}
      </div>
      {aside ? <div className="page-head__aside">{aside}</div> : null}
    </header>
  );
}

/** État vide neutre (icône en pastille, titre mincho, texte, action optionnelle). */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="page-empty">
      <span className="page-empty-icon" aria-hidden="true">
        <Icon size={24} strokeWidth={ICON_STROKE} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** Grille de chargement : des pochettes fantômes au rythme de la vraie grille. */
export function GridSkeleton({ count = 12 }: { count?: number }): JSX.Element {
  return (
    <div className="grid-skel" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid-skel-card">
          <div className="grid-skel-art">
            <Skeleton h="100%" radius={12} />
          </div>
          <Skeleton w="72%" h={12} radius={6} />
          <Skeleton w="46%" h={10} radius={5} />
        </div>
      ))}
    </div>
  );
}
