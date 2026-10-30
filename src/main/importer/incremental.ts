/**
 * Ajout incrémental à une playlist existante.
 *
 * Cas d'usage réel : la playlist a été importée hier, l''utilisateur ajoute des titres dans Apple
 * Music, ré-exporte, et ré-importe. On ne doit alors insérer QUE les nouveaux — sans créer un
 * doublon de playlist ni dupliquer les titres déjà présents.
 *
 * Fonction pure : l''ordre de l''import est conservé (c''est lui qui fait la playlist), et les
 * répétitions internes sont éliminées.
 */
export function onlyNewTrackIds(
  incoming: readonly number[],
  existing: readonly number[],
): number[] {
  const already = new Set(existing);
  const seen = new Set<number>();
  const fresh: number[] = [];
  for (const id of incoming) {
    if (already.has(id) || seen.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  return fresh;
}
