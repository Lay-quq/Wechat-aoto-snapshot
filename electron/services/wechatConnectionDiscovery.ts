import { app } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { join, win32 } from 'path'

const failureCodes: Record<string, string> = {
  account_thread_ambiguous: 'WECHAT_MULTIPLE_ACTIVE_ACCOUNTS',
  account_roots_ambiguous: 'WECHAT_MULTIPLE_ACTIVE_ACCOUNTS',
  module_version_unsupported: 'WECHAT_VERSION_UNSUPPORTED',
  module_hash_mismatch: 'WECHAT_VERSION_UNSUPPORTED',
  no_active_databases: 'WECHAT_NOT_LOGGED_IN',
  process_not_found: 'WECHAT_NOT_LOGGED_IN',
  window_unverifiable: 'WECHAT_NOT_LOGGED_IN',
}
const unavailable = () => new Error('WECHAT_DISCOVERY_UNAVAILABLE')

/** Only metadata from the separate read-only helper. Never returns a send grant. */
export function parseActiveWechatDirectory(stdout: string, requestId: string, started: number, now = Date.now()): string {
  if (Buffer.byteLength(stdout, 'utf8') > 65536) throw unavailable()
  let response: any
  try { response = JSON.parse(stdout.trim()) } catch { throw unavailable() }
  if (!response || response.id !== requestId || typeof response !== 'object') throw unavailable()
  if (response.error) throw new Error(failureCodes[response.error.code] || 'WECHAT_DISCOVERY_UNAVAILABLE')
  const value = response.result
  if (!value || value.protocol !== 1 || value.probeKind !== 'active-database-directory'
    || !Number.isSafeInteger(value.processId) || value.processId <= 0
    || typeof value.processStartedAtUtcFileTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.processStartedAtUtcFileTime)
    || typeof value.accountDirectory !== 'string' || typeof value.accountId !== 'string'
    || !/^wxid_[A-Za-z0-9]+$/.test(value.accountId)) throw unavailable()
  const directory: string = value.accountDirectory
  if (!/^[A-Za-z]:\\/.test(directory) || !win32.isAbsolute(directory) || directory.length > 32760
    || /[\u0000-\u001f\u007f]/.test(directory) || directory.slice(2).includes(':')
    || directory.split('\\').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))
    || !new RegExp('^' + value.accountId + '(?:_[A-Fa-f0-9]{4})?$').test(win32.basename(directory))) throw unavailable()
  const observed = Date.parse(value.observedAtUtc)
  // Windows clocks can differ by one coarse timer tick; elapsed wall time is
  // bounded by the helper process timeout and no future result is retained.
  if (!Number.isFinite(observed) || observed < started - 32 || observed > now + 32 || now - started > 20000) throw unavailable()
  return directory
}

export async function discoverActiveWechatDirectory(signal: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || signal.aborted) return undefined
  const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  const executable = join(resources, 'wechat-connection', 'win32-x64', 'WeFlow.WechatConnection.exe')
  const id = randomUUID(), started = Date.now()
  const env: NodeJS.ProcessEnv = { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(app.getPath('userData'), 'wechat-connection-runtime') }
  delete env.ELECTRON_RUN_AS_NODE
  const stdout = await new Promise<string>((resolve, reject) => {
    try {
      const child = execFile(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 65536, signal, env },
        (error, output) => error ? reject(unavailable()) : resolve(output))
      if (!child.stdin) { reject(unavailable()); return }
      child.stdin.on('error', () => reject(unavailable()))
      child.stdin.end(JSON.stringify({ id, method: 'discover', params: {} }) + '\n', 'utf8')
    } catch { reject(unavailable()) }
  })
  if (signal.aborted) return undefined
  return parseActiveWechatDirectory(stdout, id, started)
}
