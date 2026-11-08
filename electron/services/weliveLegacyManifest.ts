import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { WeliveExportRequest, WeliveRawExportManifest } from './weliveBridge'

const PINNED_EXE = '62a472e7564b95f5c992db6e7e94d637ba64fd8d6696517191106b49ca9f5e33'
const PINNED_DLL = 'b14bd63471f6023a0b86e503737311bcc4144088140f0d38a1cc28c05aab956e'
export type LegacyRawContext = { directory: string; sessionIds: string[]; dateRange?: { start: number; end: number }; signal?: AbortSignal }
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('用户已取消') }
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Exact bundled binary pair only. Existing/external provider contracts are untouched. */
export async function prepareLegacyRawExport(exe: string, request: WeliveExportRequest, bundled: boolean,
  signal?: AbortSignal): Promise<{ request: WeliveExportRequest; context: LegacyRawContext } | null> {
  if (!bundled || request.format !== 'raw-jsonl') return null
  check(signal)
  try {
    if (await digest(exe) !== PINNED_EXE || await digest(join(dirname(exe), 'resources/win32/x64/wcdb_api.dll')) !== PINNED_DLL) return null
  } catch { return null }
  check(signal)
  const sessionIds = [...new Set(request.sessionIds)]
  if (!sessionIds.length || sessionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('原始导出缺少明确会话范围')
  const range = request.options?.dateRange as { start?: unknown; end?: unknown } | undefined
  let dateRange: LegacyRawContext['dateRange']
  if (range) {
    const start = Number(range.start), end = Number(range.end)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0
      || (start > 0 && end > 0 && end < start)) throw new Error('原始导出时间范围无效')
    if (start > 0 || end > 0) dateRange = { start, end }
  }
  const root = resolve(request.outputDir)
  await fs.mkdir(root, { recursive: true })
  // The engine can only nominate files created inside this previously empty
  // per-run directory. Old files and another session's exports cannot qualify.
  const directory = await fs.mkdtemp(join(root, '.weflow-raw-'))
  return { request: { ...request, outputDir: directory, exportsDir: directory },
    context: { directory: await fs.realpath(directory), sessionIds, dateRange, signal } }
}

/** Read every byte and row before upgrading a legacy result to a manifest. */
export async function verifyLegacyRawExports(context: LegacyRawContext, rawPaths: Record<string, string>,
  result: { success?: unknown; success_count?: unknown; fail_count?: unknown; failed_sessions?: unknown }): Promise<Record<string, WeliveRawExportManifest>> {
  check(context.signal)
  if (result.success !== true || result.fail_count !== 0 || result.success_count !== context.sessionIds.length
    || !Array.isArray(result.failed_sessions) || result.failed_sessions.length) throw new Error('旧引擎未确认全部会话导出成功')
  const keys = Object.keys(rawPaths)
  if (keys.length !== context.sessionIds.length || keys.some(id => !context.sessionIds.includes(id))) throw new Error('旧引擎原始导出会话范围不匹配')
  const manifests: Record<string, WeliveRawExportManifest> = {}, usedPaths = new Set<string>()
  for (const sessionId of context.sessionIds) {
    check(context.signal)
    const supplied = rawPaths[sessionId]
    if (typeof supplied !== 'string' || !isAbsolute(supplied)) throw new Error('旧引擎原始导出路径无效')
    let file: string
    try { file = await fs.realpath(supplied) } catch { throw new Error('旧引擎原始导出文件不存在') }
    const child = relative(context.directory, file)
    if (!child || child.startsWith('..') || isAbsolute(child) || usedPaths.has(file.toLowerCase())) throw new Error('旧引擎原始导出文件不属于本次独立目录')
    usedPaths.add(file.toLowerCase())
    const before = await fs.stat(file)
    if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error('旧引擎原始导出目标不是有效文件')
    let rows = 0, bytes = 0, pending = '', lastByte: number | undefined
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const verifyRow = (line: string) => {
      if (!line.trim()) return
      let row: Record<string, unknown>
      try { row = JSON.parse(line) } catch { throw new Error('旧引擎原始导出包含无效 JSON 行') }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('旧引擎原始导出行格式无效')
      for (const name of ['local_id', 'server_id', 'local_type', 'create_time']) {
        const value = row[name]
        if (!((typeof value === 'string' && /^\d{1,256}$/.test(value))
          || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) throw new Error('旧引擎消息整数或原始 ID 无法无损验证')
      }
      if (typeof row.message_content !== 'string' || typeof row.sender_username !== 'string') throw new Error('旧引擎原始导出缺少完整消息字段')
      const timestamp = Number(row.create_time)
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('旧引擎消息时间无效')
      if (context.dateRange && ((context.dateRange.start > 0 && timestamp < context.dateRange.start)
        || (context.dateRange.end > 0 && timestamp > context.dateRange.end))) throw new Error('旧引擎导出了请求时间范围之外的消息')
      rows++
    }
    try {
      for await (const chunk of createReadStream(file)) {
        check(context.signal)
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length; if (buffer.length) lastByte = buffer[buffer.length - 1]
        pending += decoder.decode(buffer, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          verifyRow(pending.slice(0, newline)); pending = pending.slice(newline + 1)
        }
        if (pending.length > 16 * 1024 * 1024) throw new Error('旧引擎单条原始消息超过安全解析上限')
      }
      pending += decoder.decode()
    } catch (error) {
      if (error instanceof Error && /旧引擎|用户已取消/.test(error.message)) throw error
      throw new Error('旧引擎原始导出文件无法完整读取为 UTF-8')
    }
    if (pending.length || (bytes > 0 && lastByte !== 10)) throw new Error('旧引擎原始导出未完整结束，缺少末尾换行')
    const after = await fs.stat(file)
    if (before.size !== bytes || after.size !== bytes || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('旧引擎原始导出文件在验证期间发生变化')
    check(context.signal)
    manifests[sessionId] = { path: file, rows, bytes }
  }
  return manifests
}
