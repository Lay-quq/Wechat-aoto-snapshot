import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import type { ErrorDiagnosticEntry, ErrorDiagnosticsAPI } from '../../shared/errorDiagnostics'
import './ErrorLogAction.scss'

const diagnosticsAPI = () => {
  const host = window as unknown as { electronAPI?: { diagnostics?: ErrorDiagnosticsAPI }; standardAPI?: { diagnostics?: ErrorDiagnosticsAPI } }
  return host.electronAPI?.diagnostics || host.standardAPI?.diagnostics
}

/** Mixed status/error banners keep an explicit error bit; ordinary status text gets no log control. */
export function useDiagnosticNotice() {
  const [value, setValue] = useState({ message: '', error: false })
  const setNotice = useCallback((message: string, error = false) => setValue({ message, error: Boolean(message) && error }), [])
  return [value.message, setNotice, value.error] as const
}

/** Accept explicit diagnostic values only; never read page text, form values or chat content. */
export function errorDiagnostic(error: unknown, source = 'renderer'): ErrorDiagnosticEntry {
  const item = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; stack?: unknown; occurredAt?: unknown } : undefined
  const message = typeof item?.message === 'string' ? item.message : typeof error === 'string' ? error : '操作未完成，未提供详细诊断'
  const occurredAt = typeof item?.occurredAt === 'number' && Number.isFinite(item.occurredAt) ? item.occurredAt
    : typeof item?.occurredAt === 'string' && Number.isFinite(Date.parse(item.occurredAt)) ? item.occurredAt : Date.now()
  return { message: message.slice(0, 6000), source, occurredAt,
    ...(typeof item?.code === 'string' ? { code: item.code.slice(0, 100) } : {}),
    ...(typeof item?.stack === 'string' ? { stack: item.stack.slice(0, 12000) } : {}) }
}

export function recordErrorDiagnostic(entry: ErrorDiagnosticEntry) {
  // Reporting must never produce another application error or capture export failures recursively.
  try { void diagnosticsAPI()?.recordError?.(entry).catch(() => {}) } catch { /* optional in old previews */ }
}

export default function ErrorLogAction({ error, source = 'renderer', className = '', record = true }: { error: unknown; source?: string; className?: string; record?: boolean }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'cancelled' | 'failed'>('idle')
  const [failure, setFailure] = useState('')
  const pending = useRef(false)
  const mounted = useRef(false)
  const candidate = errorDiagnostic(error, source)
  const identity = `${source}\n${candidate.code || ''}\n${candidate.message}\n${candidate.stack || ''}`
  const observed = useRef({ identity, entry: candidate })
  if (observed.current.identity !== identity) observed.current = { identity, entry: candidate }
  const entry = observed.current.entry
  const current = useRef(identity)
  current.current = identity
  const seen = useRef('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setState(pending.current ? 'saving' : 'idle'); setFailure('')
    if (record && seen.current !== identity) { seen.current = identity; recordErrorDiagnostic(entry) }
  }, [identity, record])
  const save = async () => {
    if (pending.current) return
    pending.current = true
    const expected = identity
    setState('saving'); setFailure('')
    try {
      const api = diagnosticsAPI()
      if (!api?.exportErrorLog) throw new Error('当前窗口的日志接口尚未就绪，请重新打开应用后重试。')
      const result = await api.exportErrorLog(entry)
      if (!mounted.current || current.current !== expected) return
      if (result.canceled) setState('cancelled')
      else if (result.success) setState('saved')
      else { setState('failed'); setFailure(result.error || '日志保存未完成，请重试。') }
    } catch {
      if (mounted.current && current.current === expected) { setState('failed'); setFailure('日志保存未完成，请重试；若仍失败，请重新打开应用。') }
    } finally { pending.current = false; if (mounted.current && current.current !== expected) setState('idle') }
  }
  return <span className={`error-log-action ${className}`.trim()} data-error-log-source={source} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
    <button type="button" className="error-log-download" disabled={state === 'saving'} onClick={() => void save()} title="保存脱敏错误诊断，便于定位问题">
      {state === 'saving' ? <LoaderCircle size={13} aria-hidden="true"/> : <Download size={13} aria-hidden="true"/>}{state === 'saving' ? '正在保存日志…' : state === 'failed' ? '重试下载日志' : '下载错误日志'}
    </button>
    {state !== 'idle' && state !== 'saving' && <span className={'error-log-feedback ' + state} role="status">{state === 'saved' ? '错误日志已保存' : state === 'cancelled' ? '已取消保存，可随时重试' : failure}</span>}
  </span>
}
