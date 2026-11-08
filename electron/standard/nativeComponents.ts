import { existsSync } from 'node:fs'
import { join } from 'node:path'
export function resolveNativeComponent(kind: 'wcdb' | 'key' | 'image' | 'welive', configured?: string | null, root?: string | null): string {
  if (configured?.trim()) return configured.trim()
  const files = { wcdb: 'wcdb/win32/x64/wcdb_api.dll', key: 'key/win32/x64/wx_key.dll', image: 'wedecrypt/win32/x64/weflow-image-native-win32-x64.node', welive: 'welive/win32/x64/welive.exe' }
  const roots = [root, process.env.WEFLOW_RESOURCES_PATH, process.resourcesPath && join(process.resourcesPath, 'resources'), join(process.cwd(), 'resources')].filter(Boolean) as string[]
  return roots.map(directory => join(directory, files[kind])).find(existsSync) || ''
}
