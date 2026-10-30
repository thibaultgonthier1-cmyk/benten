import type { ReactNode } from "react";
import { CircleAlert, RotateCw, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { ICON_STROKE } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { assetUrl, type AssetId } from "../assets/manifest";

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
  art,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  action?: ReactNode;
  /**
   * Illustration DA « Biwa & Or » (peinture encre et or). Remplacée par l'icône quand la
   * ressource n'est pas embarquée : le repli dessiné en code reste la règle.
   */
  art?: AssetId;
}): JSX.Element {
  const artUrl = art ? assetUrl(art) : null;
  return (
    <div className="page-empty">
      {artUrl ? (
        <img className="page-empty-art" src={artUrl} alt="" aria-hidden="true" decoding="async" />
      ) : (
        <span className="page-empty-icon" aria-hidden="true">
          <Icon size={24} strokeWidth={ICON_STROKE} />
        </span>
      )}
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

/**
 * Échec de lecture (IPC) : état d'ERREUR explicite avec « Réessayer » — jamais un état vide ni
 * « Aucun résultat » qui ferait croire à une absence de données.
 */
export function ErrorState({
  title,
  text,
  onRetry,
}: {
  title: string;
  text: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="page-empty is-error" role="alert">
      <span className="page-empty-icon" aria-hidden="true">
        <CircleAlert size={24} strokeWidth={ICON_STROKE} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {onRetry && (
        <Button variant="ghost" icon={RotateCw} onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}


