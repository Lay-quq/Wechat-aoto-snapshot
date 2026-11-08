// Configuration compatibility for local exports. Unknown fields are preserved,
// never interpreted, decrypted, exposed to the renderer or removed.
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute, parse } from 'node:path'
import { createHash, randomBytes, pbkdf2Sync, createDecipheriv, createCipheriv, timingSafeEqual } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { isMainThread, workerData } from 'node:worker_threads'

const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const clean = (id: string) => id.replace(/_([a-zA-Z0-9]{4})$/, '')
const keyFields = new Set(['decryptKey', 'imageAesKey', 'imageXorKey'])
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export class ConfigService {
  private static instance: ConfigService | undefined
  private password = ''
  readonly profile!: string
  readonly file!: string
  private raw: Record<string, any> = {}
  private stamp = ''
  private descriptor?: { file: string; sha256: string; sourceFile: string; sourceSha256: string }
  constructor() {
    if (ConfigService.instance) return ConfigService.instance
    this.profile = process.env.WEFLOW_CONFIG_CWD || process.env.WEFLOW_USER_DATA_PATH || app.getPath('userData')
    let directory = this.profile
    const descriptor = join(directory, 'WeFlow-config-location.json')
    if (existsSync(descriptor)) {
      const stat = lstatSync(descriptor)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('配置定位文件无效，请保留原文件并检查')
      const value = JSON.parse(readFileSync(descriptor, 'utf8'))
      const validPath = (item: unknown): item is string => typeof item === 'string' && item.trim() === item && isAbsolute(item) && !/^[\\/]{2}/.test(item)
        && !/[\u0000-\u001f\ufffd]/.test(item) && !item.split(/[\\/]/).includes('..') && resolve(item) !== parse(resolve(item)).root
        && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(item) && !/[<>:"|?*]/.test(item.slice(2)))
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'directory,sourceDirectory,sourceSha256,version'
        || value.version !== 1 || !validPath(value.sourceDirectory) || !same(value.sourceDirectory, directory) || !validPath(value.directory) || same(value.directory, directory)
        || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw Error('配置定位校验未通过，请保留原配置')
      const sourceFile = join(directory, 'WeFlow-config.json'), sourceInfo = lstatSync(sourceFile)
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || hash(readFileSync(sourceFile)) !== value.sourceSha256) throw Error('配置定位校验未通过，请保留原配置')
      for (let item = resolve(value.directory); item !== parse(item).root; item = dirname(item)) {
        const info = lstatSync(item); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('配置目录不能重定向')
      }
      const targetInfo = lstatSync(join(value.directory, 'WeFlow-config.json'))
      if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.dev === sourceInfo.dev && targetInfo.ino === sourceInfo.ino) throw Error('配置定位校验未通过，请保留原配置')
      directory = resolve(value.directory)
      this.descriptor = { file: descriptor, sha256: hash(readFileSync(descriptor)), sourceFile: join(this.profile, 'WeFlow-config.json'), sourceSha256: value.sourceSha256 }
    }
    this.file = join(directory, 'WeFlow-config.json')
    this.reload()
    ConfigService.instance = this
  }
  reload() {
    if (this.descriptor && (hash(readFileSync(this.descriptor.file)) !== this.descriptor.sha256 || hash(readFileSync(this.descriptor.sourceFile)) !== this.descriptor.sourceSha256)) throw Error('配置定位已变化，请重新启动后核实')
    if (!existsSync(this.file)) { this.raw = {}; this.stamp = ''; return }
    const stat = lstatSync(this.file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('本地配置文件不安全或过大')
    const bytes = readFileSync(this.file), value = JSON.parse(bytes.toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('本地配置格式无效')
    this.raw = value; this.stamp = hash(bytes)
  }
  private decode(value: unknown): string {
    if (typeof value !== 'string') return value === undefined || value === null ? '' : String(value)
    if (value.startsWith('safe:')) {
      if (!safeStorage?.isEncryptionAvailable()) throw Error('系统加密存储不可用，请保留原配置')
      try { return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64')) } catch { throw Error('本机资料密钥无法解密，请保留原文件') }
    }
    if (value.startsWith('lock:')) {
      if (!this.password) return ''
      const data = Buffer.from(value.slice(5), 'base64')
      const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(this.password, data.subarray(0, 16), 100000, 32, 'sha256'), data.subarray(16, 28))
      decipher.setAuthTag(data.subarray(28, 44))
      return Buffer.concat([decipher.update(data.subarray(44)), decipher.final()]).toString('utf8')
    }
    return value
  }
  private encode(value: string): string {
    if (!value) return ''
    if (this.password) {
      const salt = randomBytes(16), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(this.password, salt, 100000, 32, 'sha256'), iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return 'lock:' + Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64')
    }
    if (!safeStorage?.isEncryptionAvailable()) throw Error('系统加密存储不可用，无法保存数据库密钥')
    return 'safe:' + safeStorage.encryptString(value).toString('base64')
  }
  isLocked() {
    const enabled = this.decode(this.raw.authEnabled)
    const lockedKey = typeof this.raw.decryptKey === 'string' && this.raw.decryptKey.startsWith('lock:')
    return !this.password && (enabled === 'true' || enabled === '1' || lockedKey || !!this.raw.authPassword)
  }
  unlock(password: string) {
    if (!password || password.length > 4096) throw Error('请输入本地资料密码')
    const saved = this.decode(this.raw.authPassword), value = createHash('sha256').update(password).digest('hex')
    if (saved && (saved.length !== value.length || !timingSafeEqual(Buffer.from(saved), Buffer.from(value)))) throw Error('本地资料密码不正确')
    this.password = password
    try {
      if (!saved && !(typeof this.raw.decryptKey === 'string' && this.raw.decryptKey.startsWith('lock:') && /^[a-f0-9]{64}$/i.test(this.decode(this.raw.decryptKey)))) throw Error('无法验证本地资料密码')
      if (this.raw.decryptKey) this.decode(this.raw.decryptKey)
    } catch { this.password = ''; throw Error('本地资料密码不正确') }
  }
  lock() { this.password = '' }
  helloAvailable() { return ['true', '1'].includes(this.decode(this.raw.authUseHello)) && !!this.raw.authHelloSecret }
  getHelloSecret() { return this.decode(this.raw.authHelloSecret) }
  get(name: string): any {
    if (!isMainThread && workerData && Object.hasOwn(workerData, name)) return workerData[name]
    if (keyFields.has(name)) return this.decode(this.raw[name])
    if (name === 'logEnabled') return false
    if (name === 'cachePath') return this.raw.cachePath || join(this.profile, 'cache')
    return this.raw[name]
  }
  getMyAccountIdCleaned() { return clean(String(this.raw.myAccountId || this.raw.wxid || '')) }
  getAccountDir(dbPath = String(this.raw.dbPath || ''), accountId = String(this.raw.myAccountId || this.raw.wxid || '')): string | null {
    if (!dbPath || !accountId) return null
    if (existsSync(join(dbPath, 'db_storage'))) return dbPath
    const direct = join(dbPath, accountId)
    if (existsSync(join(direct, 'db_storage'))) return direct
    const matches = existsSync(dbPath) ? readdirSync(dbPath).filter(name => clean(name) === clean(accountId) && existsSync(join(dbPath, name, 'db_storage'))) : []
    return matches.length === 1 ? join(dbPath, matches[0]) : null
  }
  getCacheBasePath() { return String(this.get('cachePath')) }
  getImageKeysForCurrentAccountId() { return { xorKey: Number(this.get('imageXorKey') || 0), aesKey: String(this.get('imageAesKey') || '') } }
  keyFor(directory: string): string {
    if (this.isLocked()) throw Error('请先解锁本地资料')
    const accountId = directory.split(/[\\/]/).pop() || ''
    const records = { ...this.raw.wxidConfigs, ...this.raw.accountConfigs }
    const record = records[accountId] || records[clean(accountId)] || {}
    if (this.getAccountDir() && same(this.getAccountDir()!, directory)) return this.decode(this.raw.decryptKey) || this.decode(record.decryptKey)
    return this.decode(record.decryptKey)
  }
  select(directory: string, key: string) {
    if (this.isLocked() || !/^[a-f0-9]{64}$/i.test(key)) throw Error('资料未解锁或密钥无效')
    const original = this.stamp
    if (existsSync(this.file) ? hash(readFileSync(this.file)) !== original : !!original) throw Error('配置已在其他窗口变化，请重新连接')
    const accountId = directory.split(/[\\/]/).pop() || '', records = { ...this.raw.wxidConfigs, ...this.raw.accountConfigs }
    const selected = records[accountId] || records[clean(accountId)] || {}
    const next = { ...this.raw, myAccountId: accountId, dbPath: dirname(directory), decryptKey: this.encode(key),
      imageAesKey: selected.imageAesKey ?? (same(this.getAccountDir() || '.', directory) ? this.raw.imageAesKey : '') ?? '',
      imageXorKey: selected.imageXorKey ?? (same(this.getAccountDir() || '.', directory) ? this.raw.imageXorKey : 0) ?? 0,
      accountConfigs: { ...records, [accountId]: { ...selected, decryptKey: this.encode(key) } } }
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = this.file + '.standard-' + randomBytes(8).toString('hex') + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' })
    if (existsSync(this.file) ? hash(readFileSync(this.file)) !== original : !!original) throw Error('保存前配置已变化，保留原配置')
    renameSync(temporary, this.file); this.reload()
  }
}
