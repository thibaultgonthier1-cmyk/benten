import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Check, ChevronDown, Clock3, Layers2, Music } from "lucide-react";
import type { TrackRow } from "../../shared/types";
import type { Album } from "../lib/library";
import {
  canResume,
  groupVersions,
  selectionAfterClick,
  sortTracks,
  versionName,
  versionRows,
  type TrackSortKey,
  type VersionGroup,
  type VersionRow,
} from "../lib/viewModels";
import { useLibrary } from "../state/library";
import { playerStore, usePlayer } from "../state/player";
import { settingsStore, useSettings } from "../state/settings";
import { uiStore, useUi } from "../state/ui";
import type { RouteViewActions } from "../shell/RouteView";
import { plannedScroll } from "../shell/scrollMemory";
import { dur } from "../theme/ds/motion";
import { ICON_STROKE } from "../ui/IconButton";
import { openMenu } from "../ui/menuStore";
import { Skeleton } from "../ui/Skeleton";
import { TrackRowItem } from "../ui/TrackRowItem";
import { useMotion } from "../ui/useMotion";
import { EmptyState, PageHeader } from "./common";
import { anchorBelow, anchorFromEvent, useViewMenus } from "./menus";
import "./views.css";

export interface TracksViewProps {
  scrollRef: React.RefObject<HTMLElement>;
  actions: RouteViewActions;
}

/** Hauteur d'une ligne (lead / titre seul) et d'une sous-ligne de version (px). */
const ROW_H = 52;
const VERSION_H = 46;
/** En-tête de colonnes collant : le défilement clavier garde la ligne focalisée en dessous. */
const HEAD_H = 40;
/** Lignes montées hors écran de chaque côté (défilement fluide, DOM borné). */
const OVERSCAN = 6;
/** Album éphémère : la vue lit sa liste par le chemin existant `controls.playAlbum`. */
const PSEUDO_ALBUM_ID = -2;

const SORT_LABELS: Record<TrackSortKey, string> = {
  added: "Ajouté",
  title: "Titre",
  artist: "Artiste",
  album: "Album",
  duration: "Durée",
};
const SORT_ORDER: readonly TrackSortKey[] = ["added", "title", "artist", "album", "duration"];

/** Ligne affichée : une ligne visible, ou une version qui se replie (animation de sortie). */
interface DisplayRow {
  row: VersionRow;
  /** Rang du lead (n° affiché) ; `null` pour une version. */
  ordinal: number | null;
  /** Index dans la liste VISIBLE (lecture, sélection) ; `-1` pour une ligne qui se replie. */
  index: number;
  leaving: boolean;
  /** Rang de la version dans son groupe (cascade d'entrée). */
  sub: number;
  /** Dernière version de son groupe (le filet de l'arborescence s'y arrête). */
  lastVersion: boolean;
}

/**
 * Vue Titres : tous les titres de la bibliothèque, un par ligne (`TrackRowItem`), dans une liste
 * VIRTUALISÉE (`@tanstack/react-virtual` : seules les lignes visibles sont montées). Tri par
 * en-têtes de colonnes (flèche animée) — défaut « Ajouté », du plus ancien au plus récent, comme
 * la playlist Apple de l'utilisateur. Multi-sélection (Ctrl / Maj, flèches, Ctrl+A), menu
 * contextuel et glisser sur la sélection ; double-clic ou Entrée lit la liste affichée depuis ce
 * titre (album éphémère → `controls.playAlbum`, chemin de lecture inchangé).
 *
 * « Regrouper les versions » (réglage persisté, actif par défaut) : une ligne par morceau, ses
 * versions (Slowed, Sped Up, Remix…) repliées dessous ; « +N versions » les déplie (animation
 * transform/opacity, coupée en mouvement réduit). Rien n'est supprimé ni modifié.
 */
