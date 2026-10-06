/**
 * A minimal SIP user agent over TCP that plays the part of a volunteer's app:
 * it REGISTERs with the credential `/api/telephony/sip-token` issued, stays
 * registered, and reports the requests the PBX sends it.
 *
 * It exists for one claim: that an INVITE actually arrives at the volunteer's
 * AOR. Asserting that our code called a function proves nothing about that —
 * this is the receiving end, and `waitForRequest('INVITE')` returns the SIP
 * message as the volunteer's endpoint received it.
 *
 * Requests are answered the moment they arrive, not when a test happens to be
 * waiting for one. That is not a detail: the volunteer AOR is provisioned with
 * `qualify_frequency`, so an OPTIONS left unanswered for three seconds marks
 * the contact Unreachable and the endpoint `offline` — which is exactly the
 * staleness the ringing path reads endpoint state to detect, and it would be
 * self-inflicted here.
 *
 * Deliberately NOT a media endpoint. It answers 180 Ringing (which is what a
 * ringing device sends) and declines; two-way audio needs the DTLS-SRTP
 * agreement that is a separate item of #1188.
 *
 * Used by asterisk-inapp-ring.e2e.ts.
 */
import { createConnection, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { parseDigestChallenge, digestAuthorization } from './sip-register'

/** One SIP request the PBX sent this UA. */
export interface SipRequest {
  method: string
  /** The Request-URI — for an inbound call, the AOR the PBX dialled. */
  uri: string
  headers: Record<string, string>
  body: string
  /** The whole message, verbatim, for evidence. */
  raw: string
}

interface SipResponse {
  status: number
  headers: Record<string, string>
}

interface ParsedMessage {
  start: string
  headers: Record<string, string>
  body: string
  raw: string
}

export interface SipUaOptions {
  host: string
  port: number
  domain: string
  username: string
  password: string
  /** Registration lifetime asked for, in seconds. */
  expires?: number
}

/**
 * A registered volunteer endpoint. `register()` leaves the TCP connection
 * open: PJSIP reuses it to reach the rewritten contact, so the INVITE for a
 * call comes back down this same socket — the way a real client behind NAT
 * receives one.
 */
export class SipUa {
  private readonly socket: Socket
  private readonly callId = `${randomBytes(16).toString('hex')}@llamenos-ua-e2e`
  private readonly fromTag = randomBytes(8).toString('hex')
  private readonly toTag = randomBytes(8).toString('hex')
  private cseq = 0
  private closed = false

  /** TCP gives no message boundaries: headers end at the blank line, the body is Content-Length bytes. */
  private buffer = ''
  /** Requests received, newest last. Never dropped — a test asserts on absence too. */
  private readonly requests: SipRequest[] = []
  private readonly requestWaiters: Array<() => void> = []
  private readonly responseWaiters: Array<(r: SipResponse) => void> = []

  private constructor(socket: Socket, private readonly opts: SipUaOptions) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.drain()
    })
  }

  static async connect(opts: SipUaOptions): Promise<SipUa> {
    const socket = createConnection({ host: opts.host, port: opts.port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.setNoDelay(true)
    // The PBX dropping the connection at teardown is not a test failure.
    socket.on('error', () => {})
    return new SipUa(socket, opts)
  }

  // --- Framing -------------------------------------------------------------

  private drain(): void {
    for (;;) {
      // A bare CRLFCRLF is the TCP keep-alive ping (RFC 5626 §4.4.1), not a
      // message. Treated as one it parses as a request with no method and no
      // CSeq, and the 405 this UA used to answer it with made Asterisk log
      // PJSIP_EMISSINGHDR every 30 seconds.
      if (this.buffer.startsWith('\r\n')) {
        this.buffer = this.buffer.slice(2)
        continue
      }
      const headEnd = this.buffer.indexOf('\r\n\r\n')
      if (headEnd === -1) return
      const lines = this.buffer.slice(0, headEnd).split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const length = Number(headers['content-length'] ?? 0)
      const bodyStart = headEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const message: ParsedMessage = {
        start: lines[0],
        headers,
        body: this.buffer.slice(bodyStart, bodyStart + length),
        raw: this.buffer.slice(0, bodyStart + length),
      }
      this.buffer = this.buffer.slice(bodyStart + length)
      this.onMessage(message)
    }
  }

  private onMessage(message: ParsedMessage): void {
    if (message.start.startsWith('SIP/2.0')) {
      const response: SipResponse = { status: Number(message.start.split(' ')[1]), headers: message.headers }
      this.responseWaiters.shift()?.(response)
      return
    }
    this.handleRequest(message)
  }

  // --- Registration --------------------------------------------------------

  private get contact(): string {
    return `<sip:${this.opts.username}@${this.socket.localAddress}:${this.socket.localPort};transport=tcp>`
  }

  private send(message: string): void {
    if (!this.closed) this.socket.write(message)
  }

  private sendRegister(authorization?: string): void {
    this.cseq += 1
    const lines = [
      `REGISTER sip:${this.opts.domain} SIP/2.0`,
      `Via: SIP/2.0/TCP ${this.socket.localAddress}:${this.socket.localPort};branch=z9hG4bK${randomBytes(8).toString('hex')};rport`,
      `From: <sip:${this.opts.username}@${this.opts.domain}>;tag=${this.fromTag}`,
      `To: <sip:${this.opts.username}@${this.opts.domain}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} REGISTER`,
      `Contact: ${this.contact};expires=${this.opts.expires ?? 300}`,
      'Max-Forwards: 70',
      'Allow: INVITE, ACK, BYE, CANCEL, OPTIONS',
      'User-Agent: llamenos-inapp-ring-e2e',
      'Content-Length: 0',
    ]
    if (authorization) lines.splice(1, 0, `Authorization: ${authorization}`)
    this.send(lines.join('\r\n') + '\r\n\r\n')
  }

  /**
   * REGISTER, answering the digest challenge. Resolves with the final status
   * (200 = the endpoint is live on the PBX).
   */
  async register(): Promise<number> {
    this.sendRegister()
    const challenge = await this.nextResponse(10_000)
    if (challenge.status !== 401) return challenge.status
    const header = challenge.headers['www-authenticate']
    if (!header) throw new Error('401 without WWW-Authenticate')
    this.sendRegister(
      digestAuthorization(
        parseDigestChallenge(header.replace(/^Digest\s+/i, '')),
        { username: this.opts.username, password: this.opts.password },
        'REGISTER',
        `sip:${this.opts.domain}`,
        randomBytes(8).toString('hex'),
      ),
    )
    return (await this.nextResponse(10_000)).status
  }

  private nextResponse(timeoutMs: number): Promise<SipResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.responseWaiters.indexOf(settle)
        if (index >= 0) this.responseWaiters.splice(index, 1)
        reject(new Error('the PBX sent no response'))
      }, timeoutMs)
      const settle = (r: SipResponse) => {
        clearTimeout(timer)
        resolve(r)
      }
      this.responseWaiters.push(settle)
    })
  }

  // --- Inbound requests ----------------------------------------------------

  /**
   * The first request with this method that has not been claimed, waiting up
   * to `timeoutMs`; null if none arrives. Null is a real answer, not a
   * failure: a volunteer who is off shift must not be INVITEd.
   */
  async waitForRequest(method: string, timeoutMs: number): Promise<SipRequest | null> {
    const claim = () => {
      const index = this.requests.findIndex((r) => r.method === method)
      return index >= 0 ? this.requests.splice(index, 1)[0] : null
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = claim()
      if (found) return found
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const index = this.requestWaiters.indexOf(wake)
          if (index >= 0) this.requestWaiters.splice(index, 1)
          resolve()
        }, remaining)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        this.requestWaiters.push(wake)
      })
    }
  }

  /**
   * Answer the automatic parts of being a SIP endpoint, then record the
   * request so a test can assert on it.
   */
  private handleRequest(message: ParsedMessage): void {
    const [method, uri] = message.start.split(' ')
    const request: SipRequest = {
      method,
      uri: uri ?? '',
      headers: message.headers,
      body: message.body,
      raw: message.raw,
    }

    switch (method) {
      case 'OPTIONS':
        // The qualify. Answer first, record after: three seconds of silence
        // here is the endpoint going offline.
        this.respond(request, 200, 'OK')
        break
      case 'INVITE':
        // What a ringing device sends. The call is then declined rather than
        // answered (declineInvite): answering needs DTLS-SRTP, #1188.
        this.respond(request, 100, 'Trying')
        this.respond(request, 180, 'Ringing')
        break
      case 'ACK':
        break
      case 'CANCEL':
      case 'BYE':
      case 'NOTIFY':
        this.respond(request, 200, 'OK')
        break
      default:
        this.respond(request, 405, 'Method Not Allowed')
    }

    this.requests.push(request)
    while (this.requestWaiters.length > 0) this.requestWaiters.shift()?.()
  }

  /** Decline a ringing call: the leg ends, as "the volunteer did not take it". */
  declineInvite(invite: SipRequest): void {
    this.respond(invite, 480, 'Temporarily Unavailable')
  }

  private respond(request: SipRequest, status: number, reason: string): void {
    const lines = [`SIP/2.0 ${status} ${reason}`]
    for (const [header, name] of [
      ['via', 'Via'],
      ['from', 'From'],
      ['call-id', 'Call-ID'],
      ['cseq', 'CSeq'],
    ] as const) {
      const value = request.headers[header]
      if (value) lines.push(`${name}: ${value}`)
    }
    const to = request.headers['to']
    if (to) lines.push(`To: ${to.includes('tag=') ? to : `${to};tag=${this.toTag}`}`)
    if (request.method === 'INVITE' && status >= 180 && status < 200) lines.push(`Contact: ${this.contact}`)
    lines.push('Content-Length: 0')
    this.send(lines.join('\r\n') + '\r\n\r\n')
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }
}
