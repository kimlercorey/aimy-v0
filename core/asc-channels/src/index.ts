/**
 * @aimy/asc-channels — simultaneous output channels for one agent turn.
 *
 * Chat (full text) + voice (TTS audio of the speakable text) + face (FACS
 * expression timeline) from a single renderChannels() call. Downstream
 * reader of ASC dials — never writes them.
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./facs.js"
export * from "./speakable.js"
export * from "./timeline.js"
export * from "./orchestrator.js"
