import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAgentSensitiveText, redactAgentTextForLog } from './agentTextRedaction'
import type { ErrorDiagnosticExportResult, ErrorDiagnosticsBuildInfo } from '../../shared/errorDiagnostics'

const MAX_RAW_CHARS = 49152
const MAX_REPORT_BYTES = 192 * 1024
const MAX_RECENT_ERRORS = 12
const MAX_RING_ERRORS = 30
const HIDDEN = '【已脱敏】'
const CONTENT_HIDDEN = '【请求内容已省略】'
const allowedJsonKeys = new Set(['error', 'errors', 'message', 'code', 'status', 'statuscode', 'type', 'name', 'cause', 'detail', 'reason', 'stack'])
const sensitiveLabel = /(?:["']?)(?:api[_ -]?key|access[_ -]?key|secret(?:[_ -]?key)?|private[_ -]?key|password|passwd|pwd|token|access[_ -]?token|refresh[_ -]?token|authorization|proxy-authorization|cookie|set-cookie|credential[s]?|session(?:[_ -]?id|[_ -]?hash)?|user[_ -]?id|device[_ -]?id|account[_ -]?id|wechat(?:[_ -]?hash)?|activeWechat|email|headers?|request(?:[_ -]?(?:body|payload))?|body|payload|messages?|content|prompt|system[_ -]?prompt|conversation|history|persona|tasks?|config(?:uration)?|sql|params|parameters|bindings|聊天记录|聊天内容|提示词|联系人|微信号|账号|密钥|令牌|密码|验证码)(?:["']?)\s*[:=]\s*/gi

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
function valueEnd(text: string, start: number, completion?: { closed: boolean }): number {
  if (completion) completion.closed = false
  const quote = text[start]
  if (quote === '"' || quote === "'") {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === '\\') { index++; continue }
      if (text[index] === quote) { if (completion) completion.closed = true; return index + 1 }
    }
    return text.length
  }
  if (quote === '{' || quote === '[') {
    let depth = 0, inString = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) { if (char === '\\') index++; else if (char === '"') inString = false; continue }
      if (char === '"') inString = true
      else if (char === '{' || char === '[') depth++
      else if ((char === '}' || char === ']') && --depth === 0) { if (completion) completion.closed = true; return index + 1 }
    }
    return text.length
  }
  const end = text.slice(start).search(/[\r\n,;}]/)
  return end < 0 ? text.length : start + end
}
function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return CONTENT_HIDDEN
  if (Array.isArray(value)) return CONTENT_HIDDEN
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, nested], index) => {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
      return allowedJsonKeys.has(normalized) ? [normalized, sanitizeJson(nested, depth + 1)] : [`omittedField${index + 1}`, CONTENT_HIDDEN]
    }))
  }
  if (typeof value === 'string') return redactErrorDiagnosticText(value.slice(0, 8192), 8192, depth + 1)
  return typeof value === 'number' && Math.abs(value) > 999999 ? HIDDEN : value
}
function publicStackLocation(path: string): string {
  const publicFile = path.trim().match(/(?:^|[\\/])((?:main|preload|standardMain|standardPreload|index(?:-[A-Za-z0-9_-]{1,80})?)\.js(?::\d{1,8}){0,2})$/)
  return '【本机路径】' + (publicFile ? '/' + publicFile[1] : '')
}
function redactPlainText(text: string): string {
  let result = text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN)
    .replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>]+/gi, raw => {
      try {
        const url = new URL(raw)
        if (url.protocol === 'file:') return publicStackLocation(url.pathname)
        const host = /^localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(url.hostname) ? 'localhost' : url.hostname
        return `${url.protocol}//${host}${url.port ? ':' + url.port : ''}${url.pathname !== '/' ? '/【路径已隐藏】' : '/'}${url.search ? '?【参数已隐藏】' : ''}${url.hash ? '#【片段已隐藏】' : ''}`
      } catch { return '【URL已隐藏】' }
    })
  // These fields can contain complete chat/request/config payloads, including
  // truncated JSON. Consume the entire value instead of redacting known keys only.
  sensitiveLabel.lastIndex = 0
  let output = '', cursor = 0, match: RegExpExecArray | null
  while ((match = sensitiveLabel.exec(result))) {
    const start = sensitiveLabel.lastIndex, end = valueEnd(result, start)
    output += result.slice(cursor, start) + '"' + CONTENT_HIDDEN + '"'
    cursor = Math.max(start, end); sensitiveLabel.lastIndex = cursor
    if (cursor >= result.length) break
  }
  result = output + result.slice(cursor)
  result = result
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer ' + HIDDEN)
    .replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, 'Basic ' + HIDDEN)
    .replace(/\bya29\.[A-Za-z0-9._-]+/gi, HIDDEN)
    .replace(/\b(?:sk[-_]|rk[-_]|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{8,}/gi, HIDDEN)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, HIDDEN)
    .replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '【邮箱】')
    .replace(/\bwxid_[A-Za-z0-9_-]+\b/g, '【微信账号】')
    .replace(/\b\d{5,}@chatroom\b/g, '【群聊标识】')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '【标识已隐藏】')
    .replace(/\b[a-f0-9]{32,}\b/gi, '【标识已隐藏】')
    .replace(/\b[A-Za-z0-9_+\/-]{40,}={0,2}/g, '【长标识已隐藏】')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>)]*/g, publicStackLocation)
    .replace(/\/(?:Users|home|tmp|private|var|mnt|etc|root|Volumes|data|app)\/[^\r\n"'<>)]*/g, publicStackLocation)
    .replace(/\b(?:SELECT\s+.+?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|PRAGMA\s+)\b[^\r\n]*/gi, '【SQL及参数已省略】')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  return redactAgentTextForLog(normalizeAgentSensitiveText(result))
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '【手机号或账号】')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '【长数字标识】')
}
export function redactErrorDiagnosticText(value: unknown, limit = 4096, depth = 0): string {
  if (typeof value !== 'string') return ''
  if (depth > 5) return CONTENT_HIDDEN
  const raw = value.slice(0, MAX_RAW_CHARS)
  let text = '', cursor = 0, attempts = 0
  // Decode structured payloads before masking: escaped JSON property names must
  // not bypass the content/credential boundary.
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '{' && raw[index] !== '[') continue
    if (++attempts > 32) break
    const completion = { closed: false }, end = valueEnd(raw, index, completion)
    if (!completion.closed) { text += raw.slice(cursor, index) + CONTENT_HIDDEN; cursor = raw.length; break }
    try {
      const parsed = JSON.parse(raw.slice(index, end))
      text += raw.slice(cursor, index) + JSON.stringify(sanitizeJson(parsed, depth))
      cursor = end; index = end - 1
    } catch { /* Non-JSON and truncated values are handled by the label mask. */ }
  }
  const redacted = redactPlainText(text + raw.slice(cursor))
  return redacted.length > limit ? redacted.slice(0, limit) + '…【已截断】' : redacted
}

