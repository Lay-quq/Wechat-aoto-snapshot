/** Public edition contract: local reading, export and presentation only. */
export type StandardFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'markdown' | 'txt' | 'excel' | 'weclone' | 'sql'
export interface StandardSession { id: string; name: string; preview: string; timestamp: number; avatar?: string; group: boolean }
export interface StandardMessage { id: string; timestamp: number; sender: string; mine: boolean; type: number; text: string; raw: string; imageMd5?: string }
export interface StandardSnapshot { connected: boolean; connecting: boolean; locked: boolean; helloAvailable?: boolean; accountName?: string; error?: string; exportJob?: { id: string; state: 'running' | 'completed' | 'cancelled' | 'failed'; current: number; total: number; message: string; error?: string; outputDirectory?: string } }
export interface StandardExportOptions { format: StandardFormat; dateRange?: { start: number; end: number }; exportMedia: boolean; exportAvatars: boolean; sessionLayout: 'shared' | 'per-session'; conflict: 'rename' | 'incremental' }
export interface StandardGroupInfo { groupName: string; groupNumber: string; joinUrl: string; telegramUrl: string }
export interface StandardAPI {
  diagnostics: import('./errorDiagnostics').ErrorDiagnosticsAPI
  snapshot(): Promise<StandardSnapshot>
  connect(): Promise<StandardSnapshot>
  cancelConnection(): Promise<StandardSnapshot>
  unlock(password: string): Promise<StandardSnapshot>
  hello(): Promise<StandardSnapshot>
  lock(): Promise<StandardSnapshot>
  sessions(): Promise<StandardSession[]>
  messages(sessionId: string, offset: number): Promise<{ messages: StandardMessage[]; hasMore: boolean }>
  export(sessionIds: string[], options: StandardExportOptions): Promise<StandardSnapshot>
  cancelExport(): Promise<StandardSnapshot>
  avatar(sessionId: string): Promise<string | undefined>
  image(sessionId: string, messageId: string): Promise<string | undefined>
  media(sessionId: string, messageId: string): Promise<{ kind: 'audio' | 'video'; url: string } | undefined>
  groupInfo(): Promise<StandardGroupInfo>
  openGroup(channel?: 'qq' | 'telegram'): Promise<void>
  copyGroupNumber(): Promise<void>
  openExportDirectory(): Promise<void>
  window(action: 'minimize' | 'maximize' | 'close'): void
  onChanged(listener: (snapshot: StandardSnapshot) => void): () => void
}
