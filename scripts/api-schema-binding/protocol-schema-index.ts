/**
 * protocol-schema-index.ts — deterministic index over `packages/protocol/schemas/**`:
 *
 *  - which PascalCase `export type X = z.infer|input|output<typeof someSchema>` aliases exist
 *    for a given Zod schema identifier (there can be zero, one, or more)
 *  - a best-effort structural field list for a schema identifier, by resolving
 *    `z.object({...})` / `.extend({...})` / `.pick({...})` / `.omit({...})` /
 *    `.partial()` chains — enough to reproduce exactly the kind of diff this
 *    tool exists to catch ("client sends 4 fields, schema defines 10").
 *
 * This walks committed `.ts` source only — no gitignored codegen output, no
 * runtime schema introspection.
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { parseFile } from './ast-utils'

const SCHEMAS_DIR = resolve(import.meta.dirname, '../../packages/protocol/schemas')

interface SchemaFile {
  file: string
  sf: ts.SourceFile
}

function schemaFiles(dir: string = SCHEMAS_DIR): SchemaFile[] {
  // Recurse: `schemas/provider-setup/` is re-exported from the barrel (`export * from './provider-setup'`)
  // and holds routes' schemas, so a top-level-only scan reported them as having no declaring file.
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => {
      const file = join(dir, e.name)
      if (e.isDirectory()) return schemaFiles(file)
      return e.isFile() && e.name.endsWith('.ts') ? [{ file, sf: parseFile(file) }] : []
    })
}

export interface ProtocolSchemaIndex {
  /** schema identifier (e.g. "userListResponseSchema") -> exported type alias names referencing it */
  typeAliasesBySchema: Map<string, string[]>
  /** schema identifier -> the file that declares it, for pointing a human at where to add a missing type alias */
  declaringFile: Map<string, string>
  /** Best-effort top-level field names for a schema identifier. undefined = could not be statically resolved. */
  resolveFields(schemaIdent: string): string[] | undefined
}

export function buildProtocolSchemaIndex(): ProtocolSchemaIndex {
  const files = schemaFiles()
  const typeAliasesBySchema = new Map<string, string[]>()
  const declExprs = new Map<string, { file: string; expr: ts.Expression }>()
  const declaringFile = new Map<string, string>()

  for (const { file, sf } of files) {
    for (const stmt of sf.statements) {
      // export type X = z.infer<typeof schemaIdent>
      if (ts.isTypeAliasDeclaration(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const t = stmt.type
        if (ts.isTypeReferenceNode(t) && t.typeArguments?.[0]) {
          const typeNameText = t.typeName.getText(sf)
          const arg = t.typeArguments[0]
          // `z.input` is the right alias for a REQUEST body (defaulted fields stay optional for
          // the sender); `z.infer`/`z.output` for a response. All three bind a type to its schema.
          if (['z.infer', 'z.input', 'z.output'].includes(typeNameText) && ts.isTypeQueryNode(arg) && ts.isIdentifier(arg.exprName)) {
            const schemaIdent = arg.exprName.text
            const list = typeAliasesBySchema.get(schemaIdent) ?? []
            list.push(stmt.name.text)
            typeAliasesBySchema.set(schemaIdent, list)
          }
        }
      }
      // export const schemaIdent = <expr>  (captures every exported const, filtered to *Schema below on lookup)
      if (ts.isVariableStatement(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            declExprs.set(decl.name.text, { file, expr: decl.initializer })
            declaringFile.set(decl.name.text, file)
          }
        }
      }
    }
  }

  function objectLiteralKeys(obj: ts.ObjectLiteralExpression): string[] {
    return obj.properties
      .map(p => {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text
        }
        return undefined
      })
      .filter((x): x is string => !!x)
  }

  const resolving = new Set<string>()

  function resolveFields(schemaIdent: string): string[] | undefined {
    if (resolving.has(schemaIdent)) return undefined // cycle guard
    resolving.add(schemaIdent)
    try {
      const decl = declExprs.get(schemaIdent)
      if (!decl) return undefined
      return resolveExpr(decl.expr)
    } finally {
      resolving.delete(schemaIdent)
    }
  }

  function resolveExpr(expr: ts.Expression): string[] | undefined {
    // z.object({ ... })
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
        ts.isIdentifier(expr.expression.expression) && expr.expression.expression.text === 'z') {
      const method = expr.expression.name.text
      const arg = expr.arguments[0]
      if (method === 'object' && arg && ts.isObjectLiteralExpression(arg)) {
        return objectLiteralKeys(arg)
      }
      return undefined
    }
    // someSchema.extend({...}) / .pick({...}) / .omit({...}) / .partial() / .strict() / .passthrough()
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const method = expr.expression.name.text
      const base = resolveExpr(expr.expression.expression)
      const arg = expr.arguments[0]
      if (method === 'extend' && base && arg && ts.isObjectLiteralExpression(arg)) {
        return [...new Set([...base, ...objectLiteralKeys(arg)])]
      }
      if (method === 'pick' && base && arg && ts.isObjectLiteralExpression(arg)) {
        const keep = new Set(objectLiteralKeys(arg))
        return base.filter(k => keep.has(k))
      }
      if (method === 'omit' && base && arg && ts.isObjectLiteralExpression(arg)) {
        const drop = new Set(objectLiteralKeys(arg))
        return base.filter(k => !drop.has(k))
      }
      if (['partial', 'strict', 'passthrough', 'required', 'catchall', 'readonly'].includes(method)) {
        return base
      }
      return undefined
    }
    // A bare identifier reference to another exported schema const.
    if (ts.isIdentifier(expr)) return resolveFields(expr.text)
    return undefined
  }

  return { typeAliasesBySchema, declaringFile, resolveFields }
}
