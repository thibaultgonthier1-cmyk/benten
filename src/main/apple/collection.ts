// Porté depuis Prism (même auteur, même pipeline). Code d'origine conservé tel quel :
// typage explicite à la frontière dans src/main/apple/index.ts.
// @ts-nocheck
/**
 * Turns an Apple Music playlist or album link into the track list the capture
 * adapters take.
 *
 * Two sources, in order:
 *
 *  1. `amp-api.music.apple.com` with the public token the Apple Music web player
 *     itself uses. It paginates, so a 996-track playlist comes back whole.
 *  2. The page's own `serialized-server-data`, which is capped at 300 tracks —
 *     kept as a fallback for when Apple rotates the token.
 *
 * Nothing here decrypts or downloads audio: it builds the batch that the
 * loopback capture then plays through the Apple Music app.
 */

const PAGE_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 100;
const MAX_TRACKS = 5000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let cachedToken = { value: '', at: 0 };
const TOKEN_TTL_MS = 60 * 60 * 1000;

export function isAppleCollectionUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return false;
    return /\/(playlist|album)\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function parseTarget(rawUrl) {
  const url = new URL(String(rawUrl || ''));
  const parts = url.pathname.split('/').filter(Boolean);
  const kindIndex = parts.findIndex((part) => part === 'playlist' || part === 'album');
  const kind = kindIndex >= 0 ? (parts[kindIndex] === 'playlist' ? 'playlists' : 'albums') : '';
  const id = kindIndex >= 0 ? (parts[kindIndex + 2] || '') : '';
  // The storefront is the first path segment when it looks like one ("fr").
  const storefront = /^[a-z]{2}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : 'us';
  return { kind, id, storefront, url };
}

async function getToken(fetchImpl) {
  if (cachedToken.value && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.value;
  const response = await fetchImpl('https://music.apple.com/', { headers: { 'user-agent': USER_AGENT } });
  const html = await response.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  const bundle = scripts.find((src) => /\/assets\/index[^/]*\.js$/.test(src));
  if (!bundle) return '';
  const url = bundle.startsWith('http') ? bundle : `https://music.apple.com${bundle}`;
  const js = await (await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } })).text();
  const match = js.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  if (!match) return '';
  cachedToken = { value: match[0], at: Date.now() };
  return cachedToken.value;
}

function artworkFrom(attributes) {
  const template = attributes?.artwork?.url;
  if (!template) return '';
  return String(template).replace('{w}', '600').replace('{h}', '600').replace('{f}', 'jpg');
}

function trackFromAttribute(attributes, index) {
  const seconds = Number(attributes?.durationInMillis) > 0 ? Math.round(Number(attributes.durationInMillis) / 1000) : 0;
  return {
    title: String(attributes?.name || '').trim(),
    artist: String(attributes?.artistName || '').trim() || 'Unknown artist',
    album: String(attributes?.albumName || '').trim(),
    duration: seconds,
    trackNo: Number(attributes?.trackNumber) > 0 ? Number(attributes.trackNumber) : index + 1,
    trackId: String(attributes?.playParams?.catalogId || attributes?.playParams?.id || '').trim(),
    url: String(attributes?.url || '').trim(),
    artworkUrl: artworkFrom(attributes),
  };
}

async function readThroughApi(target, fetchImpl) {
  const token = await getToken(fetchImpl).catch(() => '');
  if (!token) return null;
  const headers = {
    authorization: `Bearer ${token}`,
    origin: 'https://music.apple.com',
    'user-agent': USER_AGENT,
  };

  let name = '';
  try {
    const meta = await fetchImpl(`https://amp-api.music.apple.com/v1/catalog/${target.storefront}/${target.kind}/${target.id}`, { headers });
    if (meta.ok) {
      const json = await meta.json();
      name = String(json?.data?.[0]?.attributes?.name || '').trim();
    }
  } catch {
    // The name is cosmetic; the track list is the point.
  }

  const tracks = [];
  for (let offset = 0; offset < MAX_TRACKS; offset += PAGE_LIMIT) {
    const endpoint = `https://amp-api.music.apple.com/v1/catalog/${target.storefront}/${target.kind}/${target.id}/tracks?offset=${offset}&limit=${PAGE_LIMIT}`;
    const response = await fetchImpl(endpoint, { headers });
    if (!response.ok) {
      if (!tracks.length) return null;
      break;
    }
    const json = await response.json();
    const page = Array.isArray(json?.data) ? json.data : [];
    for (const entry of page) {
      const track = trackFromAttribute(entry?.attributes, tracks.length);
      if (track.title) tracks.push(track);
    }
    if (page.length < PAGE_LIMIT || !json?.next) break;
  }
  if (!tracks.length) return null;
  return { name, tracks };
}

