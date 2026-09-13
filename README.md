# Site Toolkit

`site` 是 `huzz-site` 组织使用的确定性网站交付 CLI。它负责创建 Vue 3 + Vite + Cloudflare Workers 站点、执行统一检查、部署、查询状态和回滚。

默认部署目标是 Cloudflare Workers Static Assets，并直接返回 `workers.dev` 地址；自定义域名是可选配置。目标和取舍见 [架构文档](./docs/architecture.md)。

## 本地开发

```bash
pnpm install
pnpm check
pnpm site --help
```

创建一个不绑定自定义域名的站点：

```bash
pnpm site --cwd .. --non-interactive --json create huzz.cn \
  --display-name "弧之舟" \
  --with-backend \
  --visibility private
```

初始化本地工作区：

```bash
# 先用你选择的凭证工具把 Token 加载到 CLOUDFLARE_API_TOKEN
pnpm site --cwd .. init
```

CLI 不规定凭证的持久化方式。当前终端中临时、安全地载入 Token 的示例：

```zsh
read -s "CLOUDFLARE_API_TOKEN?Cloudflare API Token: "
export CLOUDFLARE_API_TOKEN
echo
```

```powershell
$secret = Read-Host "Cloudflare API Token" -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new("", $secret).Password
```

## 安全边界

- GitHub Organization 固定为 `huzz-site`。
- CLI 不持久化 Token；本地凭证由用户管理，并通过 `CLOUDFLARE_API_TOKEN` 环境变量注入。
- 创建站点时，Token 通过标准输入写入该站点的仓库级 GitHub Secret，不进入仓库、命令参数或日志。
- Cloudflare 操作使用项目锁定版本的 Wrangler。
- AI 只调用 `site --non-interactive --json`，不直接执行外部写操作。
