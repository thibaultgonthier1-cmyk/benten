export const CHANNELS = {
  PING: "app:ping",
  LIBRARY_QUERY: "library:query",
  LIBRARY_SCAN: "library:scan",
  LIBRARY_SEARCH: "library:search",
  LIBRARY_TRACKS_BY_IDS: "library:tracks-by-ids",
  AUDIO_DEFAULT_DEVICE: "audio:default-device",
  AUDIO_LIST_DEVICES: "audio:list-devices",
  AUDIO_READ_FILE: "audio:read-file",
  DIALOG_PICK_FOLDER: "dialog:pick-folder",
  SOURCES_LIST: "sources:list",
  SOURCES_REMOVE: "sources:remove",
  FAVORITES_TOGGLE: "favorites:toggle",
  FAVORITES_LIST: "favorites:list",
  PLAYLISTS_LIST: "playlists:list",
  PLAYLISTS_CREATE: "playlists:create",
  PLAYLISTS_RENAME: "playlists:rename",
  PLAYLISTS_DELETE: "playlists:delete",
  PLAYLISTS_TRACKS: "playlists:tracks",
  PLAYLISTS_ADD: "playlists:add",
  PLAYLISTS_REMOVE: "playlists:remove",
  PLAYLISTS_REORDER: "playlists:reorder",
  PLAYLISTS_INSERT_AT: "playlists:insert-at",
  STATE_GET: "state:get",
  STATE_SET: "state:set",
  /** Journal audio : le Renderer envoie des lots d'entrees, le Main les ajoute au fichier. */
  DIAGNOSTICS_APPEND: "diagnostics:append",
  /** Push Main -> Renderer (une voie) : la bibliotheque a change (veille de dossiers, Task 14B). */
  LIBRARY_CHANGED: "library:changed",
  /** T15 — téléchargeur YouTube → MP3. */
  YOUTUBE_ENQUEUE: "youtube:enqueue",
  YOUTUBE_JOBS: "youtube:jobs",
  YOUTUBE_STATUS: "youtube:status",
  YOUTUBE_UPDATE: "youtube:update",
  /** T16 — import d'une playlist Apple (aperçu puis création). */
  IMPORT_PREVIEW: "import:preview",
  IMPORT_COMMIT: "import:commit",
  DIALOG_PICK_FILE: "dialog:pick-file",
  /** Push Main -> Renderer : un travail a changé d'état. */
  YOUTUBE_PROGRESS: "youtube:progress",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];


