import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseActiveWechatDirectory } from '../services/wechatConnectionDiscovery'
import { resolveNativeComponent } from './nativeComponents'
export interface ActiveWechat { directory: string; pid: number; started: string }
export async function discover(signal: AbortSignal): Promise<ActiveWechat> {
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  const id = randomUUID(), started = Date.now()
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(join(base, 'wechat-connection/win32-x64/WeFlow.WechatConnection.exe'), [], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, signal,
      env: { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(app.getPath('userData'), 'wechat-connection-runtime') },
    }, (error, stdout) => error ? reject(Error('无法识别当前微信，请确认微信已登录后重试')) : resolve(stdout))
    child.stdin?.on('error', () => reject(Error('连接探测未完成')))
    child.stdin?.end(JSON.stringify({ id, method: 'discover', params: {} }) + '\n', 'utf8')
  })
  const directory = parseActiveWechatDirectory(output, id, started)
  const result = JSON.parse(output).result
  return { directory, pid: result.processId, started: result.processStartedAtUtcFileTime }
}
export async function acquireKey(active: ActiveWechat, signal: AbortSignal): Promise<string> {
  // Only attach to the exact process identified by the read-only directory
  // proof. Never launches, closes, switches or restarts a WeChat process.
  const before = await discover(signal)
  if (JSON.stringify(before) !== JSON.stringify(active)) throw Error('微信账号已变化，请重新连接')
  const koffi = require('koffi'), library = koffi.load(resolveNativeComponent('key'))
  const initialize = library.func('bool InitializeHook(uint32 targetPid)'), poll = library.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)'), cleanup = library.func('bool CleanupHook()')
  try {
    if (!initialize(active.pid)) throw Error('无法自动获取当前微信数据库密钥，请确认访问权限')
    const deadline = Date.now() + 20000, buffer = Buffer.alloc(128)
    while (Date.now() < deadline && !signal.aborted) {
      if (poll(buffer, buffer.length)) {
        const key = buffer.toString('utf8').split('\0')[0].trim()
        if (/^[a-f0-9]{64}$/i.test(key)) return key
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    throw Error(signal.aborted ? '连接已取消' : '未取得数据库密钥，请稍后重试')
  } finally { cleanup() }
}
