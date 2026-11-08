import { parentPort, workerData } from 'worker_threads'
import { createNativeImageLoader, nativeImageCandidates, nativeImageDiagnostic } from './services/nativeImageCore'

// Pure Node dependency graph: Electron/configuration modules cannot load in a
// packaged worker thread. The main process resolves the component path once.
const loader = createNativeImageLoader(() => nativeImageCandidates(String(workerData?.imageNativeAddonPath || '')))

type DecryptRequest = {
  id: number
  datPath: string
  xorKey: number
  aesKey?: string
}

parentPort?.on('message', (req: DecryptRequest) => {
  const { id, datPath, xorKey, aesKey } = req
  try {
    const result = loader.decrypt(datPath, xorKey, aesKey)
    if (!result) {
      parentPort?.postMessage({ id, ok: false, diagnostic: loader.diagnostic() || nativeImageDiagnostic('decrypt_failed') })
      return
    }
    // 拷贝出独立 ArrayBuffer 后转移所有权，避免结构化克隆再复制一次
    const data = new ArrayBuffer(result.data.byteLength)
    new Uint8Array(data).set(result.data)
    parentPort?.postMessage(
      { id, ok: true, data, ext: result.ext, isWxgf: result.isWxgf, meta: result.meta },
      [data]
    )
  } catch {
    parentPort?.postMessage({ id, ok: false, diagnostic: nativeImageDiagnostic('decrypt_failed') })
  }
})