// ---------------------------------------------------------------------------
// Page fallback: capped at the 300 tracks Apple ships in the HTML.
// ---------------------------------------------------------------------------

function collectTrackItems(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return;
  if (Array.isArray(node)) {
    for (const entry of node) collectTrackItems(entry, out, depth + 1);
    return;
  }
  if (node.itemKind === 'trackLockup' && Array.isArray(node.items)) {
    for (const item of node.items) out.push(item);
    return;
  }
  for (const value of Object.values(node)) collectTrackItems(value, out, depth + 1);
}

async function readThroughPage(target, fetchImpl) {
  const response = await fetchImpl(target.url.toString(), { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) return null;
  const html = await response.text();
  const match = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let root;
  try {
    root = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const items = [];
  collectTrackItems(root, items);
  const seen = new Set();
  const tracks = [];
  for (const item of items) {
    const title = String(item?.title || '').trim();
    if (!title) continue;
    const songId = String(item?.contentDescriptor?.identifiers?.storeAdamID || '').trim();
    if (songId && seen.has(songId)) continue;
    if (songId) seen.add(songId);
    const albumUrl = item?.tertiaryLinks?.[0]?.segue?.destination?.url || '';
    tracks.push({
      title,
      artist: String(item?.artistName || item?.subtitleLinks?.[0]?.title || '').trim() || 'Unknown artist',
      album: String(item?.tertiaryLinks?.[0]?.title || '').trim(),
      duration: Number(item?.duration) > 0 ? Math.round(Number(item.duration) / 1000) : 0,
      trackNo: tracks.length + 1,
      trackId: songId,
      url: String(item?.contentDescriptor?.url || '') || (albumUrl && songId ? `${albumUrl.split('?')[0]}?i=${songId}` : ''),
      artworkUrl: String(item?.artwork?.dictionary?.url || '').replace('{w}', '600').replace('{h}', '600').replace('{f}', 'jpg'),
    });
  }
  let name = '';
  (function walk(node, depth) {
    if (name || !node || typeof node !== 'object' || depth > 10) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (typeof node.title === 'string' && node.title.trim().length > 1 && !/^track-lockup/i.test(node.id || '')) {
      name = node.title.trim();
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  })(root, 0);
  if (!tracks.length) return null;
  return { name, tracks };
}

export async function resolveAppleCollection(rawUrl, { fetchImpl = fetch } = {}) {
  const absolute = String(rawUrl || '').trim();
  if (!isAppleCollectionUrl(absolute)) {
    return { ok: false, kind: 'unknown', playlistName: '', tracks: [], reason: 'That is not an Apple Music playlist or album link.', truncated: false };
  }
  const target = parseTarget(absolute);
  if (!target.id) {
    return { ok: false, kind: 'unknown', playlistName: '', tracks: [], reason: 'That link has no playlist or album id in it.', truncated: false };
  }
  const kind = target.kind === 'playlists' ? 'playlist' : 'album';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  const timedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: controller.signal });
  try {
    const viaApi = await readThroughApi(target, timedFetch).catch(() => null);
    if (viaApi?.tracks?.length) {
      return {
        ok: true,
        kind,
        playlistName: viaApi.name,
        tracks: viaApi.tracks,
        reason: '',
        truncated: false,
      };
    }
    const viaPage = await readThroughPage(target, timedFetch).catch(() => null);
    if (viaPage?.tracks?.length) {
      return {
        ok: true,
        kind,
        playlistName: viaPage.name,
        tracks: viaPage.tracks,
        reason: '',
        // Say it plainly: the page is capped, so a big playlist comes back partial.
        truncated: viaPage.tracks.length >= 300,
      };
    }
    return {
      ok: false,
      kind,
      playlistName: '',
      tracks: [],
      reason: 'Apple Music did not return a track list for that link. Check the link opens in a browser, then try again.',
      truncated: false,
    };
  } catch (error) {
    return {
      ok: false,
      kind,
      playlistName: '',
      tracks: [],
      reason: `The Apple Music link could not be read: ${error?.message || error}`,
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