type SafeEntry = { message: string; source: string; code?: string; stack?: string; occurredAt: string }
function normalizeEntry(value: unknown, compact = false): SafeEntry {
  const rawMessage = field(value, 'message')
  const message = redactErrorDiagnosticText(rawMessage, compact ? 1024 : 4096) || '未提供可导出的错误说明'
  const rawCode = field(value, 'code'), marker = typeof rawMessage === 'string' ? rawMessage.slice(0, 2048).match(/\[WCA_CODE:([A-Z][A-Z0-9_]{1,63})\]/)?.[1] : undefined
  const numericMarker = typeof rawMessage === 'string' ? rawMessage.slice(0, 2048).match(/(?:\b(?:code|errno|WCDB|SQLITE)\b|错误码)\s*[:=]?\s*(-\d{1,8})\b/i)?.[1] : undefined
  const candidate = typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? String(rawCode) : marker || numericMarker
  const code = candidate && /^(?:[A-Z]{2,20}(?:_[A-Z0-9]{1,20}){0,5}|-?\d{1,8})$/.test(candidate) ? candidate.slice(0, 64) : undefined
  const suppliedAt = field(value, 'occurredAt')
  const at = typeof suppliedAt === 'number' ? suppliedAt : typeof suppliedAt === 'string' && suppliedAt.length < 40 ? Date.parse(suppliedAt) : NaN
  const stack = redactErrorDiagnosticText(field(value, 'stack'), compact ? 1536 : 8192)
  return { message, source: redactErrorDiagnosticText(field(value, 'source'), 96) || 'application', ...(code ? { code } : {}), ...(stack ? { stack } : {}),
    occurredAt: new Date(Number.isFinite(at) && at >= 946684800000 && at <= Date.now() + 86400000 ? at : Date.now()).toISOString() }
}
function suggestions(error: SafeEntry): { category: string; steps: string[] } {
  if (['WECHAT_ACTIVITY_CHANGED', 'WECHAT_BIND_REQUIRED'].includes(error.code || '')) return { category: 'wechat_authorization', steps: ['在提示中点击“去授权”，确认当前会员账号、设备与微信。', '点击“绑定并启用当前微信”；成功后手动继续原操作。', '若再次失败，保留此脱敏日志联系支持；不要反复自动重试绑定。'] }
  if (error.code === 'WECHAT_SWITCH_PENDING') return { category: 'wechat_switch', steps: ['等待当前微信切换倒计时结束后再手动重试。', '切换期间不要启动其他聊天的自动回复。'] }
  if (error.code === 'ACCOUNT_NETWORK') return { category: 'account_network', steps: ['检查账号服务连接是否可用，再手动重试。', '确认当前代理设置符合自己的网络环境；此日志不会修改代理或网络。'] }
  if (/api.?key|unauthorized|authentication|\b401\b|鉴权/i.test(error.message)) return { category: 'model_credentials', steps: ['在对应模型配置中核对供应商、模型和凭据是否有效。', '不要发送或上传 API Key；此日志已尝试隐藏凭据。'] }
  if (/timeout|timed out|network|fetch failed|超时|连接失败|无法连接/i.test(error.message)) return { category: 'connection', steps: ['确认对应服务可访问后手动重试。', '保留错误码和发生时间，便于核对服务端状态。'] }
  if (/ENOENT|EACCES|EPERM|SQLITE|磁盘|目录|文件|存储/i.test(error.message + ' ' + error.code)) return { category: 'local_storage', steps: ['检查磁盘空间与所选目录的读写权限。', '保留原数据和配置；不要为排障直接删除数据库或凭据。'] }
  return { category: 'application', steps: ['记录刚才执行的操作，再在当前页面手动重试。', '如果持续失败，将此脱敏诊断文件交给支持人员，并补充可复现步骤。'] }
}

