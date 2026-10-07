/** chat/src/args.ts — CLI argument parsing. Pure; no I/O. */

export interface ChatArgs {
  readonly model: string | undefined
  readonly baseUrl: string
  readonly session: string | undefined
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434"
export const DEFAULT_SESSION = "default"

/**
 * Parses argv (without node/script entries). Never throws: unknown flags are
 * ignored, `--flag value` and `--flag=value` both work.
 */
export const parseArgs = (argv: ReadonlyArray<string>): ChatArgs => {
  let model: string | undefined
  let baseUrl = DEFAULT_BASE_URL
  let session: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const [flag, inline] = raw.split("=", 2)
    const value = inline ?? argv[i + 1]
    const consumedInline = inline !== undefined
    switch (flag) {
      case "--model":
        if (value !== undefined && !value.startsWith("--")) {
          model = value
          if (!consumedInline) i++
        }
        break
      case "--base-url":
        if (value !== undefined && !value.startsWith("--")) {
          baseUrl = value
          if (!consumedInline) i++
        }
        break
      case "--session":
        if (value !== undefined && !value.startsWith("--")) {
          session = value
          if (!consumedInline) i++
        }
        break
      default:
        break // ignore unknown flags (e.g. npm's own)
    }
  }

  return { model: model ?? process.env["AIMY_MODEL"], baseUrl, session }
}

export const USAGE = `aimy-chat — talk to your local AImy

usage: npm run chat -- --model <name> [--base-url <url>] [--session <id>]

  --model      model name on your local server (or set AIMY_MODEL)
  --base-url   chat-completions endpoint (default ${DEFAULT_BASE_URL})
  --session    resume a named session (default "${DEFAULT_SESSION}")

commands inside the chat: /new  /quit  /help`
