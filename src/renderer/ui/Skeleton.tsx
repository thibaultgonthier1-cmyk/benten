import type { CSSProperties } from "react";
import "./ui.css";

export interface SkeletonProps {
  w?: number | string;
  h?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Bloc de chargement avec reflet (shimmer) : un dégradé qui glisse en `transform` uniquement.
 * Le reflet est figé en mouvement réduit (réglage ou préférence système), cf. ui.css.
 */
export function Skeleton({ w = "100%", h = 14, radius = 8, className, style }: SkeletonProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`ui-skel${className ? ` ${className}` : ""}`}
      style={{ width: w, height: h, borderRadius: radius, ...style }}
    />
  );
}