/** No filesystem reads, credentials, chat stores, model access, or network ports. */
export class ErrorDiagnosticsService {
  private recent: SafeEntry[] = []
  private exporting = false
  private readonly rates = new WeakMap<Electron.WebContents, { at: number; count: number }>()
  constructor(private readonly build: ErrorDiagnosticsBuildInfo) {}
  private ownWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('诊断操作来源无效')
    const frameUrl = event.senderFrame?.url || ''
    try {
      const url = new URL(frameUrl)
      if (url.protocol === 'file:') {
        const within = relative(resolve(app.getAppPath()), resolve(fileURLToPath(url)))
        if (within && !within.startsWith('..') && !isAbsolute(within)) return window
      } else if (!app.isPackaged && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password) return window
    } catch { /* Fail closed without echoing the rejected URL. */ }
    throw new Error('诊断操作来源无效')
  }
  recordError(event: Electron.IpcMainInvokeEvent, input: unknown): void {
    this.ownWindow(event)
    const now = Date.now(), previous = this.rates.get(event.sender)
    if (previous && now - previous.at < 1000 && previous.count >= 8) return
    this.rates.set(event.sender, !previous || now - previous.at >= 1000 ? { at: now, count: 1 } : { ...previous, count: previous.count + 1 })
    const error = normalizeEntry(input, true), last = this.recent[0]
    if (last && last.source === error.source && last.code === error.code && last.message === error.message && last.stack === error.stack) return
    this.recent.unshift(error); this.recent.length = Math.min(this.recent.length, MAX_RING_ERRORS)
  }
  private report(input: unknown): string {
    const selectedError = normalizeEntry(input)
    const provided = field(input, 'recentErrors')
    const recent = [...(Array.isArray(provided) ? Array.from({ length: Math.min(provided.length, MAX_RECENT_ERRORS) }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(provided, index)
      return normalizeEntry(item && 'value' in item ? item.value : undefined, true)
    }) : []), ...this.recent].slice(0, MAX_RECENT_ERRORS)
    const publicVersion = (value: unknown) => typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,40}$/.test(value) ? value : 'unknown'
    const report = { schema: 'wechatauto.error-diagnostics.v1', generatedAt: new Date().toISOString(),
      application: { name: 'WeChatAuto', version: publicVersion(this.build.version || app.getVersion()),
        edition: ['standard', 'geek', 'demo'].includes(this.build.edition) ? this.build.edition : 'unknown',
        hardening: ['none', 'bla-balanced'].includes(this.build.hardening) ? this.build.hardening : 'unknown', packaged: app.isPackaged,
        platform: process.platform, architecture: process.arch, electron: publicVersion(process.versions.electron), chrome: publicVersion(process.versions.chrome), node: publicVersion(process.versions.node) },
      selectedError, recentErrors: recent, troubleshooting: suggestions(selectedError),
      privacy: { redacted: true, sources: '仅所选错误及本次运行中有限的脱敏错误摘要；未读取任何原始日志文件',
        excluded: ['聊天记录', '人格与任务', '模型提示词和请求正文', '完整配置', '密钥、令牌、Cookie和登录凭据'],
        note: '已限制长度并进行内容和标识脱敏；分享前仍可自行检查。' } }
    let result = JSON.stringify(report, null, 2) + '\n'
    while (Buffer.byteLength(result, 'utf8') > MAX_REPORT_BYTES && report.recentErrors.length) { report.recentErrors.pop(); result = JSON.stringify(report, null, 2) + '\n' }
    if (Buffer.byteLength(result, 'utf8') > MAX_REPORT_BYTES) throw new Error('诊断记录过大，请选择单条错误重试')
    return result
  }
  async exportErrorLog(event: Electron.IpcMainInvokeEvent, input: unknown): Promise<ErrorDiagnosticExportResult> {
    let window: BrowserWindow
    try { window = this.ownWindow(event) } catch { return { success: false, error: '诊断操作来源无效' } }
    if (this.exporting) return { success: false, error: '已有诊断日志保存窗口，请先完成或取消' }
    this.exporting = true
    try {
      const content = this.report(input)
      const result = await dialog.showSaveDialog(window, { title: '下载脱敏错误日志',
        defaultPath: `WeChatAuto-error-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        filters: [{ name: 'JSON 诊断日志', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'createDirectory', 'dontAddToRecent'] })
      if (result.canceled || !result.filePath) return { success: false, canceled: true }
      // The sole write target is returned by the native user-controlled chooser.
      await writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 })
      return { success: true, filePath: result.filePath }
    } catch { return { success: false, error: '错误日志保存失败，请检查所选目录权限和磁盘空间后重试' } }
    finally { this.exporting = false }
  }
  register(): void {
    ipcMain.handle('diagnostics:recordError', (event, input) => this.recordError(event, input))
    ipcMain.handle('diagnostics:exportErrorLog', (event, input) => this.exportErrorLog(event, input))
  }
}
export function registerErrorDiagnostics(build: ErrorDiagnosticsBuildInfo): ErrorDiagnosticsService {
  const service = new ErrorDiagnosticsService(build); service.register(); return service
}
