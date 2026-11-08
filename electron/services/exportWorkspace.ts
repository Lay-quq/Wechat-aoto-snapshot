import { isAbsolute, relative, resolve, join } from 'node:path'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'

/** Only an immediate, privately-created job directory may be recursively removed. */
export function assertExportWorkspace(base: string, directory: string): void {
  if (!isAbsolute(base) || !isAbsolute(directory)) throw new Error('导出工作目录必须为绝对路径')
  const child = relative(resolve(base), resolve(directory))
  if (!child || child.startsWith('..') || isAbsolute(child) || /[\\/]/.test(child) || !child.startsWith('job-')) {
    throw new Error('导出工作目录不在当前存储目录内')
  }
}

export async function createExportWorkspace(base: string): Promise<{ base: string; directory: string }> {
  if (!isAbsolute(base)) throw new Error('导出工作目录必须跟随已解析的回复存储路径')
  await mkdir(base, { recursive: true })
  const resolvedBase = await realpath(base)
  const directory = await mkdtemp(join(resolvedBase, 'job-'))
  assertExportWorkspace(resolvedBase, directory)
  return { base: resolvedBase, directory }
}

export async function removeExportWorkspace(base: string, directory: string): Promise<void> {
  assertExportWorkspace(base, directory)
  let info
  try { info = await lstat(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('导出工作目录身份已改变，未执行清理')
  const [resolvedBase, resolvedDirectory] = await Promise.all([realpath(base), realpath(directory)])
  assertExportWorkspace(resolvedBase, resolvedDirectory)
  await rm(resolvedDirectory, { recursive: true, force: false, maxRetries: 6, retryDelay: 150 })
}
