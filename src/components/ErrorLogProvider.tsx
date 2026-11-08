import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, X } from 'lucide-react'
import ErrorLogAction, { errorDiagnostic, recordErrorDiagnostic } from './ErrorLogAction'
import type { ErrorDiagnosticEntry } from '../../shared/errorDiagnostics'

type ErrorNotice = ErrorDiagnosticEntry & { id: number }
let sequence = 0
const listeners = new Set<(entry: ErrorNotice) => void>()

/** Explicit alternative to a native alert: keeps the diagnostic download action available. */
export function reportApplicationError(error: unknown, source: string) {
  const entry = { ...errorDiagnostic(error, source), id: ++sequence }
  recordErrorDiagnostic(entry)
  listeners.forEach(listener => listener(entry))
}

export default function ErrorLogProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<ErrorNotice[]>([])
  useEffect(() => {
    const show = (entry: ErrorNotice) => setErrors(previous => [...previous.filter(item => item.message !== entry.message || item.source !== entry.source), entry].slice(-3))
    const onError = (event: ErrorEvent) => reportApplicationError(event.error || event.message, 'renderer.unhandled-error')
    const onRejection = (event: PromiseRejectionEvent) => reportApplicationError(event.reason, 'renderer.unhandled-rejection')
    listeners.add(show)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => { listeners.delete(show); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
  }, [])
  return <>{children}{errors.length > 0 && <aside className="error-log-notices" aria-label="应用错误诊断">{errors.map(entry => <section className="error-log-notice" role="alert" key={entry.id}>
    <CircleAlert size={18} aria-hidden="true"/><div><strong>这项操作遇到了问题</strong><p>{entry.source?.startsWith('renderer.unhandled') ? '应用发生未处理错误，可以下载诊断日志排查。' : entry.message}</p><ErrorLogAction error={entry} source={entry.source} record={false}/></div><button type="button" className="error-log-dismiss" aria-label="关闭错误通知" onClick={() => setErrors(current => current.filter(item => item.id !== entry.id))}><X size={16}/></button>
  </section>)}</aside>}</>
}
