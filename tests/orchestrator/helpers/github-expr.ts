/**
 * Evaluates the subset of GitHub Actions `${{ }}` expressions the workflows
 * use in job `name:`, `concurrency.group` and `runs-on`, so a rail can ask
 * what a job is CALLED, and which concurrency group a run JOINS, on a given
 * event — rather than matching the YAML text, which says nothing once a name
 * is an expression (#2813).
 *
 * Supported: string/number/boolean/null literals, property paths
 * (`github.event.pull_request.number`), `!`, `==`, `!=`, `&&`, `||`,
 * parentheses, and the functions `contains`, `fromJSON`, `format`,
 * `startsWith`, `endsWith`. Semantics follow GitHub's documentation:
 * `&&`/`||` return an OPERAND (not a boolean), falsy is `false`, `0`, `''`,
 * `null` and a missing property, and string equality ignores case.
 *
 * Anything outside the subset THROWS: a rail that silently mis-evaluated an
 * unfamiliar construct would assert against a value GitHub never produces.
 */

export type ExprValue = string | number | boolean | null | ExprValue[] | { [k: string]: ExprValue }

type Token =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in expression: ${src}`)
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue }
          i++
          break
        }
        s += src[i]
        i++
      }
      out.push({ t: 'str', v: s })
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '&&' || two === '||' || two === '<=' || two === '>=') {
      out.push({ t: 'op', v: two }); i += 2; continue
    }
    if ('()!,.[]<>'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    const num = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))
    if (num !== null && !/[A-Za-z_]/.test(src[i - 1] ?? '')) {
      out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))
    if (id !== null) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue }
    throw new Error(`unsupported character "${c}" in expression: ${src}`)
  }
  return out
}

export function truthy(v: ExprValue | undefined): boolean {
  return !(v === undefined || v === null || v === false || v === 0 || v === '')
}

function str(v: ExprValue | undefined): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function eq(a: ExprValue | undefined, b: ExprValue | undefined): boolean {
  const an = a === undefined ? null : a
  const bn = b === undefined ? null : b
  if (typeof an === 'string' && typeof bn === 'string') return an.toLowerCase() === bn.toLowerCase()
  if (typeof an === 'object' || typeof bn === 'object') return an === bn
  // GitHub coerces mismatched primitives to numbers; the workflows never rely
  // on that, so refuse rather than guess.
  if (typeof an !== typeof bn) throw new Error(`comparison of ${typeof an} with ${typeof bn} is outside this evaluator's subset`)
  return an === bn
}

const FUNCTIONS: Record<string, (args: (ExprValue | undefined)[]) => ExprValue> = {
  contains: ([hay, needle]) => {
    if (Array.isArray(hay)) return hay.some((x) => eq(x, needle))
    return str(hay).toLowerCase().includes(str(needle).toLowerCase())
  },
  fromJSON: ([s]) => JSON.parse(str(s)) as ExprValue,
  format: ([fmt, ...rest]) => str(fmt).replace(/\{(\d+)\}/g, (_m, n: string) => str(rest[Number(n)])),
  startsWith: ([s, p]) => str(s).toLowerCase().startsWith(str(p).toLowerCase()),
  endsWith: ([s, p]) => str(s).toLowerCase().endsWith(str(p).toLowerCase()),
}

class Parser {
  private i = 0
  constructor(private readonly toks: Token[], private readonly ctx: Record<string, ExprValue>, private readonly src: string) {}

  parse(): ExprValue | undefined {
    const v = this.or()
    if (this.i !== this.toks.length) throw new Error(`trailing tokens in expression: ${this.src}`)
    return v
  }

  private peek(v: string): boolean {
    const t = this.toks[this.i]
    return t !== undefined && t.t === 'op' && t.v === v
  }

  private expect(v: string): void {
    if (!this.peek(v)) throw new Error(`expected "${v}" in expression: ${this.src}`)
    this.i++
  }

  private or(): ExprValue | undefined {
    let l = this.and()
    while (this.peek('||')) { this.i++; const r = this.and(); l = truthy(l) ? l : r }
    return l
  }

  private and(): ExprValue | undefined {
    let l = this.cmp()
    while (this.peek('&&')) { this.i++; const r = this.cmp(); l = truthy(l) ? r : l }
    return l
  }

  private cmp(): ExprValue | undefined {
    const l = this.unary()
    if (this.peek('==')) { this.i++; return eq(l, this.unary()) }
    if (this.peek('!=')) { this.i++; return !eq(l, this.unary()) }
    for (const op of ['<', '>', '<=', '>=']) {
      if (this.peek(op)) throw new Error(`"${op}" is outside this evaluator's subset: ${this.src}`)
    }
    return l
  }

  private unary(): ExprValue | undefined {
    if (this.peek('!')) { this.i++; return !truthy(this.unary()) }
    return this.primary()
  }

  private primary(): ExprValue | undefined {
    const t = this.toks[this.i]
    if (t === undefined) throw new Error(`unexpected end of expression: ${this.src}`)
    if (t.t === 'op' && t.v === '(') {
      this.i++
      const v = this.or()
      this.expect(')')
      return v
    }
    if (t.t === 'str' || t.t === 'num') { this.i++; return t.v }
    if (t.t !== 'id') throw new Error(`unexpected "${t.v}" in expression: ${this.src}`)
    this.i++
    if (t.v === 'true') return true
    if (t.v === 'false') return false
    if (t.v === 'null') return null
    if (this.peek('(')) {
      const fn = FUNCTIONS[t.v]
      if (fn === undefined) throw new Error(`function ${t.v}() is outside this evaluator's subset: ${this.src}`)
      this.i++
      const args: (ExprValue | undefined)[] = []
      if (!this.peek(')')) {
        args.push(this.or())
        while (this.peek(',')) { this.i++; args.push(this.or()) }
      }
      this.expect(')')
      return fn(args)
    }
    let v: ExprValue | undefined = this.ctx[t.v]
    while (this.peek('.')) {
      this.i++
      const key = this.toks[this.i]
      if (key === undefined || key.t !== 'id') throw new Error(`bad property access in expression: ${this.src}`)
      this.i++
      v = v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v[key.v] : undefined
    }
    return v
  }
}

/** One bare expression (the text between `${{` and `}}`). */
export function evalExpression(src: string, ctx: Record<string, ExprValue>): ExprValue | undefined {
  return new Parser(tokenize(src), ctx, src).parse()
}

/**
 * A YAML scalar as GitHub evaluates it: a value that is exactly one
 * `${{ … }}` yields that expression's value; any other text is a string with
 * every `${{ … }}` interpolated.
 */
export function evalTemplate(text: string, ctx: Record<string, ExprValue>): ExprValue | undefined {
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text)
  if (whole !== null && !(whole[1] ?? '').includes('}}')) return evalExpression(whole[1] ?? '', ctx)
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) => str(evalExpression(e, ctx)))
}
