# Site Toolkit

`site` 是 `huzz-site` 组织使用的确定性网站交付 CLI。它负责创建 Vue 3 + Vite + Cloudflare Workers 站点、执行统一检查、部署、查询状态和回滚。

当前状态：v1 实施中，工具自身和生成站点的本地闭环已经通过；真实 Cloudflare 首次部署仍需完成账号初始化。目标和取舍见 [架构文档](./docs/architecture.md)。

## 本地开发

```bash
pnpm install
pnpm check
pnpm site --help
```

初始化本地工作区：

```bash
pnpm exec tsx packages/cli/src/index.ts --cwd .. init
```

## 安全边界

- GitHub Organization 固定为 `huzz-site`。
- Token 不进入仓库或命令参数；本地保存在 macOS Keychain，CI 使用仓库级 GitHub Secret。
- Cloudflare 操作使用项目锁定版本的 Wrangler。
- AI 只调用 `site --non-interactive --json`，不直接执行外部写操作。
