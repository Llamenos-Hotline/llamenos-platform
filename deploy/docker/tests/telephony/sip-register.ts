/**
 * A minimal SIP REGISTER client over TCP or verified TLS — just enough of RFC
 * 3261 to prove a provisioned endpoint authenticates through the real SIP edge:
 * challenge digest (MD5, qop-auth when offered), one REGISTER, final status.
 * No dialogs, bodies or retransmits: the stream framing gives message boundaries.
 *
 * Used by asterisk-register.e2e.ts — the live proof that the credentials
 * /api/telephony/sip-token issues register through Kamailio to Asterisk.
 */
import { createConnection, isIP, type Socket } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { connect as connectTls } from 'node:tls'
import { createSocket as createDgramSocket } from 'node:dgram'

export interface RegisterResult {
  status: number
  reason: string
}

// RFC 3261 §22.4 mandates MD5 for SIP digest authentication — the PBX
// (Asterisk) only ever issues MD5 challenges, so a REGISTER client cannot
// choose a stronger hash here.
// codeql[js/weak-cryptographic-algorithm] codeql[js/insufficient-password-hash]
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

export interface DigestChallenge {
  realm: string
  nonce: string
  qop?: string
  opaque?: string
}

export function parseDigestChallenge(header: string): DigestChallenge {
  const params: Record<string, string> = {}
  // realm="asterisk", nonce="…", qop="auth", opaque="…"
  for (const match of header.matchAll(/(\w+)="?([^",]+)"?/g)) {
    params[match[1].toLowerCase()] = match[2]
  }
  if (!params.realm || !params.nonce) throw new Error(`malformed WWW-Authenticate: ${header}`)
  return { realm: params.realm, nonce: params.nonce, qop: params.qop, opaque: params.opaque }
}

export function digestAuthorization(
  challenge: DigestChallenge,
  credentials: { username: string; password: string },
  method: string,
  uri: string,
  cnonce: string,
): string {
  const ha1 = md5(`${credentials.username}:${challenge.realm}:${credentials.password}`)
  const ha2 = md5(`${method}:${uri}`)
  let response: string
  let qopPart = ''
  if (challenge.qop) {
    // qop is a quoted list ("auth,auth-int") — honour only the RFC 3261 case.
    const qop = challenge.qop.split(',').map((q) => q.trim()).find((q) => q === 'auth')
    if (!qop) throw new Error(`unsupported qop: ${challenge.qop}`)
    response = md5(`${ha1}:${challenge.nonce}:00000001:${cnonce}:${qop}:${ha2}`)
    qopPart = `, qop=${qop}, nc=00000001, cnonce="${cnonce}"`
  } else {
    response = md5(`${ha1}:${challenge.nonce}:${ha2}`)
  }
  const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : ''
  return (
    `Digest username="${credentials.username}", realm="${challenge.realm}", ` +
    `nonce="${challenge.nonce}", uri="${uri}", response="${response}"${qopPart}${opaque}`
  )
}

function readSipMessage(socket: Socket, buffer: { rest: string }): Promise<{ status: number; reason: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let data = buffer.rest
    const onData = (chunk: Buffer) => {
      data += chunk.toString('utf8')
      const headEnd = data.indexOf('\r\n\r\n')
      if (headEnd === -1) return
      const head = data.slice(0, headEnd)
      buffer.rest = data.slice(headEnd + 4)
      const lines = head.split('\r\n')
      const [version, statusStr, ...reasonParts] = lines[0].split(' ')
      if (!version?.startsWith('SIP/2.0')) return // garbage; keep reading
      socket.off('data', onData)
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status: Number(statusStr), reason: reasonParts.join(' '), headers })
    }
    socket.on('data', onData)
    socket.once('error', reject)
    if (data) socket.emit('data', Buffer.alloc(0)) // re-examine what a previous message left
  })
}

/**
 * REGISTER `credentials.username` at `server` over TCP, answering the 401
 * challenge. Resolves with the final status (200 = registered, 401/403 =
 * refused). Everything else rejects.
 */
export async function registerOverTcp(opts: {
  host: string
  port: number
  domain: string
  username: string
  password: string
  expires?: number
}): Promise<RegisterResult> {
  return registerOverTransport(opts)
}

export async function registerOverTls(opts: {
  host: string
  port: number
  domain: string
  username: string
  password: string
  caPem: string
  expires?: number
}): Promise<RegisterResult> {
  if (!opts.caPem.trim()) throw new Error('TLS REGISTER requires the published SIP edge trust anchor')
  return registerOverTransport(opts, opts.caPem)
}

