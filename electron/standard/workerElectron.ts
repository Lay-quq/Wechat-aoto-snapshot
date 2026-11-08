import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const profile = process.env.WEFLOW_USER_DATA_PATH || join(process.env.APPDATA || homedir(), 'WeFlow')
export const app = { isPackaged: process.env.WEFLOW_STANDARD_PACKAGED === '1',
  getPath: (name: string) => name === 'userData' ? profile : name === 'temp' ? tmpdir() : name === 'documents' ? join(homedir(), 'Documents') : name === 'home' ? homedir() : profile,
  getAppPath: () => process.env.WEFLOW_STANDARD_APP_PATH || process.cwd(), getVersion: () => '5.2.0', on() {}, once() {} }
export const safeStorage = { isEncryptionAvailable: () => false }
export const BrowserWindow = { getAllWindows: () => [] }
export const dialog = {}
export const net = {}
