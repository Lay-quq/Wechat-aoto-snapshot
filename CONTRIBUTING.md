# 参与改进

欢迎提交可以复现的问题和针对普通版的改进。请先阅读 README 的构建说明，在 Windows x64 与 Node.js 24 上验证。

提交前运行 npm run test:source、npm run typecheck 和 npm run build:compile。新增运行源码或原生资源需要同步审查 scripts/standard-public-files.json；不要为通过检查扩大为目录通配符。

本仓库不接受账号配置、聊天数据库、真实头像、API Key、访问令牌或未经脱敏的日志。截图请使用合成数据。不要向真实联系人试发消息。

保持现有用户资料和资料锁兼容。预编译资源发生变化时应说明原因并更新摘要。修改源码会使发布清单校验失败，维护者在发布前从新的干净输出目录运行 export:source，并重新验证生成的快照。

提交贡献表示你有权按本项目 Apache-2.0 许可证提供这些改动；第三方组件继续遵循各自许可。
