import './standard/bootstrap'
import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor, shell, session } from 'electron'
import { join, isAbsolute, dirname } from 'node:path'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { ConfigService } from './standard/config'
import { wcdbService } from './standard/wcdb'
import { chatService } from './standard/chat'
import { videoService } from './services/videoService'
import { decodeMessageContent } from './services/export/parsers/contentDecoder'
import { discover, acquireKey } from './standard/discovery'
import { StandardRuntime } from './standard/runtime'
import { createExportWorkspace } from './services/exportWorkspace'
import type { StandardExportOptions, StandardGroupInfo } from '../shared/standardExport'
import purchaseChannels from '../shared/standardPurchaseChannels.json'
import { registerErrorDiagnostics } from './services/errorDiagnosticsService'

const isolated = process.env.WEFLOW_USER_DATA_PATH
if (isolated && !isAbsolute(isolated)) throw Error('隔离资料路径必须为绝对路径')
app.setName('WeChatAuto')
app.setPath('userData', isolated || join(app.getPath('appData'), 'WeFlow'))
if (isolated) { app.setPath('sessionData', join(isolated, 'session-data')); process.env.WEFLOW_CONFIG_CWD ||= isolated }
const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
process.env.WEFLOW_RESOURCES_PATH = resources
let window: BrowserWindow | undefined, runtime: StandardRuntime | undefined
const formats = new Set(['chatlab', 'chatlab-jsonl', 'json', 'arkme-json', 'html', 'markdown', 'txt', 'excel', 'weclone', 'sql'])
function groupInfo(): StandardGroupInfo {
  const file = join(resources, 'standard-group.json')
  const value = { ...purchaseChannels, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) }
  const httpsUrl = (url: unknown) => { try { const parsed = new URL(String(url)); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : '' } catch { return '' } }
  return { groupName: String(value.groupName || ''), groupNumber: String(value.groupNumber || ''), joinUrl: httpsUrl(value.joinUrl), telegramUrl: httpsUrl(value.telegramUrl) }
}
function validateOptions(value: any): StandardExportOptions {
  if (!value || !formats.has(value.format) || !['shared', 'per-session'].includes(value.sessionLayout) || !['rename', 'incremental'].includes(value.conflict)) throw Error('导出选项无效')
  const range = value.dateRange
  if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) throw Error('导出日期范围无效')
  return { format: value.format, dateRange: range ? { start: range.start, end: range.end } : undefined, exportMedia: value.exportMedia === true,
    exportAvatars: value.exportAvatars === true, sessionLayout: value.sessionLayout, conflict: value.conflict }
}
if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(() => {
  registerErrorDiagnostics({ edition: 'standard', hardening: 'none' })
  const config = new ConfigService()
  void wcdbService.setPaths(resources, app.getPath('userData')); void wcdbService.setLibPath(config.get('wcdbLibPath') || '')
  runtime = new StandardRuntime({ config, db: wcdbService, discover, acquireKey,
    changed: value => { if (window && !window.isDestroyed()) window.webContents.send('standard:changed', value) },
    exportRun: async (ids, options, output, progress, signal) => {
      const workspace = await createExportWorkspace(join(config.getCacheBasePath(), 'standard-export-work'))
      const controlBuffer = new SharedArrayBuffer(8), control = new Int32Array(controlBuffer)
      const exportOptions = { format: options.format, dateRange: options.dateRange || null, exportMedia: options.exportMedia, exportAvatars: options.exportAvatars,
        exportImages: options.exportMedia, exportVoices: options.exportMedia, exportVideos: options.exportMedia, exportEmojis: options.exportMedia, exportFiles: options.exportMedia,
        exportVoiceAsText: false, sessionLayout: options.sessionLayout, exportConflictStrategy: options.conflict, exportConcurrency: 2 }
      return new Promise((resolve, reject) => {
        const worker = new Worker(join(__dirname, 'standardExportWorker.js'), { workerData: {
          mode: 'sessions', sessionIds: ids, outputDir: output, options: exportOptions,
          accountDir: config.getAccountDir(), dbPath: config.get('dbPath'), myAccountId: config.get('myAccountId'), decryptKey: config.get('decryptKey'),
          sessionDbPath: [join(config.getAccountDir() || '', 'db_storage/session/session.db'), join(config.getAccountDir() || '', 'db_storage/session.db')].find(existsSync),
          imageAesKey: config.get('imageAesKey'), imageXorKey: Number(config.get('imageXorKey') || 0), resourcesPath: resources,
          userDataPath: app.getPath('userData'), cachePath: config.getCacheBasePath(), wcdbLibPath: config.get('wcdbLibPath'),
          welivePath: config.get('welivePath'), isPackaged: app.isPackaged, workBase: workspace.base, workDirectory: workspace.directory, controlBuffer,
        }, env: { ...process.env, WEFLOW_WORKER: '1', WEFLOW_USER_DATA_PATH: app.getPath('userData'), WEFLOW_STANDARD_APP_PATH: app.getAppPath(), WEFLOW_STANDARD_PACKAGED: app.isPackaged ? '1' : '0' } })
        let settled = false, watchdog: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); clearTimeout(watchdog); void worker.terminate(); error ? reject(error) : resolve(value) }
        const cancel = () => { Atomics.store(control, 0, 2); Atomics.notify(control, 0); worker.postMessage({ type: 'export:stop' }); watchdog = setTimeout(() => finish(undefined, { success: false, stopped: true }), 10000) }
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        worker.on('message', message => {
          if (message.type === 'export:progress') progress(message.data || message.progress || {})
          if (message.type === 'export:result') finish(undefined, message.data)
          if (message.type === 'export:error') finish(Error(String(message.error || '导出失败')))
        })
        worker.once('error', error => finish(error)); worker.once('exit', code => { if (!settled) finish(Error('导出工作进程提前退出：' + code)) })
      })
    },
  })
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw Error('功能调用来源无效')
    const url = event.senderFrame?.url || ''
    if (!(url.startsWith('file:') || !app.isPackaged && url.startsWith('http://127.0.0.1:'))) throw Error('功能调用来源无效')
  }
  const handle = (name: string, callback: (...args: any[]) => any) => ipcMain.handle('standard:' + name, (event, ...args) => { authorize(event); return callback(...args) })
  handle('snapshot', () => runtime!.snapshot()); handle('connect', () => runtime!.connect()); handle('cancel', () => runtime!.cancel())
  handle('unlock', password => runtime!.unlock(String(password || ''))); handle('lock', () => runtime!.lock())
  let helloFlight: Promise<any> | undefined
  handle('hello', () => {
    if (helloFlight) return helloFlight
    if (!config.helloAvailable()) throw Error('尚未设置 Windows Hello，请使用原本地资料密码')
    const hwnd = window!.getNativeWindowHandle()
    const value = hwnd.length >= 8 ? hwnd.readBigUInt64LE().toString() : BigInt(hwnd.readUInt32LE()).toString()
    helloFlight = new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'standardHelloWorker.js'), { workerData: { resources, profile: app.getPath('userData'), hwnd: value } })
      const timer = setTimeout(() => { void worker.terminate(); reject(Error('Windows Hello 验证超时')) }, 120000)
      worker.once('message', result => { clearTimeout(timer); void worker.terminate(); if (result?.success !== true) { reject(Error('Windows Hello 未通过或已取消')); return }; try { resolve(runtime!.unlock(config.getHelloSecret())) } catch (error) { reject(error) } })
      worker.once('error', () => { clearTimeout(timer); reject(Error('Windows Hello 验证不可用，请使用本地资料密码')) })
    }).finally(() => { helloFlight = undefined })
    return helloFlight
  })
  handle('sessions', () => runtime!.sessions()); handle('messages', (id, offset) => runtime!.messages(String(id), Number(offset)))
  handle('export', async (ids, value) => {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw Error('请选择会话')
    const options = validateOptions(value); await runtime!.assertCurrent()
    const selected = await dialog.showOpenDialog(window!, { title: '选择聊天记录导出目录', properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return runtime!.snapshot()
    return runtime!.export(ids, options, selected.filePaths[0])
  })
  handle('cancelExport', () => runtime!.cancelExport())
  handle('avatar', async id => { await runtime!.assertCurrent(); if (!runtime!.ownsSession(String(id))) return undefined; const result = await chatService.getContactAvatar(String(id)); await runtime!.assertCurrent(); return result.avatarUrl })
  handle('image', async (id, message) => { await runtime!.assertCurrent(); if (!runtime!.ownsSession(String(id)) || !/^\d+$/.test(String(message))) return undefined; const result = await chatService.getImageData(String(id), String(message)); await runtime!.assertCurrent(); return result.success ? 'data:image/jpeg;base64,' + result.data : undefined })
  handle('media', async (id, message) => {
    await runtime!.assertCurrent()
    if (!runtime!.ownsSession(String(id)) || !/^\d+$/.test(String(message))) return undefined
    const found = await wcdbService.getMessageById(String(id), Number(message)), row = found.message
    if (!found.success || !row) return undefined
    if (Number(row.local_type) === 34) {
      chatService.setRuntimeConfig({ myAccountId: config.getMyAccountIdCleaned() })
      const result = await chatService.getVoiceData(String(id), String(message), Number(row.create_time || 0), String(row.server_id || 0), row.sender_username)
      await runtime!.assertCurrent()
      return result.success ? { kind: 'audio', url: 'data:audio/wav;base64,' + result.data } : undefined
    }
    if (Number(row.local_type) === 43) {
      const md5 = videoService.parseVideoMd5(decodeMessageContent(row.message_content, row.compress_content))
      if (!md5) return undefined
      const info = await videoService.getVideoInfo(md5, { includePoster: false })
      await runtime!.assertCurrent()
      if (!info.exists || !info.videoUrl || !existsSync(info.videoUrl)) return undefined
      if (statSync(info.videoUrl).size > 64 * 1024 * 1024) throw Error('视频超过预览大小，请导出后播放')
      return { kind: 'video', url: 'data:video/mp4;base64,' + readFileSync(info.videoUrl).toString('base64') }
    }
    return undefined
  })
  handle('groupInfo', groupInfo)
  handle('openGroup', async (channel: unknown = 'qq') => {
    if (channel !== 'qq' && channel !== 'telegram') throw Error('购买渠道无效')
    const value = groupInfo(), url = channel === 'telegram' ? value.telegramUrl : value.joinUrl
    if (!url) throw Error('群组入口待配置')
    await shell.openExternal(url)
  })
  handle('copyGroupNumber', () => { const value = groupInfo(); if (!value.groupNumber) throw Error('QQ 群号待配置'); clipboard.writeText(value.groupNumber) })
  handle('openExportDirectory', async () => { const directory = runtime!.snapshot().exportJob?.outputDirectory; if (directory && existsSync(directory)) await shell.openPath(directory) })
  ipcMain.on('standard:window', (event, action) => { if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return; if (action === 'minimize') window.minimize(); if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize(); if (action === 'close') window.close() })
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 860, minHeight: 620, frame: false, show: false, title: 'WeChatAuto',
    icon: join(resources, '../icon.ico'), webPreferences: { preload: join(__dirname, 'standardPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault())
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.once('ready-to-show', () => window!.show())
  void window.loadFile(join(__dirname, '../dist/standard.html'))
  powerMonitor.on('lock-screen', () => runtime!.setSystemLocked(true)); powerMonitor.on('unlock-screen', () => runtime!.setSystemLocked(false))
}).catch(error => { dialog.showErrorBox('WeChatAuto 启动失败', String(error.message || error)); app.quit() })
app.on('second-instance', () => { if (window) { window.show(); window.restore(); window.focus() } })
app.on('before-quit', () => { runtime?.invalidate(); void wcdbService.shutdown() })
app.on('window-all-closed', () => app.quit())
