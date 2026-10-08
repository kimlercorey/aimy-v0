/**
 * @aimy/tts — local text-to-speech via a Chatterbox server (spec: planning/tts-spec.md).
 *
 * Phase 1: TypeScript module — sentence chunking, per-chunk /speak over HTTP,
 * WAV concatenation, voice selection, health. The Python server
 * (server/tts-server.py) runs on the user's machine; the service fails
 * honestly when it's unreachable.
 */
export * from "./errors.js"
export * from "./types.js"
export * from "./chunk.js"
export * from "./wav.js"
export * from "./client.js"
export * from "./service.js"
