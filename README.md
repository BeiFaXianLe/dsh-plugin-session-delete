# dsh-plugin-session-delete

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 补上「真正删除会话」能力的插件。

DSH 自带的只有归档：归档只是把会话藏起来，事件日志仍留在 `~/.dsh/sessions/`。本插件补上真正���删除——
会话头部一个 **Trash** 按钮，删除后内存中的会话被摘除（触发 `session/disposed`，所有打开的页面实时移除），
磁盘目录 `~/.dsh/sessions/<项目>/<会话ID>/` 一并清除，重启后不会复活。

## 功能

- **会话头部 Trash 按钮**：位于 `Session log` 按钮左侧，二次确认后删除。
- **彻底删除**：先从会话存储摘除（内存即释放），再删磁盘目录 + 投影缓存。
- **停止运行中的工作**：删除前先取消该会话的 Agent 并注销注册项。
- **安全门禁**：会话 ID 白名单校验（防路径注入）；**存在 fork 子会话时拒绝删除父会话**，并回报子会话 id。
- **实时同步**：删除后所有客户端立即移除该行；当前会话自动切走。
- **可诊断**：每次删除结果写入 `~/.dsh/plugin-session-delete.log`。

## 安装（通过插件市场搜索）

本插件发布在自建 Git 源上，不需要 npm。

1. 打开侧栏 **Plugins** → **More** → **Experimental plugins** → 打开 **Custom plugin markets**。
2. 切到 **Discover** 标签 → 添加索引源（index source）：
   ```
   https://raw.githubusercontent.com/<owner>/dsh-plugin-session-delete/main/market-index.json
   ```
3. 搜索 `session` → 找到 **Session Delete** → 安装。
4. **完全退出并重新打开 DeepSeek Harness**（宿主端代码只在启动时装载）。

## 安装（命令行）

```bash
dsh plugin --profile desktop add "git+https://github.com/<owner>/dsh-plugin-session-delete.git#<commit>"
```

## 兼容性

需要 **dsh 0.2.1-rc.x 或更新的 0.2.x**。插件使用 `ctx.webServer` 路由、`ctx.sessions.liveEntryFor/detachEntered`、
`ctx.agents` 与客户端 `uiWorkspace.clearMain()`，这些接口在 0.1.x 上不存在。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-session-delete
```

## 开发者

```bash
# 改完源码后重新发布（提交插件快照 + 刷新索引 + 推送）
node tools/market/publish-git-source.mjs --repo https://github.com/<owner>/dsh-plugin-session-delete

# 只重建并校验索引
node tools/market/build-market-index.mjs "https://raw.githubusercontent.com/<owner>/dsh-plugin-session-delete/main/market-index.json"
```

索引由 DSH 官方校验器 `@deepseek-ai/dsh-plugin-market-index` 校验（`tools/market/vendor/`），本地通过即宿主端可读。

## License

MIT
