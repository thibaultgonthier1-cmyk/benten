import { describe, expect, it } from "vitest";
import { onlyNewTrackIds } from "../src/main/importer/incremental";

/**
 * Ré-import d'un export Apple après avoir ajouté des titres : on ne doit ajouter QUE les
 * nouveaux. Un doublon dans la playlist serait visible immédiatement, et un titre manqué serait
 * invisible — les deux méritent un test.
 */
describe("onlyNewTrackIds", () => {
  it("garde les titres absents, dans l'ordre de l'import", () => {
    expect(onlyNewTrackIds([1, 2, 4, 9], [2, 9])).toEqual([1, 4]);
  });

  it("ne renvoie rien quand tout est déjà là", () => {
    expect(onlyNewTrackIds([3, 5], [5, 3, 1])).toEqual([]);
  });

  it("dédoublonne aussi les répétitions internes à l'import", () => {
    expect(onlyNewTrackIds([7, 7, 8], [])).toEqual([7, 8]);
  });

  it("renvoie tout quand la playlist est vide", () => {
    expect(onlyNewTrackIds([1, 2, 3], [])).toEqual([1, 2, 3]);
  });

  it("ne modifie pas les entrées", () => {
    const incoming = [1, 2];
    const existing = [2];
    onlyNewTrackIds(incoming, existing);
    expect(incoming).toEqual([1, 2]);
    expect(existing).toEqual([2]);
  });
});
