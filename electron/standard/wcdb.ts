import { WcdbCore } from './wcdbReadCore'

// This adapter exposes only database reads used by browsing and export. In
// particular the native library's mutation functions are never reachable here.
const core = new WcdbCore()
type DatabasePort = { [K in keyof WcdbCore]: K extends 'isConnected' ? () => Promise<boolean> : WcdbCore[K] }
const allowed = /^(get[A-Z]|list[A-Z]|fetchMessageBatch$|openMessageCursor$|closeMessageCursor$|resolveImageHardlink|resolveVideoHardlink|isConnected$|isReady$|open$|close$|shutdown$|setPaths$|setLibPath$|setLogEnabled$|testConnection$|execQuery$)/
export const wcdbService = new Proxy({}, {
  get(_target, method: string) {
    if (!allowed.test(method) || typeof (core as any)[method] !== 'function') return undefined
    if (method === 'isConnected') return async () => core.isConnected()
    return (...args: any[]) => {
      if (method === 'execQuery' && !/^\s*(?:SELECT\b|PRAGMA\s+(?:table_info|table_xinfo|index_list|index_info)\s*\()/i.test(String(args[2] || ''))) throw Error('普通版只允许数据库读取')
      return (core as any)[method](...args)
    }
  },
}) as DatabasePort
