import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { entriesFromFlatJson, parseYoutubePlaylistUrl, resolveYoutubePlaylist } from "../src/main/youtube/playlist";

/**
 * Playlists YouTube : reconnaissance du lien, lecture de la réponse `yt-dlp -J`, et résolution
 * (spawn simulé — aucun réseau, aucun binaire).
 */

const LIST = "PLbXl0H8s0k1l2m3n4o5p6";

describe("parseYoutubePlaylistUrl", () => {
  it("accepte les trois formes de lien de playlist", () => {
    expect(parseYoutubePlaylistUrl(`https://www.youtube.com/playlist?list=${LIST}`)?.listId).toBe(LIST);
    expect(parseYoutubePlaylistUrl(`https://music.youtube.com/playlist?list=${LIST}`)?.listId).toBe(LIST);
    const watch = parseYoutubePlaylistUrl(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${LIST}`);
    expect(watch?.listId).toBe(LIST);
    expect(watch?.startVideoId).toBe("dQw4w9WgXcQ");
    // L'URL canonique ne garde que la playlist : on veut TOUTE la liste, pas la vidéo courante.
    expect(watch?.url).toBe(`https://www.youtube.com/playlist?list=${LIST}`);
  });

  it("refuse ce qui n'est pas une playlist YouTube https valide", () => {
    expect(parseYoutubePlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYoutubePlaylistUrl(`http://www.youtube.com/playlist?list=${LIST}`)).toBeNull();
    expect(parseYoutubePlaylistUrl(`https://vimeo.com/playlist?list=${LIST}`)).toBeNull();
    expect(parseYoutubePlaylistUrl("https://www.youtube.com/playlist?list=a")).toBeNull();
    expect(parseYoutubePlaylistUrl("https://www.youtube.com.evil.com/playlist?list=" + LIST)).toBeNull();
    expect(parseYoutubePlaylistUrl("")).toBeNull();
  });
});

describe("entriesFromFlatJson", () => {
  it("lit les entrées et ignore celles sans titre ou sans identifiant", () => {
    const tracks = entriesFromFlatJson({
      entries: [
        { id: "dQw4w9WgXcQ", title: "Titre A", artist: "Artiste A", duration: 213 },
        { id: "abc", title: "Cassé" },
        { id: "9bZkp7q19f0", title: "Titre B", uploader: "Chaîne B" },
        { id: "xW8Qp7q19f0", title: "" },
      ],
    });
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toEqual({
      title: "Titre A",
      artist: "Artiste A",
      duration: 213,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    // Sans `artist`, on retombe sur l'uploader — c'est ce qui rend le rapprochement utilisable.
    expect(tracks[1]?.artist).toBe("Chaîne B");
    expect(tracks[1]?.duration).toBe(0);
  });

  it("tolère une réponse sans entrées", () => {
    expect(entriesFromFlatJson({})).toEqual([]);
    expect(entriesFromFlatJson(null)).toEqual([]);
  });
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = (): boolean => true;
}

describe("resolveYoutubePlaylist", () => {
  it("rend les pistes à la fermeture réussie", async () => {
    const spawnImpl = (() => {
      const child = new FakeChild();
      setTimeout(() => {
        child.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ entries: [{ id: "dQw4w9WgXcQ", title: "Titre", artist: "Artiste" }] })),
        );
        child.emit("close", 0);
      }, 0);
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    const tracks = await resolveYoutubePlaylist("yt-dlp.exe", "https://www.youtube.com/playlist?list=x", { spawnImpl });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBe("Titre");
  });

  it("traduit « playlist does not exist » en message actionnable (playlist privée)", async () => {
    const spawnImpl = (() => {
      const child = new FakeChild();
      setTimeout(() => {
        child.stderr.emit("data", Buffer.from("ERROR: Playlist does not exist\n"));
        child.emit("close", 1);
      }, 0);
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      resolveYoutubePlaylist("yt-dlp.exe", "https://www.youtube.com/playlist?list=x", { spawnImpl }),
    ).rejects.toThrow(/privée/);
  });

  it("transmet les cookies à yt-dlp quand ils sont fournis", async () => {
    let captured: string[] = [];
    const spawnImpl = ((_bin: string, args: string[]) => {
      captured = args;
      const child = new FakeChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ entries: [] })));
        child.emit("close", 0);
      }, 0);
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    await resolveYoutubePlaylist("yt-dlp.exe", "https://www.youtube.com/playlist?list=x", {
      spawnImpl,
      cookieArgs: ["--cookies", "C:/data/youtube-cookies.txt"],
    });
    expect(captured).toContain("--cookies");
    expect(captured[captured.indexOf("--cookies") + 1]).toBe("C:/data/youtube-cookies.txt");
  });

  it("n'ajoute pas --cookies quand il n'y en a pas", async () => {
    let captured: string[] = [];
    const spawnImpl = ((_bin: string, args: string[]) => {
      captured = args;
      const child = new FakeChild();
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ entries: [] })));
        child.emit("close", 0);
      }, 0);
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    await resolveYoutubePlaylist("yt-dlp.exe", "https://www.youtube.com/playlist?list=x", { spawnImpl });
    expect(captured).not.toContain("--cookies");
  });
});