export function TracksView({ scrollRef, actions }: TracksViewProps): JSX.Element {
  const tracks = useLibrary((s) => s.tracks);
  const loading = useLibrary((s) => s.loading);
  const { sort, dir } = useUi((s) => s.tracksView);
  const expanded = useUi((s) => s.tracksExpanded);
  const grouped = useSettings((s) => s.groupVersions);
  const currentTrackId = usePlayer((s) => s.currentTrack?.id ?? null);
  const menus = useViewMenus(actions);
  const m = useMotion();

  const sorted = useMemo(() => sortTracks(tracks, sort, dir), [tracks, sort, dir]);
  const groups = useMemo<VersionGroup[] | null>(() => (grouped ? groupVersions(sorted) : null), [grouped, sorted]);
  const groupByLead = useMemo(() => new Map((groups ?? []).map((g) => [g.lead.id, g])), [groups]);
  const rows = useMemo<VersionRow[]>(
    () =>
      groups
        ? versionRows(groups, expanded)
        : sorted.map((t) => ({ track: t, depth: 0, groupId: t.id, versionCount: 0, expanded: false, tag: null })),
    [groups, expanded, sorted],
  );

  // --- Animation dépli / repli ------------------------------------------------------------------
  // Pendant ~une durée de base : les lignes glissent vers leur nouvelle place (transition de
  // `transform`), les versions dépliées entrent en fondu, les versions repliées s'effacent en
  // remontant sous leur lead (gardées montées, hauteur nulle, le temps de leur sortie).
  const animMs = Math.round(m.d(dur.base) * 1000);
  const [anim, setAnim] = useState<{ entering: number | null } | null>(null);
  const [leaving, setLeaving] = useState<ReadonlyMap<number, VersionRow[]>>(new Map());
  const animTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(animTimer.current), []);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const toggleGroup = useCallback(
    (leadId: number): void => {
      const isOpen = uiStore.getState().tracksExpanded.has(leadId);
      if (animMs > 0) {
        if (isOpen) {
          const versions = rowsRef.current.filter((r) => r.depth === 1 && r.groupId === leadId);
          setLeaving((prev) => new Map(prev).set(leadId, versions));
        } else {
          setLeaving((prev) => {
            if (!prev.has(leadId)) return prev;
            const next = new Map(prev);
            next.delete(leadId);
            return next;
          });
        }
        setAnim({ entering: isOpen ? null : leadId });
        clearTimeout(animTimer.current);
        animTimer.current = setTimeout(() => {
          setAnim(null);
          setLeaving(new Map());
        }, animMs + 60);
      }
      uiStore.getState().toggleTracksExpanded(leadId);
    },
    [animMs],
  );

  // Lignes affichées : les lignes visibles + les versions en cours de repli, sous leur lead (jamais
  // une piste déjà visible : bascule du regroupement ou nouveau tri pendant le repli).
  const display = useMemo<DisplayRow[]>(() => {
    const visible = new Set(rows.map((r) => r.track.id));
    const out: DisplayRow[] = [];
    let ordinal = 0;
    let sub = 0;
    rows.forEach((row, index) => {
      if (row.depth === 0) {
        ordinal++;
        sub = 0;
      } else sub++;
      const next = rows[index + 1];
      const lastVersion = row.depth === 1 && !(next && next.depth === 1 && next.groupId === row.groupId);
      out.push({ row, ordinal: row.depth === 0 ? ordinal : null, index, leaving: false, sub, lastVersion });
      if (row.depth === 0 && !row.expanded) {
        const gone = leaving.get(row.track.id);
        gone?.forEach((g, i) => {
          if (!visible.has(g.track.id)) {
            out.push({ row: g, ordinal: null, index: -1, leaving: true, sub: i + 1, lastVersion: i === gone.length - 1 });
          }
        });
      }
    });
    return out;
  }, [rows, leaving]);

  // --- Sélection (ids de pistes ; l'ancre est un id) -----------------------------------------------
  const [sel, setSel] = useState<ReadonlySet<number>>(new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const selRef = useRef({ sel, anchorId });
  selRef.current = { sel, anchorId };

  const indexOfId = useMemo(() => new Map(rows.map((r, i) => [r.track.id, i])), [rows]);
  const indexRef = useRef(indexOfId);
  indexRef.current = indexOfId;

  /** Titres sélectionnés ET visibles, dans l'ordre affiché. */
  const selectedVisible = useCallback((): TrackRow[] => {
    const s = selRef.current.sel;
    return rowsRef.current.filter((r) => s.has(r.track.id)).map((r) => r.track);
  }, []);

  const applySelection = useCallback((indices: ReadonlySet<number>, anchorIndex: number): void => {
    const list = rowsRef.current;
    const ids = new Set<number>();
    for (const i of indices) {
      const r = list[i];
      if (r) ids.add(r.track.id);
    }
    setSel(ids);
    setAnchorId(list[anchorIndex]?.track.id ?? null);
  }, []);

  const selectAt = useCallback(
    (index: number, mods: { shift: boolean; ctrl: boolean }): void => {
      const idx = indexRef.current;
      const { sel: s, anchorId: a } = selRef.current;
      const current = new Set<number>();
      for (const id of s) {
        const i = idx.get(id);
        if (i !== undefined) current.add(i);
      }
      const anchor = a === null ? null : idx.get(a) ?? null;
      const r = selectionAfterClick(current, index, mods, anchor);
      applySelection(r.sel, r.anchor);
    },
    [applySelection],
  );

  // --- Lecture ------------------------------------------------------------------------------------
  const playList = useCallback(
    (list: readonly TrackRow[], index: number): void => {
      if (list.length === 0) return;
      const pseudo: Album = {
        id: PSEUDO_ALBUM_ID,
        title: "Titres",
        artist: "",
        artKey: list.find((t) => t.artKey)?.artKey ?? null,
        tracks: list,
      };
      actions.playAlbum(pseudo, Math.max(0, Math.min(index, list.length - 1)));
    },
    [actions],
  );

  /** Lit la liste AFFICHÉE (leads + versions dépliées) depuis `track` ; sur le titre courant : bascule. */
  const playFrom = useCallback(
    (track: TrackRow): void => {
      const p = playerStore.getState();
      if (p.currentTrack?.id === track.id && canResume(p.status)) {
        actions.togglePlay();
        return;
      }
      const list = rowsRef.current.map((r) => r.track);
      playList(list, indexRef.current.get(track.id) ?? 0);
    },
    [actions, playList],
  );
  const playTracks = useCallback((list: readonly TrackRow[]): void => playList(list, 0), [playList]);

  // --- Callbacks de ligne (STABLES : les lignes sont mémoïsées) -----------------------------------
  const onRowPlay = useCallback((track: TrackRow) => playFrom(track), [playFrom]);
  const onRowSelect = useCallback(
    (track: TrackRow, index: number, e: React.MouseEvent<HTMLElement>): void => {
      if (e.type === "contextmenu") {
        // Clic droit dans la sélection : on la garde (le menu agit sur elle) ; sinon, ce titre seul.
        if (!selRef.current.sel.has(track.id)) selectAt(index, { shift: false, ctrl: false });
        return;
      }
      selectAt(index, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    },
    [selectAt],
  );
  const onRowFocus = useCallback((track: TrackRow) => setFocusedId(track.id), []);
  const getDragIds = useCallback(
    (track: TrackRow): readonly number[] =>
      selRef.current.sel.has(track.id) ? selectedVisible().map((t) => t.id) : [track.id],
    [selectedVisible],
  );
  const onRowMenu = useCallback(
    (track: TrackRow, e: React.MouseEvent<HTMLElement>): void => {
      const anchor = anchorFromEvent(e);
      const chosen = selRef.current.sel.has(track.id) ? selectedVisible() : [track];
      const single = chosen.length === 1 ? chosen[0]! : null;
      const group = single ? groupByLead.get(single.id) : undefined;
      void menus.openSelectionMenu(chosen.length > 0 ? chosen : [track], anchor, playFrom, playTracks, {
        versions: group && group.versions.length > 0 ? group.versions : undefined,
      });
    },
    [menus, selectedVisible, groupByLead, playFrom, playTracks],
  );

  // --- Virtualisation -----------------------------------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [restoreTop] = useState(() => plannedScroll("tracks"));
  const [scrollMargin, setScrollMargin] = useState(0);

  const measureMargin = useCallback((): void => {
    const el = listRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const next = Math.max(0, Math.round(offset));
    setScrollMargin((prev) => (prev === next ? prev : next));
  }, [scrollRef]);
  const hasList = tracks.length > 0;
  useLayoutEffect(() => {
    measureMargin();
  }, [measureMargin, hasList]);
  // L'en-tête peut changer de hauteur (polices chargées, fenêtre redimensionnée, barre d'outils
  // qui passe à la ligne).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(measureMargin);
    ro.observe(root);
    return () => ro.disconnect();
  }, [measureMargin]);

  // Nouvelle identité à chaque changement de liste : le virtualiseur recalcule ses positions.
  const getItemKey = useCallback((i: number) => display[i]?.row.track.id ?? i, [display]);
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (display[i]?.leaving ? 0 : display[i]?.row.depth === 1 ? VERSION_H : ROW_H),
    getItemKey,
    overscan: OVERSCAN,
    scrollMargin,
    scrollPaddingStart: HEAD_H,
    initialOffset: restoreTop ?? 0,
  });
  const items = virtualizer.getVirtualItems();

  /** Index d'affichage d'un index visible (les lignes qui se replient s'intercalent). */
  const displayIndexOf = useCallback(
    (visibleIndex: number): number => display.findIndex((d) => d.index === visibleIndex),
    [display],
  );

  /** Amène la ligne visible `index` à l'écran puis lui donne le focus (elle peut être démontée). */
  const focusIndex = useCallback(
    (index: number): void => {
      const di = displayIndexOf(index);
      if (di < 0) return;
      // Première ligne : retour tout en haut (le titre de la page réapparaît).
      if (di === 0) scrollRef.current?.scrollTo({ top: 0 });
      else virtualizer.scrollToIndex(di, { align: "auto" });
      let tries = 0;
      const attempt = (): void => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-vi="${di}"] [data-track-row]`);
        if (el) el.focus({ preventScroll: true });
        else if (++tries < 6) requestAnimationFrame(attempt);
      };
      requestAnimationFrame(attempt);
    },
    [displayIndexOf, virtualizer],
  );

  // Clavier de la liste (après celui de la ligne) : flèches / Début / Fin / Page — focus ET
  // sélection suivent (Maj étend), même vers une ligne pas encore montée ; → / ← déplient /
  // replient un morceau ; Ctrl+A sélectionne tout.
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-track-row]");
    const host = rowEl?.closest<HTMLElement>("[data-vi]");
    if (!rowEl || !host || e.target !== rowEl || e.altKey) return;
    const d = display[Number(host.dataset.vi)];
    if (!d || d.leaving) return;
    const last = rows.length - 1;
    const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 600) - HEAD_H) / ROW_H) - 1);
    let target: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        target = Math.min(last, d.index + 1);
        break;
      case "ArrowUp":
        target = Math.max(0, d.index - 1);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      case "PageDown":
        target = Math.min(last, d.index + page);
        break;
      case "PageUp":
        target = Math.max(0, d.index - page);
        break;
      case "ArrowRight":
        if (!e.shiftKey && !e.ctrlKey && d.row.depth === 0 && d.row.versionCount > 0 && !d.row.expanded) {
          e.preventDefault();
          toggleGroup(d.row.groupId);
        }
        return;
      case "ArrowLeft":
        if (e.shiftKey || e.ctrlKey) return;
        if (d.row.depth === 0 && d.row.expanded) {
          e.preventDefault();
          toggleGroup(d.row.groupId);
        } else if (d.row.depth === 1) {
          e.preventDefault();
          const lead = indexOfId.get(d.row.groupId);
          if (lead !== undefined) {
            selectAt(lead, { shift: false, ctrl: false });
            focusIndex(lead);
          }
        }
        return;
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          applySelection(new Set(rows.map((_, i) => i)), selRef.current.anchorId !== null ? indexOfId.get(selRef.current.anchorId) ?? 0 : 0);
        }
        return;
      default:
        return;
    }
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    selectAt(target, { shift: e.shiftKey, ctrl: false });
    focusIndex(target);
  };

  // Tabulation itinérante : un seul arrêt (ligne focalisée, sinon la sélection, le titre en cours,
  // la première ligne) — et toujours une ligne MONTÉE, sinon la liste sortirait du parcours Tab.
  const mountedIds = new Set(items.map((it) => display[it.index]?.row.track.id));
  const firstSelected = rows.find((r) => sel.has(r.track.id))?.track.id ?? null;
  const preferredStop =
    [focusedId, firstSelected, currentTrackId].find((id) => id !== null && indexOfId.has(id)) ??
    rows[0]?.track.id ??
    null;
  const firstMounted = items.map((it) => display[it.index]).find((d) => d && !d.leaving)?.row.track.id ?? null;
  const tabStopId = preferredStop !== null && mountedIds.has(preferredStop) ? preferredStop : firstMounted;

  // Pastilles « +N versions » / tag de version : créées avec les lignes (identité stable pendant
  // le défilement, les lignes mémoïsées ne se re-rendent pas à chaque frame).
  const addons = useMemo(() => {
    const map = new Map<number, JSX.Element>();
    for (const d of display) {
      const r = d.row;
      if (r.depth === 0 && r.versionCount > 0) {
        map.set(
          r.track.id,
          <button
            type="button"
            tabIndex={-1}
            className={`version-toggle${r.expanded ? " is-open" : ""}`}
            aria-expanded={r.expanded}
            aria-label={`${r.expanded ? "Replier" : "Afficher"} les ${r.versionCount + 1} versions de ${r.track.title}`}
            title={r.expanded ? "Replier les versions" : "Afficher les versions"}
            onClick={(e) => {
              e.stopPropagation();
              toggleGroup(r.groupId);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="num">+{r.versionCount}</span>
            <span>{r.versionCount > 1 ? "versions" : "version"}</span>
            <ChevronDown className="version-toggle__chev" size={13} strokeWidth={ICON_STROKE} aria-hidden />
          </button>,
        );
      } else if (r.depth === 1 && r.tag) {
        map.set(
          r.track.id,
          <span className="version-tag" title={r.tag}>
            {r.tag}
          </span>,
        );
      }
    }
    return map;
  }, [display, toggleGroup]);

  // --- En-tête de page ----------------------------------------------------------------------------
  const sub =
    loading && tracks.length === 0
      ? null
      : groups
        ? `${groups.length} ${groups.length > 1 ? "morceaux" : "morceau"} · ${tracks.length} ${tracks.length > 1 ? "fichiers" : "fichier"}`
        : `${tracks.length} ${tracks.length > 1 ? "titres" : "titre"}`;

  const openSortMenu = (e: React.MouseEvent<HTMLElement>): void => {
    const a = anchorBelow(e);
    openMenu(
      a.x,
      a.y,
      [
        ...SORT_ORDER.map((k) => ({
          label: SORT_LABELS[k],
          icon: k === sort ? Check : undefined,
          // Choisir la colonne active ne change rien (le sens se règle avec l'entrée dédiée).
          onSelect: () => {
            if (k !== sort) uiStore.getState().sortTracksBy(k);
          },
        })),
        "separator" as const,
        {
          label: dir === "asc" ? "Ordre décroissant" : "Ordre croissant",
          icon: ArrowUp,
          onSelect: () => uiStore.getState().sortTracksBy(sort),
        },
      ],
      { focusFirst: a.focusFirst },
    );
  };

  const toolbar = (
    <div className="view-tools" role="group" aria-label="Tri et affichage">
      <button
        type="button"
        className={`view-chip sort-chip${dir === "desc" ? " is-desc" : ""}`}
        aria-haspopup="menu"
        aria-label={`Trier par : ${SORT_LABELS[sort]}, ${dir === "asc" ? "croissant" : "décroissant"}`}
        onClick={openSortMenu}
      >
        <ArrowUp className="sort-arrow" size={15} strokeWidth={ICON_STROKE} aria-hidden />
        <span>{SORT_LABELS[sort]}</span>
        <ChevronDown className="view-chip__chev" size={14} strokeWidth={ICON_STROKE} aria-hidden />
      </button>
      <button
        type="button"
        className={`view-chip${grouped ? " is-on" : ""}`}
        aria-pressed={grouped}
        title="Une ligne par morceau ; ses versions (Slowed, Remix…) se déplient dessous"
        onClick={() => settingsStore.getState().setGroupVersions(!grouped)}
      >
        <Layers2 size={15} strokeWidth={ICON_STROKE} aria-hidden />
        Regrouper les versions
      </button>
    </div>
  );

  let body: JSX.Element;
  if (loading && tracks.length === 0) {
    body = <TracksSkeleton />;
  } else if (tracks.length === 0) {
    body = (
      <EmptyState
        icon={Music}
        title="Aucun titre"
        text="Ajoute un dossier de musique depuis l'accueil pour remplir ta bibliothèque."
      />
    );
  } else {
    const style = {
      "--tv-dur": `${m.d(dur.base)}s`,
      height: virtualizer.getTotalSize(),
    } as React.CSSProperties;
    body = (
      <div
        ref={listRef}
        className={`tracks-list${anim ? " is-animating" : ""}`}
        role="list"
        aria-label="Titres"
        aria-multiselectable="true"
        data-track-list=""
        style={style}
        onKeyDown={onListKeyDown}
      >
        {items.map((it) => {
          const d = display[it.index];
          if (!d) return null;
          const t = d.row.track;
          const isVersion = d.row.depth === 1;
          const entering = !d.leaving && isVersion && anim?.entering === d.row.groupId;
          return (
            <div
              key={it.key}
              className={`tracks-vrow${d.leaving ? " is-leaving" : ""}${entering ? " is-entering" : ""}`}
              role="presentation"
              data-vi={it.index}
              aria-hidden={d.leaving || undefined}
              style={
                {
                  transform: `translateY(${it.start - scrollMargin}px)`,
                  "--sub": d.sub,
                } as React.CSSProperties
              }
            >
              <div className="tracks-vrow__in">
                <TrackRowItem
                  track={t}
                  index={Math.max(0, d.index)}
                  number={d.ordinal ?? undefined}
                  hideNumber={isVersion}
                  playing={t.id === currentTrackId}
                  selected={!d.leaving && sel.has(t.id)}
                  tabbable={!d.leaving && t.id === tabStopId}
                  onFocusRow={onRowFocus}
                  onPlay={onRowPlay}
                  onSelect={onRowSelect}
                  onContextMenu={onRowMenu}
                  getDragIds={getDragIds}
                  titleAddon={addons.get(t.id)}
                  displayTitle={isVersion && d.row.tag ? versionName(t.title) : undefined}
                  className={isVersion ? (d.lastVersion ? "is-version is-version-last" : "is-version") : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="tracks-view" ref={rootRef}>
      <PageHeader title="Titres" sub={sub} aside={toolbar} />
      {tracks.length > 0 && <TracksHead sort={sort} dir={dir} />}
      {body}
    </div>
  );
}

/** En-tête de colonnes collant, triable : un clic trie, un second inverse ; flèche animée. */
function TracksHead({ sort, dir }: { sort: TrackSortKey; dir: "asc" | "desc" }): JSX.Element {
  const col = (key: TrackSortKey, label: React.ReactNode, className = "", aria = SORT_LABELS[key]): JSX.Element => {
    const active = key === sort;
    return (
      <button
        type="button"
        className={`tracks-head__col${active ? " is-active" : ""}${active && dir === "desc" ? " is-desc" : ""}${className ? ` ${className}` : ""}`}
        aria-label={`Trier par ${aria.toLowerCase()}`}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
        title={active ? `${aria} — ${dir === "asc" ? "croissant" : "décroissant"}` : `Trier par ${aria.toLowerCase()}`}
        onClick={() => uiStore.getState().sortTracksBy(key)}
      >
        <span className="tracks-head__label">{label}</span>
        <ArrowUp className="sort-arrow" size={13} strokeWidth={2} aria-hidden />
      </button>
    );
  };
  return (
    <div className="tracks-head" role="group" aria-label="Colonnes (tri)">
      {col("added", "#", "tracks-head__num", "Date d'ajout")}
      {col("title", "Titre")}
      {col("artist", "Artiste")}
      {col("album", "Album")}
      <span aria-hidden="true" />
      {col("duration", <Clock3 size={14} strokeWidth={ICON_STROKE} aria-hidden />, "tracks-head__dur", "Durée")}
    </div>
  );
}

/** Lignes fantômes pendant le premier chargement de la bibliothèque. */
function TracksSkeleton(): JSX.Element {
  return (
    <div className="tracks-skel" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="tracks-skel__row">
          <Skeleton w={18} h={10} radius={5} />
          <Skeleton w={`${48 + ((i * 37) % 30)}%`} h={12} radius={6} />
          <Skeleton w="60%" h={10} radius={5} />
          <Skeleton w="54%" h={10} radius={5} />
          <Skeleton w={34} h={10} radius={5} />
        </div>
      ))}
    </div>
  );
}
