import { parentPort, workerData } from 'node:worker_threads'
import { WcdbCore } from './wcdbReadCore'
const core = new WcdbCore()
core.setPaths(workerData.resources, workerData.profile)
void core.verifyUser('请验证您的身份以解锁本地聊天资料', workerData.hwnd).then(result => parentPort?.postMessage({ success: result?.success === true }))
  .catch(() => parentPort?.postMessage({ success: false }))
  .finally(() => { core.shutdown(); parentPort?.close() })
