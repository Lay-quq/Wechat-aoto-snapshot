# 构建与原生组件

版本 5.2.7 面向 Windows x64，使用 Node.js 24。锁定依赖由 package-lock.json 管理，首次构建运行 npm ci。普通版入口为 electron/standardMain.ts 和 src/standard/main.tsx。

## 验证与打包

- npm run verify:source：核对发布快照文件 SHA-256，适用于未经修改的源码。
- npm run test:source：检查允许公开的源码及原生资源清单。
- npm run typecheck：只检查普通版源码与明确适配的公共服务。
- npm run build:compile：独立编译到 .standard-build。
- npm run build：重新编译至新的暂存目录，安装本项目所需 Electron 运行时，再生成 Windows x64 NSIS 安装器。

打包验证覆盖编译文件、依赖内容、ASAR 和原生资源摘要。最终使用包内 Electron、Koffi 和 WCDB 进行隔离初始化及关闭检查，不打开真实微信数据库。通过这些检查不代表每个微信版本或真实账号均已验收。

GitHub Windows CI 执行源码清单、类型检查与编译；其依赖安装跳过运行时下载脚本，并单独准备 esbuild。完整发行包仍通过正常 npm ci 与打包流程准备和核对 FFmpeg、Electron 等运行时，CI 编译通过不代表媒体运行功能已验收。

底层可执行文件名 WeFlow.exe 是当前 WCDB 的宿主兼容要求；界面及快捷方式使用 WeChatAuto。不要单独重命名该文件。已有用户资料的路径和加密方式保持兼容，构建不会自动安装。

## 预编译组件范围

资源包含数据库适配、连接辅助程序、图片解码和媒体辅助组件，以及 Windows C/C++ 运行时。准确路径与 SHA-256 见 scripts/standard-public-files.json 的 resources 字段。连接辅助程序的可用源码位于 tools/wechat-connection-helper；其他原生载荷以预编译形式提供，不能把 TypeScript 构建描述为所有原生库均可从此仓库重新编译。

没有启用 BLA 加固或自动更新发布。首次构建可能下载 Electron 和 ffmpeg 运行时。请保证可以访问 npm 与 GitHub 发行资源。
