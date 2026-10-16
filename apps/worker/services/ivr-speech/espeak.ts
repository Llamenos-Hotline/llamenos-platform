/**
 * espeak-ng, run as a subprocess — the offline speech engine the app image
 * ships (deploy/docker/Dockerfile). Text goes in on stdin, never on the
 * command line, and is read as plain text: no SSML, no option parsing.
 */
import { spawn } from 'node:child_process'

export interface SpeechEngine {
  /** Names the engine build: it changes whenever the same text would sound different */
  version(): Promise<string>
  /** Speak `text` with `voice`, returning the engine's WAV output */
  synthesize(text: string, voice: string): Promise<Uint8Array>
}

/** Words per minute: a little slower than espeak-ng's 175, which is hard to follow over a phone line */
const SPEECH_RATE_WPM = 150
const TIMEOUT_MS = 15_000

function run(binary: string, args: string[], stdin?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${binary} could not be run (${e.message}) — generated IVR speech needs it installed`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve(new Uint8Array(Buffer.concat(out)))
      const reason = signal ? `was killed (${signal})` : `exited ${code}`
      reject(new Error(`${binary} ${reason}: ${Buffer.concat(err).toString().trim()}`))
    })
    child.stdin.end(stdin ?? '')
  })
}

export class EspeakNgEngine implements SpeechEngine {
  private versionPromise: Promise<string> | null = null

  constructor(private readonly binary = 'espeak-ng') {}

  version(): Promise<string> {
    this.versionPromise ??= run(this.binary, ['--version']).then((out) => {
      const match = /text-to-speech:\s*(\S+)/.exec(new TextDecoder().decode(out))
      if (!match) throw new Error(`Unrecognised ${this.binary} --version output`)
      return `espeak-ng ${match[1]} ${SPEECH_RATE_WPM}wpm`
    })
    // A failed probe (not installed yet) must not be cached forever.
    this.versionPromise.catch(() => { this.versionPromise = null })
    return this.versionPromise
  }

  synthesize(text: string, voice: string): Promise<Uint8Array> {
    // -b 1: the input is UTF-8. --stdin: the text is the whole of stdin.
    return run(this.binary, ['-v', voice, '-s', String(SPEECH_RATE_WPM), '-b', '1', '--stdin', '--stdout'], text)
  }
}
