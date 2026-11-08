export interface ErrorDiagnosticEntry {
  message: string
  source?: string
  code?: string
  stack?: string
  occurredAt?: number | string
}
export interface ErrorDiagnosticInput extends ErrorDiagnosticEntry { recentErrors?: ErrorDiagnosticEntry[] }
export interface ErrorDiagnosticExportResult { success: boolean; canceled?: boolean; filePath?: string; error?: string }
export interface ErrorDiagnosticsAPI {
  /** Records only a bounded, immediately redacted error in memory. */
  recordError(error: ErrorDiagnosticEntry): Promise<void>
  /** Opens a native save dialog. Renderer-provided paths are never accepted. */
  exportErrorLog(error: ErrorDiagnosticInput): Promise<ErrorDiagnosticExportResult>
}
export interface ErrorDiagnosticsBuildInfo {
  edition: 'standard' | 'geek' | 'demo' | 'unknown'
  hardening: 'bla-balanced' | 'none' | 'unknown'
  version?: string
}
