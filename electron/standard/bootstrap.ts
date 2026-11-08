// Establish the existing product profile before any local-reader singleton is
// imported. Profile encryption must never depend on renderer/edition naming.
import { app } from 'electron'
import { isAbsolute, join } from 'node:path'
const isolated = process.env.WEFLOW_USER_DATA_PATH
if (isolated && !isAbsolute(isolated)) throw Error('隔离资料路径必须为绝对路径')
app.setPath('userData', isolated || join(app.getPath('appData'), 'WeFlow'))
if (isolated) { app.setPath('sessionData', join(isolated, 'session-data')); process.env.WEFLOW_CONFIG_CWD ||= isolated }
app.setName('WeChatAuto')
process.env.WEFLOW_RESOURCES_PATH = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
