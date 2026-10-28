export const CHANNELS = {
  PING: "app:ping",
  LIBRARY_QUERY: "library:query",
  LIBRARY_SCAN: "library:scan",
  AUDIO_DEFAULT_DEVICE: "audio:default-device",
  AUDIO_READ_FILE: "audio:read-file",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