async function registerOverTransport(
  opts: {
    host: string
    port: number
    domain: string
    username: string
    password: string
    expires?: number
  },
  caPem?: string,
): Promise<RegisterResult> {
  const { host, port, domain, username, password } = opts
  const expires = opts.expires ?? 300
  const uri = `sip:${domain}`
  const cnonce = randomBytes(8).toString('hex')
  const callId = `${randomBytes(16).toString('hex')}@llamenos-register-e2e`
  const fromTag = randomBytes(8).toString('hex')
  let cseq = 1

  const secure = caPem !== undefined
  const socket: Socket = secure
    ? connectTls({
        host,
        port,
        ca: caPem,
        rejectUnauthorized: true,
        ...(isIP(host) ? {} : { servername: host }),
      })
    : createConnection({ host, port })
  await new Promise<void>((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve())
    socket.once('error', reject)
  })
  socket.setNoDelay(true)

  const state = { rest: '' }
  try {
    const sendRegister = (authorization?: string) => {
      const viaBranch = `z9hG4bK${randomBytes(8).toString('hex')}`
      const transport = secure ? 'TLS' : 'TCP'
      const lines = [
        `REGISTER ${uri} SIP/2.0`,
        `Via: SIP/2.0/${transport} ${socket.localAddress}:${socket.localPort};branch=${viaBranch};rport`,
        `From: <sip:${username}@${domain}>;tag=${fromTag}`,
        `To: <sip:${username}@${domain}>`,
        `Call-ID: ${callId}`,
        `CSeq: ${cseq} REGISTER`,
        `Contact: <sip:${username}@${socket.localAddress}:${socket.localPort};transport=${secure ? 'tls' : 'tcp'}>;expires=${expires}`,
        'Max-Forwards: 70',
        'Allow: INVITE, ACK, BYE, CANCEL, OPTIONS',
        'User-Agent: llamenos-register-e2e',
        'Content-Length: 0',
      ]
      if (authorization) lines.splice(1, 0, `Authorization: ${authorization}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    }

    sendRegister()
    const challenge = await readSipMessage(socket, state)
    if (challenge.status !== 401) {
      return { status: challenge.status, reason: challenge.reason }
    }
    const wwwAuthenticate = challenge.headers['www-authenticate']
    if (!wwwAuthenticate) throw new Error('401 without WWW-Authenticate')
    const parsed = parseDigestChallenge(wwwAuthenticate.replace(/^Digest\s+/i, ''))

    cseq += 1
    sendRegister(digestAuthorization(parsed, { username, password }, 'REGISTER', uri, cnonce))
    const final = await readSipMessage(socket, state)
    return { status: final.status, reason: final.reason }
  } finally {
    socket.destroy()
  }
}

export type ProbeTransport = 'udp' | 'tcp' | 'tls'

/**
 * One SIP OPTIONS, one response, over any of the edge's three listeners. A
 * listener that is not bound fails the connect (or times the UDP wait out);
 * one that is bound but not SERVING never answers — both are the failure
 * modes of "the container is up but the edge is not" that #1688 is about.
 * Kamailio answers OPTIONS itself (route[REQINIT]), so a 200 proves the
 * listener and the request path without needing a provisioned credential.
 */
export async function probeOptions(opts: {
  host: string
  port: number
  transport: ProbeTransport
  domain: string
  caPem?: string
  timeoutMs?: number
}): Promise<RegisterResult> {
  const { host, port, transport, domain } = opts
  const timeoutMs = opts.timeoutMs ?? 5000
  const request = [
    `OPTIONS sip:${domain} SIP/2.0`,
    `Via: SIP/2.0/${transport.toUpperCase()} 127.0.0.1:9;branch=z9hG4bK${randomBytes(8).toString('hex')};rport`,
    `From: <sip:edge-probe@${domain}>;tag=${randomBytes(8).toString('hex')}`,
    `To: <sip:${domain}>`,
    `Call-ID: ${randomBytes(16).toString('hex')}@llamenos-edge-probe`,
    'CSeq: 1 OPTIONS',
    'Max-Forwards: 70',
    'User-Agent: llamenos-edge-probe',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n')

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`OPTIONS over ${transport} to ${host}:${port}: no response in ${timeoutMs}ms`)), timeoutMs),
  )

  if (transport === 'udp') {
    const exchange = new Promise<RegisterResult>((resolve, reject) => {
      const socket = createDgramSocket('udp4')
      socket.once('error', reject)
      socket.on('message', (msg: Buffer) => {
        const head = msg.toString('utf8').split('\r\n')[0]
        const [, statusStr, ...reasonParts] = head.split(' ')
        socket.close()
        resolve({ status: Number(statusStr), reason: reasonParts.join(' ') })
      })
      socket.send(request, port, host, (err: Error | null) => {
        if (err) {
          socket.close()
          reject(err)
        }
      })
    })
    return Promise.race([exchange, timeout])
  }

  const secure = transport === 'tls'
  const socket: Socket = secure
    ? connectTls({
        host,
        port,
        ca: opts.caPem,
        rejectUnauthorized: true,
        ...(isIP(host) ? {} : { servername: host }),
      })
    : createConnection({ host, port })
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        socket.once(secure ? 'secureConnect' : 'connect', () => resolve())
        socket.once('error', reject)
      }),
      timeout,
    ])
    const state = { rest: '' }
    socket.write(request)
    return await Promise.race([readSipMessage(socket, state), timeout])
  } finally {
    socket.destroy()
  }
}
