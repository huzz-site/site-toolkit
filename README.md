# Site Toolkit

`site` 是 `huzz-site` 组织使用的确定性网站交付 CLI。它负责创建 Vue 3 + Vite + Cloudflare Workers 站点、执行统一检查、部署、查询状态和回滚。

默认部署目标是 Cloudflare Workers Static Assets，并直接返回 `workers.dev` 地址；自定义域名按需配置。每个网站可以部署到不同的 Cloudflare Account，不存在工作区级默认账号，也不需要执行初始化命令。完整目标和取舍见 [架构文档](./docs/architecture.md)。

## 本地开发

```bash
pnpm install
pnpm check
pnpm site --help
```

## 凭证

每个 Cloudflare Account 首次使用时，运行一次交互式登录：

```bash
pnpm site --cwd .. auth login \
  --account-id 66b10df30a8a1f2f1ba98292a8cb2b18
```

CLI 会打开 Cloudflare 官方 Account API Tokens 页面，提示选择目标 Account 和 `Edit Cloudflare Workers` 模板，并通过隐藏输入接收 Token。Token 验证成功后按 Account ID 写入操作系统凭据库：macOS Keychain、Windows Credential Manager 或 Linux Secret Service。它不会写入项目文件、CLI 参数、stdout 或日志，也不需要 Site Toolkit 自己维护主密码。

之后 `doctor`、`create`、`check`、`deploy`、`status`、`versions` 和 `rollback` 会根据显式 Account ID 或站点 `wrangler.jsonc` 自动复用对应 Token。若交互式 `doctor --account-id` 或 `create` 发现 Token 缺失、无效或账号不匹配，会自动进入同一登录流程并重试。

自动化和 AI 必须使用 `--non-interactive --json`。此模式绝不打开浏览器或等待输入；凭据不可用时会在 `credentialGuidance.authCommand` 中返回需要用户执行的交互命令。CI 或无系统凭据库的环境仍可通过 `CLOUDFLARE_API_TOKEN` 注入 Token；本地对已保存账号优先使用系统凭据库。

移除本机保存的凭据（不会撤销 Cloudflare 上的 Token）：

```bash
pnpm site --cwd .. auth forget \
  --account-id 66b10df30a8a1f2f1ba98292a8cb2b18
```

## 检查账号

```bash
pnpm site --cwd .. --non-interactive --json doctor \
  --account-id 66b10df30a8a1f2f1ba98292a8cb2b18
```

## 创建站点

```bash
pnpm site --cwd .. --non-interactive --json create huzz.top \
  --display-name "HUZZ" \
  --account-id 66b10df30a8a1f2f1ba98292a8cb2b18 \
  --no-backend \
  --visibility private
```

未指定 `--domain` 时只部署到 `workers.dev`。需要 Custom Domain 时显式增加 `--domain` 和可重复的 `--alias`。

## 安全边界

- GitHub Organization 固定为 `huzz-site`。
- `create --account-id` 在产生本地项目、GitHub 仓库或 Worker 前验证 Token 的账号权限。
- Token 按 Account ID 隔离保存在跨平台系统凭据库；不使用自定义明文文件或自制密码保险库。
- 每个站点的 `wrangler.jsonc` 固化自己的 Account ID，Shell 中遗留的 `CLOUDFLARE_ACCOUNT_ID` 不会覆盖它。
- 创建站点时，Token 通过标准输入写入该站点的仓库级 GitHub Secret，不进入仓库、命令参数或日志。
- Cloudflare 操作使用项目锁定版本的 Wrangler。
- AI 只调用 `site --non-interactive --json`，不直接执行外部写操作。
