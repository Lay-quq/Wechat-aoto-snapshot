import { resolveNativeComponent } from './nativeComponents'
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { ConfigService } from './config'
import { createNativeImageLoader, nativeImageCandidates, nativeImageDiagnostic,
  type NativeDatMeta, type NativeImageDiagnostic, type NativeImageResult } from './nativeImageCore'
export type { NativeDatMeta } from './nativeImageCore'

let addonPathOverride: string | null | undefined
function getConfiguredAddonPath(): string | null {
  if (addonPathOverride !== undefined) return addonPathOverride
  try { return String(new ConfigService().get('imageNativeAddonPath') || '').trim() || null }
  catch { return null }
}
const getAddonPath = () => resolveNativeComponent('image', getConfiguredAddonPath())
const loader = createNativeImageLoader(() => nativeImageCandidates(getAddonPath()))
let workerDiagnostic: NativeImageDiagnostic | undefined
export function getNativeImageDiagnostic(): NativeImageDiagnostic | undefined { return workerDiagnostic || loader.diagnostic() }
export function nativeAddonLocation(): string | null { return loader.location() }
export function decryptDatViaNative(inputPath: string, xorKey: number, aesKey?: string): NativeImageResult | null {
  return loader.decrypt(inputPath, xorKey, aesKey)
}
export function encryptDatViaNative(inputPath: string, xorKey: number, aesKey?: string, meta?: NativeDatMeta): Buffer | null {
  return loader.encrypt(inputPath, xorKey, aesKey, meta)
}
export function setAddonPathOverride(path: string | null | undefined): void {
  addonPathOverride = path?.trim() || null
  loader.reset()
  terminateDecryptWorker()
  workerFailedPermanently = false
  synchronousRecoveryUsed = false
  workerDiagnostic = undefined
}

type WorkerDecryptResult = NativeImageResult | null
type PendingJob = { resolve: (value: WorkerDecryptResult) => void; timer: ReturnType<typeof setTimeout> }
let decryptWorker: Worker | null = null
let workerFailedPermanently = false
let synchronousRecoveryUsed = false
let workerAddonPath: string | undefined
let workerJobSeq = 0
let workerEpoch = 0
const pendingJobs = new Map<number, PendingJob>()

function resolveWorkerPath(): string | null {
  const candidates = process.env.NODE_ENV === 'development'
    ? [join(__dirname, '../dist-electron/imageDecryptWorker.js'), join(__dirname, 'imageDecryptWorker.js')]
    : [join(__dirname, 'imageDecryptWorker.js')]
  return candidates.find(existsSync) || null
}
function finishJob(id: number, value: WorkerDecryptResult): void {
  const job = pendingJobs.get(id)
  if (!job) return
  pendingJobs.delete(id); clearTimeout(job.timer); job.resolve(value)
}
function flushPendingJobs(): void { for (const id of pendingJobs.keys()) finishJob(id, null) }
function failWorker(worker: Worker, code: 'worker_failed' | 'worker_timeout'): void {
  // Late exit events from a retired worker cannot tear down its replacement.
  if (decryptWorker !== worker) return
  workerDiagnostic = nativeImageDiagnostic(code)
  workerFailedPermanently = true
  decryptWorker = null
  flushPendingJobs()
  void worker.terminate()
}
function ensureDecryptWorker(): Worker | null {
  const addonPath = getAddonPath()
  if (workerAddonPath !== addonPath) {
    terminateDecryptWorker(); loader.reset(); workerAddonPath = addonPath
    workerFailedPermanently = false; synchronousRecoveryUsed = false; workerDiagnostic = undefined
  }
  if (workerFailedPermanently) return null
  if (decryptWorker) return decryptWorker
  const workerPath = resolveWorkerPath()
  if (!workerPath) { workerFailedPermanently = true; workerDiagnostic = nativeImageDiagnostic('worker_unavailable'); return null }
  try {
    const worker = new Worker(workerPath, { workerData: { imageNativeAddonPath: addonPath } })
    decryptWorker = worker
    worker.on('message', (msg: { id: number; ok: boolean; data?: ArrayBuffer; ext?: string; isWxgf?: boolean; meta?: NativeDatMeta; diagnostic?: NativeImageDiagnostic }) => {
      if (decryptWorker !== worker || !pendingJobs.has(msg.id)) return
      if (!msg.ok || !(msg.data instanceof ArrayBuffer) || !msg.data.byteLength) {
        // Messages contain fixed categories only; native exceptions can contain
        // filenames or secret arguments and must not be forwarded to the UI/log.
        workerDiagnostic = msg.diagnostic && ['disabled', 'addon_missing', 'addon_load_failed', 'api_missing', 'decrypt_failed', 'invalid_result'].includes(msg.diagnostic.code)
          ? nativeImageDiagnostic(msg.diagnostic.code) : nativeImageDiagnostic('invalid_result')
        finishJob(msg.id, null); return
      }
      workerDiagnostic = undefined
      finishJob(msg.id, { data: Buffer.from(msg.data), ext: msg.ext || '', isWxgf: Boolean(msg.isWxgf), meta: msg.meta || {} })
    })
    worker.on('error', () => failWorker(worker, 'worker_failed'))
    worker.on('exit', () => failWorker(worker, 'worker_failed'))
    worker.unref()
    return worker
  } catch {
    workerFailedPermanently = true; workerDiagnostic = nativeImageDiagnostic('worker_failed'); return null
  }
}

/** Normally performs all native IO/CPU work off the main thread. An unavailable
 * worker receives one synchronous recovery attempt per component selection;
 * repeated calls never rebuild a broken worker or enter a main-thread loop. */
export async function decryptDatViaNativeAsync(inputPath: string, xorKey: number, aesKey?: string): Promise<WorkerDecryptResult> {
  if (process.env.WEFLOW_IMAGE_NATIVE === '0') { workerDiagnostic = nativeImageDiagnostic('disabled'); return null }
  const worker = ensureDecryptWorker()
  const requestEpoch = workerEpoch
  let result: WorkerDecryptResult = null
  if (worker) {
    const id = ++workerJobSeq
    result = await new Promise<WorkerDecryptResult>(resolve => {
      const timer = setTimeout(() => failWorker(worker, 'worker_timeout'), 30_000)
      pendingJobs.set(id, { resolve, timer })
      try { worker.postMessage({ id, datPath: inputPath, xorKey, aesKey }) }
      catch { failWorker(worker, 'worker_failed') }
    })
  }
  if (result) return result
  if (requestEpoch !== workerEpoch) return null
  if (workerFailedPermanently && !synchronousRecoveryUsed) {
    synchronousRecoveryUsed = true
    return loader.decrypt(inputPath, xorKey, aesKey)
  }
  return null
}
export function terminateDecryptWorker(): void {
  workerEpoch++
  const worker = decryptWorker
  decryptWorker = null
  if (worker) void worker.terminate()
  flushPendingJobs()
}
