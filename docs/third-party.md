# 第三方组件

项目级 Apache-2.0 许可不替代依赖和原生组件各自的许可。

| 组件 | 许可与说明位置 |
| --- | --- |
| Electron / Chromium | 安装依赖及打包运行时随附的 LICENSE、LICENSES.chromium.html 等文件。 |
| React、Vite、TypeScript、Koffi、silk-wasm、ExcelJS 等 npm 依赖 | package-lock.json 记录固定版本与来源，各依赖包随附自己的 LICENSE/NOTICE。 |
| ffmpeg-static | npm 包的许可及所分发 FFmpeg 二进制适用的许可，以依赖包所附文件为准。 |
| .NET 连接辅助程序 | resources/wechat-connection/win32-x64/LICENSE.TXT 与 THIRD-PARTY-NOTICES.TXT。 |
| 数据库、图片及媒体预编译组件 | scripts/standard-public-files.json 记录分发文件和 SHA-256；包含原生载荷不表示其源码全部在本仓库提供。 |
| Windows C/C++ 运行时 | 由相应 Microsoft 运行时再分发条款约束。 |

发布时保留依赖与运行时已有许可文件，不将第三方代码声明为 Lay-quq 独立创作。
