import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

interface ToastContextType {
  toast: (message: string, type?: Toast['type']) => void
}

/**
 * After an explicit sign-out, requests that were already in flight are answered
 * 401 (the session was just revoked) and their callers each raise an error
 * toast on the login screen. Those failures are an artefact of signing out, not
 * something the user can act on, so error toasts are dropped from sign-out until
 * the next unlock. Module-level because `ToastProvider` sits above `AuthProvider`.
 */
let errorToastsSuppressed = false
export function setErrorToastsSuppressed(suppressed: boolean): void {
  errorToastsSuppressed = suppressed
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    if (type === 'error' && errorToastsSuppressed) return
    const id = crypto.randomUUID()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, import.meta.env.PLAYWRIGHT_TEST ? 8000 : 4000)
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map(t => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            data-testid={t.type === 'success' ? 'toast-success' : t.type === 'error' ? 'toast-error' : 'toast-info'}
            className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm shadow-lg transition-all animate-in slide-in-from-right ${
              t.type === 'error'
                ? 'bg-red-900/90 text-red-100 border border-red-700'
                : t.type === 'success'
                  ? 'bg-emerald-900/90 text-emerald-100 border border-emerald-700'
                  : 'bg-zinc-800/90 text-zinc-100 border border-zinc-700'
            }`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="ml-2 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="Dismiss"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
