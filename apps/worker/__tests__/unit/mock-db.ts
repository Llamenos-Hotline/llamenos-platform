import { vi } from 'vitest'

function makeChainable<T>(result: T, methods: Record<string, any>) {
  const p = Promise.resolve(result) as Promise<T> & Record<string, any>
  for (const [key, val] of Object.entries(methods)) {
    p[key] = val
  }
  return p
}

export function createMockDb(tables: string[] = []) {
  const store: Record<string, any[]> = {}
  for (const t of tables) store[t] = []

  let _selectResults: any[][] = []
  let _selectIndex = 0
  let _insertResult: any[] = []
  let _updateResult: any[] = []
  let _deleteResult: any[] = []
  let _executeResult: any = null

  function nextSelect() {
    const result = _selectResults[_selectIndex] ?? []
    _selectIndex++
    return result
  }

  const reset = () => {
    for (const t of tables) store[t] = []
    _selectResults = []
    _selectIndex = 0
    _insertResult = []
    _updateResult = []
    _deleteResult = []
    _executeResult = null
  }

  function buildSelectChain(result: any[]) {
    const limitFn = vi.fn((n?: number) =>
      makeChainable(result.slice(0, n ?? result.length), {
        offset: vi.fn(() => Promise.resolve(result)),
      })
    )

    const orderByFn = vi.fn(() =>
      makeChainable(result, {
        limit: limitFn,
        offset: vi.fn(() => Promise.resolve(result)),
      })
    )

    const groupByFn = vi.fn(() =>
      makeChainable(result, {
        orderBy: vi.fn(() => Promise.resolve(result)),
      })
    )

    const offsetFn = vi.fn(() => Promise.resolve(result))

    const forFn = vi.fn(() =>
      makeChainable(result, {
        limit: limitFn,
        offset: offsetFn,
      })
    )

    return makeChainable(result, {
      limit: limitFn,
      orderBy: orderByFn,
      offset: offsetFn,
      groupBy: groupByFn,
      for: forFn,
    })
  }

  const db = {
    $store: store,
    $setSelectResult: (rows: any[]) => { _selectResults = [rows]; _selectIndex = 0 },
    $setSelectResults: (results: any[][]) => { _selectResults = results; _selectIndex = 0 },
    $setInsertResult: (rows: any[]) => { _insertResult = rows },
    $setUpdateResult: (rows: any[]) => { _updateResult = rows },
    $setDeleteResult: (rows: any[]) => { _deleteResult = rows },
    $setExecuteResult: (result: any) => { _executeResult = result },
    $reset: reset,

    select: vi.fn(() => {
      const result = nextSelect()
      return {
        from: vi.fn(() => {
          const whereFn = vi.fn(() => buildSelectChain(result))
          const limitFn = vi.fn((n?: number) =>
            makeChainable(result.slice(0, n ?? result.length), {
              offset: vi.fn(() => Promise.resolve(result)),
            })
          )
          const orderByFn = vi.fn(() =>
            makeChainable(result, {
              limit: limitFn,
              offset: vi.fn(() => Promise.resolve(result)),
            })
          )
          const groupByFn = vi.fn(() =>
            makeChainable(result, {
              orderBy: vi.fn(() => Promise.resolve(result)),
            })
          )

          const leftJoinFn = vi.fn(() =>
            makeChainable(result, {
              where: whereFn,
              limit: limitFn,
              orderBy: orderByFn,
              groupBy: groupByFn,
            })
          )

          return makeChainable(result, {
            where: whereFn,
            limit: limitFn,
            orderBy: orderByFn,
            groupBy: groupByFn,
            leftJoin: leftJoinFn,
          })
        }),
      }
    }),

    insert: vi.fn(() => ({
      values: vi.fn(() => {
        const returningFn = vi.fn(() => Promise.resolve(_insertResult))
        const onConflictDoUpdateFn = vi.fn(() =>
          makeChainable(_insertResult, {
            returning: returningFn,
          })
        )
        const onConflictDoNothingFn = vi.fn(() =>
          makeChainable(_insertResult, {
            returning: returningFn,
          })
        )

        return makeChainable(_insertResult, {
          returning: returningFn,
          onConflictDoUpdate: onConflictDoUpdateFn,
          onConflictDoNothing: onConflictDoNothingFn,
        })
      }),
    })),

    update: vi.fn(() => ({
      set: vi.fn(() => {
        const whereFn = vi.fn(() =>
          makeChainable(_updateResult, {
            returning: vi.fn(() => Promise.resolve(_updateResult)),
          })
        )
        return { where: whereFn }
      }),
    })),

    delete: vi.fn(() => ({
      where: vi.fn(() =>
        makeChainable(_deleteResult, {
          returning: vi.fn(() => Promise.resolve(_deleteResult)),
        })
      ),
    })),

    execute: vi.fn(() => Promise.resolve(_executeResult)),

    // The mock has no real transactional isolation — unit tests exercise
    // business logic against canned select/insert/update results, not
    // actual atomicity, which is covered separately by the
    // integration-level concurrency tests. Running the callback against
    // the same mock `db` is sufficient for that purpose.
    transaction: vi.fn((cb: (tx: any) => Promise<unknown>) => cb(db)),
  }

  return { db, store, reset }
}
