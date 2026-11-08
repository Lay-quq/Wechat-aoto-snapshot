import type { StandardSnapshot, StandardSession, StandardMessage, StandardExportOptions } from '../../shared/standardExport'
import type { ActiveWechat } from './discovery'
import { decodeMessageContent } from '../services/export/parsers/contentDecoder'
import { extractXmlValue } from '../services/export/parsers/xmlExtractor'
export interface StandardPorts {
  config: { isLocked(): boolean; helloAvailable?(): boolean; unlock(password: string): void; lock(): void; reload(): void; keyFor(directory: string): string; select(directory: string, key: string): void }
  db: any
  discover(signal: AbortSignal): Promise<ActiveWechat>
  acquireKey(active: ActiveWechat, signal: AbortSignal): Promise<string>
  changed(snapshot: StandardSnapshot): void
  exportRun(sessionIds: string[], options: StandardExportOptions, output: string, progress: (data: any) => void, signal: AbortSignal): Promise<any>
}
const same = (a: ActiveWechat, b: ActiveWechat) => a.directory.toLowerCase() === b.directory.toLowerCase() && a.pid === b.pid && a.started === b.started
const labels: Record<number, string> = { 3: '[图片]', 34: '[语音]', 43: '[视频]', 47: '[表情]', 48: '[位置]', 50: '[通话]', 10000: '[系统消息]' }
export function mapMessage(row: any, account: string): StandardMessage {
  const raw = decodeMessageContent(row.message_content, row.compress_content), type = Number(row.local_type || row.type || 1)
  let text = raw
  if (type === 49 || type > 0xffffffff) text = extractXmlValue(raw, 'title') || extractXmlValue(raw, 'des') || '[分享消息]'
  else if (type !== 1) text = labels[type] || '[其他消息]'
  const sender = String(row.sender_username || row.real_sender_id || '')
  const mine = Number(row.computed_is_send ?? row.is_send) === 1 || sender === account
  return { id: String(row.local_id ?? row.localId ?? ''), timestamp: Number(row.create_time || 0), sender: mine ? '我' : sender, mine, type, text, raw,
    imageMd5: type === 3 ? /\bmd5=["']([a-f0-9]{32})["']/i.exec(raw)?.[1] : undefined }
}
export class StandardRuntime {
  private epoch = 0
  private systemLocked = false
  private active?: ActiveWechat
  private controller?: AbortController
  private flight?: Promise<StandardSnapshot>
  private exportController?: AbortController
  private exportWatch?: ReturnType<typeof setInterval>
  private allowedSessions = new Set<string>()
  private state: StandardSnapshot = { connected: false, connecting: false, locked: false }
  constructor(private ports: StandardPorts) {}
  snapshot(): StandardSnapshot { return { ...this.state, locked: this.systemLocked || this.ports.config.isLocked(), helloAvailable: this.ports.config.helloAvailable?.() || false, exportJob: this.state.exportJob && { ...this.state.exportJob } } }
  private publish() { this.ports.changed(this.snapshot()) }
  private check(epoch: number) { if (epoch !== this.epoch || this.snapshot().locked) throw Error('账号或资料锁状态已变化，请重新连接') }
  invalidate(message?: string) {
    this.epoch++; this.controller?.abort(); this.exportController?.abort(); this.active = undefined; this.allowedSessions.clear()
    clearInterval(this.exportWatch); this.exportWatch = undefined
    this.state = { ...this.state, connected: false, error: message }; void this.ports.db.close(); this.publish()
  }
  cancel() { this.invalidate(); return this.snapshot() }
  setSystemLocked(locked: boolean) { this.systemLocked = locked; if (locked) { this.ports.config.lock(); this.invalidate('系统已锁定，请重新解锁本地资料') }; this.publish() }
  lock() { this.ports.config.lock(); this.invalidate(); return this.snapshot() }
  unlock(password: string) { this.ports.config.unlock(password); this.publish(); return this.snapshot() }
  connect(): Promise<StandardSnapshot> {
    if (this.flight) return this.flight
    if (this.exportController) throw Error('请先结束导出任务再重新连接')
    this.ports.config.reload()
    if (this.snapshot().locked) throw Error('请先解锁本地资料')
    const epoch = ++this.epoch, controller = this.controller = new AbortController()
    this.state = { connected: false, connecting: true, locked: false }; this.publish()
    this.flight = (async () => {
      try {
        const active = await this.ports.discover(controller.signal); this.check(epoch)
        let key = this.ports.config.keyFor(active.directory)
        let verified = !!key && (await this.ports.db.testConnection(active.directory, key)).success; this.check(epoch)
        if (!verified) { key = await this.ports.acquireKey(active, controller.signal); this.check(epoch); verified = (await this.ports.db.testConnection(active.directory, key)).success; this.check(epoch) }
        if (!verified) throw Error('无法读取当前微信数据库，请重新连接')
        if (!same(active, await this.ports.discover(controller.signal))) throw Error('微信账号已变化，请重新连接')
        this.check(epoch); this.ports.config.select(active.directory, key)
        if (!await this.ports.db.open(active.directory, key)) throw Error(await this.ports.db.getLastInitError() || '本地数据库未就绪')
        this.check(epoch); this.active = active; this.allowedSessions.clear()
        this.state = { connected: true, connecting: false, locked: false, accountName: active.directory.split(/[\\/]/).pop() }
      } catch (error) { if (epoch === this.epoch) { this.active = undefined; this.state.connected = false; this.state.error = (error as Error).message } }
      finally { if (this.controller === controller) this.controller = undefined; this.state.connecting = false; this.flight = undefined; this.publish() }
      return this.snapshot()
    })()
    return this.flight
  }
  async assertCurrent() {
    const epoch = this.epoch, active = this.active; this.check(epoch)
    if (!active || !this.state.connected) throw Error('请先一键连接本机微信')
    const observed = await this.ports.discover(new AbortController().signal); this.check(epoch)
    if (!same(active, observed)) { this.invalidate('微信账号已变化，请重新连接'); throw Error('微信账号已变化，请重新连接') }
    return epoch
  }
  async sessions(): Promise<StandardSession[]> {
    const epoch = await this.assertCurrent(), result = await this.ports.db.getSessions(); this.check(epoch)
    if (!result.success || !Array.isArray(result.sessions)) throw Error('无法读取会话列表')
    const rows = result.sessions, names = await this.ports.db.getDisplayNames(rows.map((row: any) => row.username || row.talker_id).filter(Boolean)); this.check(epoch)
    const heads = this.ports.db.getHeadImageBuffers ? await this.ports.db.getHeadImageBuffers(rows.slice(0, 200).map((row: any) => row.username || row.talker_id).filter(Boolean)).catch(() => ({})) : {}
    this.check(epoch)
    this.allowedSessions = new Set(rows.map((row: any) => String(row.username || row.talker_id || '')).filter(Boolean))
    return rows.map((row: any) => { const id = String(row.username || row.talker_id || ''); return { id, name: names.map?.[id] || row.display_name || id,
      avatar: typeof heads.map?.[id] === 'string' && /^[a-f0-9]+$/i.test(heads.map[id]) && heads.map[id].length <= 4 * 1024 * 1024 ? 'data:image/jpeg;base64,' + Buffer.from(heads.map[id], 'hex').toString('base64') : undefined,
      preview: decodeMessageContent(row.last_msg_content || row.summary || '', null), timestamp: Number(row.last_timestamp || row.last_msg_time || row.sort_timestamp || 0), group: id.endsWith('@chatroom') } }).filter((item: StandardSession) => item.id)
  }
  async messages(id: string, offset: number) {
    const epoch = await this.assertCurrent()
    if (!this.allowedSessions.has(id) || !Number.isSafeInteger(offset) || offset < 0) throw Error('会话或分页参数无效')
    const result = await this.ports.db.getMessages(id, 100, offset); this.check(epoch)
    if (!result.success || !Array.isArray(result.messages)) throw Error('消息读取失败')
    const account = (this.active?.directory.split(/[\\/]/).pop() || '').replace(/_[a-zA-Z0-9]{4}$/, '')
    return { messages: result.messages.map((row: any) => mapMessage(row, account)), hasMore: result.messages.length === 100 }
  }
  async export(ids: string[], options: StandardExportOptions, output: string) {
    const epoch = await this.assertCurrent()
    if (this.exportController || !ids.length || ids.length > 10000 || ids.some(id => !this.allowedSessions.has(id))) throw Error('导出任务或会话选择无效')
    const controller = this.exportController = new AbortController(), id = Date.now().toString(36)
    let checking = false
    this.exportWatch = setInterval(() => {
      if (checking || controller.signal.aborted) return
      checking = true
      void this.assertCurrent().catch(error => { if (!controller.signal.aborted) this.invalidate(String(error.message || error)) }).finally(() => { checking = false })
    }, 3000)
    this.exportWatch.unref?.()
    this.state.exportJob = { id, state: 'running', current: 0, total: ids.length, message: '正在准备导出', outputDirectory: output }; this.publish()
    void this.ports.exportRun([...new Set(ids)], options, output, data => {
      if (epoch !== this.epoch || controller.signal.aborted || !this.state.exportJob) return
      const current = Number(data.current ?? data.currentSessionIndex ?? 0), total = Number(data.total ?? data.totalSessions ?? ids.length)
      Object.assign(this.state.exportJob, { current: Math.max(0, current), total: Math.max(1, total), message: String(data.currentSession || data.message || data.phase || '正在导出') }); this.publish()
    }, controller.signal).then(result => {
      if (this.state.exportJob?.id !== id) return
      const stopped = controller.signal.aborted || result?.stopped
      Object.assign(this.state.exportJob, { state: stopped ? 'cancelled' : result?.success ? 'completed' : 'failed', message: stopped ? '导出已取消' : result?.success ? '导出完成' : '导出失败', error: result?.error })
    }).catch(error => { if (this.state.exportJob?.id === id) Object.assign(this.state.exportJob, { state: controller.signal.aborted ? 'cancelled' : 'failed', message: '导出已结束', error: controller.signal.aborted ? undefined : String(error.message || error) }) })
      .finally(() => { if (this.exportController === controller) { this.exportController = undefined; clearInterval(this.exportWatch); this.exportWatch = undefined }; this.publish() })
    return this.snapshot()
  }
  cancelExport() { this.exportController?.abort(); clearInterval(this.exportWatch); this.exportWatch = undefined; return this.snapshot() }
  ownsSession(id: string) { return this.allowedSessions.has(id) }
}
