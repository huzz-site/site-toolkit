# Site Toolkit 架构与核心流程

状态：v1 精简目标基线（实施中）  
GitHub Organization：[`huzz-site`](https://github.com/huzz-site)  
目标：用一个确定性的 CLI，快速创建、部署和轻量维护多个独立网站。

## 1. 设计原则

1. 先解决真实且高频的交付动作，不提前建设管理平台。
2. 本地根目录为 `huzz-site/`，它只是工作区，不是 Git 仓库。
3. `huzz-site/` 下每个一级站点目录都是独立 Git 仓库。
4. 一个仓库代表一个完整网站，包含前端和该网站的轻量后端，不单独拆分 API 仓库。
5. 所有网站仓库统一放在 GitHub Organization `huzz-site` 下。
6. `site-toolkit/` 是独立仓库，存放 CLI、模板、Schema 和复用工作流。
7. 每个网站默认部署为一个 Cloudflare Worker，静态资源与轻量后端一起发布和回滚。
8. CLI 使用 TypeScript + Node.js LTS + pnpm 实现。
9. v1 只提供 Vue 3 + Vite + TypeScript 官方模板。
10. Cloudflare 写操作通过站点本地锁定版本的 Wrangler 执行，不依赖全局 Wrangler。
11. AI Skill 只能调用 CLI，不能绕过 CLI 直接运行 GitHub、Wrangler 或 Cloudflare 写操作。
12. 新功能只有在真实数量、重复劳动或故障成本出现后才进入实现范围。

## 2. v1 必须实现的目标

### G1：一次初始化

`site init` 完成工作站检查、GitHub 登录、Cloudflare API Token 验证和默认 Account 选择。Token 由用户使用操作系统、密码管理器或 Shell 自行保存，CLI 只从环境变量读取。初始化必须可重复执行。

GitHub 浏览器授权和 Cloudflare Token 创建仍需要用户本人确认；确认完成后 CLI 自动验证并继续。首版不再维护一套额外的 Wrangler OAuth 凭证。

### G2：一条命令创建网站

`site create` 完成：

- 创建本地目录。
- 生成 Vue 3 + Vite 前端和可选的轻量 Worker 后端。
- 创建 `huzz-site/<repository>` GitHub 仓库。
- 生成配置、测试和 GitHub Actions 工作流。
- 首次提交并推送 `main`。
- 首次部署到 Cloudflare Workers。
- 返回仓库地址、Worker、Version 和访问 URL。

### G3：确定性部署

本地和 GitHub Actions 使用同一个 CLI 内核，按固定顺序执行配置校验、类型检查、测试、构建、Wrangler dry-run、部署和线上健康检查。

推送 `main` 默认直接部署生产。这是 v1 为减少操作步骤做出的明确选择。

### G4：满足早期轻量维护

CLI 可以查看单站点状态、重新部署、查看历史版本和回滚。日常修改仍通过正常 Git 分支、提交和 Pull Request 完成，不建设额外控制台。

### G5：稳定的 AI 调用边界

提供 `--non-interactive --json`、稳定退出码和版本化输出 Schema。AI 只负责把明确的用户意图转换成 CLI 参数。

### G6：首个真实站点

`huzz-site/huzz.cn` 是第一个端到端验收站点，但“弧之舟”的品牌、域名和内容只存在于该站点仓库，不进入通用工具。

## 3. v1 明确不做

- 不创建 `site-registry` 客户或站点台账仓库。
- 不实现客户生命周期状态机。
- 不实现 `site list` 或 GitHub Topic 编排；站点少时直接看本地一级目录或 GitHub Organization。
- 不实现通用 `site secret` 管理；第一个后端真正需要业务 Secret 时再补。
- 不实现 `site client`、维护等级或合同信息管理。
- 不实现 Delivery Manifest、`plan/apply` 或复杂任务恢复引擎。
- 不实现多 Cloudflare Account Profile 编排；v1 使用一个默认代管 Account。
- 不实现预览、批准、生产提升三段式发布流程。
- 不实现 GitHub Environment 审批系统。
- 不实现跨仓库 Fleet 巡检、批量升级或批量部署。
- 不实现自动生成升级 Pull Request。
- 不实现客户迁出或跨账号资源搬迁工具。
- 不实现 Astro、纯静态站等多个官方模板。
- 不实现通用项目自动识别、导入或接管。
- 不建设 SaaS 控制台、数据库或常驻服务。
- 不自动购买域名或修改任意注册商的 Nameserver。
- 不自动删除 GitHub 仓库、Worker、域名或持久化数据。
- 不由 CLI 或 AI 生成品牌、设计、文案和业务需求。

以上能力不是被否定，而是进入第 12 节的按需演进清单。

## 4. 工作区和仓库结构

```text
huzz-site/                         # 本地工作区，不执行 git init
├── site-toolkit/                  # huzz-site/site-toolkit
│   ├── packages/
│   │   ├── cli/                   # `site` 命令
│   │   ├── core/                  # 配置、执行流程、外部工具适配
│   │   └── templates/
│   │       └── vue/               # v1 唯一官方模板
│   ├── schemas/
│   ├── .github/workflows/         # 中央复用工作流
│   └── docs/
│
├── huzz.cn/                       # huzz-site/huzz.cn
├── example.com/                   # huzz-site/example.com
└── another-site/                  # huzz-site/another-site
```

不使用 Git submodule，也不建立包含所有站点源码的总仓库。

## 5. 一个站点仓库的边界

```text
网站前端
  + 可选轻量后端（/api、表单、Webhook 等）
  + 按需使用的 Cloudflare Bindings
  + 主域名和子域名
  = 一个 GitHub 仓库
  = 一个 Cloudflare Worker
  = 一个独立发布与回滚单元
```

默认结构：

```text
huzz.cn/
├── src/                           # Vue 前端
├── server/index.ts                # 可选 Worker 后端
├── public/
├── tests/
├── site.config.json               # Site Toolkit 配置
├── wrangler.jsonc                 # Cloudflare 配置
├── vite.config.ts
├── package.json
└── .github/workflows/deploy.yml
```

出现 `/api/*` 不代表需要拆仓。只有后端已经被多个网站共享，并需要独立发布和独立生命周期时，才把它拆成另一个产品。

## 6. 配置的事实来源

- GitHub 仓库身份：当前 Git remote。
- GitHub Organization：CLI 内固定为 `huzz-site`。
- Account ID、Worker、路由、域名和 Bindings：`wrangler.jsonc`。
- 构建命令、产物目录、健康检查和模板版本：`site.config.json`。
- 密钥：Wrangler 凭证存储、GitHub Actions Secrets 或 Cloudflare Secrets。

`site.config.json` 示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/huzz-site/site-toolkit/v1/schemas/site.schema.json",
  "version": 1,
  "id": "huzz-cn",
  "displayName": "弧之舟",
  "template": "vue",
  "templateVersion": "1.0.0",
  "packageManager": "pnpm",
  "build": {
    "command": "pnpm",
    "args": ["build"],
    "output": "dist"
  },
  "healthChecks": [
    "https://huzz.cn/",
    "https://huzz.cn/api/health"
  ]
}
```

`wrangler.jsonc` 示例：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "huzz-cn",
  "account_id": "<ACCOUNT_ID>",
  "main": "./server/index.ts",
  "compatibility_date": "YYYY-MM-DD",
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "routes": [
    { "pattern": "huzz.cn", "custom_domain": true },
    { "pattern": "www.huzz.cn", "custom_domain": true }
  ]
}
```

Account ID 不是密钥，可以进入站点配置。Token 不得写入上述文件。

自定义域名必须属于所选 Account 中的 active Cloudflare Zone。CLI 不替用户修改域名注册商 Nameserver；域名尚未接入 Cloudflare 时，先完成 Zone 激活再创建站点。

## 7. CLI 技术方案

```text
源码          TypeScript（strict）
CLI 命令      site
运行时        固定 Node.js LTS
包管理        pnpm
测试          Vitest
Cloudflare    站点本地锁定 Wrangler v4+
GitHub        gh CLI
Git           git CLI
```

选择 TypeScript 是因为网站、Vue、Vite 和 Wrangler 本身都在 Node.js 工具链中，可以避免额外维护 Go 或 Rust 的构建与发布体系。

### 7.1 v1 命令面

```text
site init                     初始化工作站、GitHub 和默认 Cloudflare Account
site doctor                   检查依赖、认证、权限和工作区
site create                   创建完整网站、仓库并首次部署
site check                    执行配置、类型、测试、构建和 dry-run 检查
site dev                      启动统一的本地开发环境
site deploy                   部署当前站点并执行健康检查
site status                   查看当前仓库、CI、Worker 和线上版本
site versions                 列出当前 Worker 的历史版本
site rollback                 回退到指定或上一个 Worker Version
```

命令数量不是目标。`versions` 只为精确回滚提供 Version ID；首版不做站点目录、Topic 和通用 Secret 管理。

### 7.2 外部工具调用规则

- Git 操作调用 `git`。
- GitHub 登录、仓库和 Actions 操作调用 `gh` 或 `gh api`。
- Cloudflare 开发、校验、部署、Secret、版本和回滚调用站点固定版本的 Wrangler。
- Cloudflare REST API 只用于 Wrangler 确实缺少的必要能力，并统一封装在 Cloudflare Adapter 中。
- 所有外部命令传入参数数组，不拼接 Shell 字符串。
- 本地和 CI 调用相同的 TypeScript 执行函数，不在 YAML 或 Skill 中复制业务逻辑。

## 8. 核心流程

### 8.1 `site init`

流程：

1. 检查 Git、Node.js、pnpm、`gh` 和项目 Wrangler。
2. 验证当前目录是预期的 `huzz-site` 工作区。
3. 运行 `gh auth status`；未登录时发起浏览器登录。
4. 验证当前身份可以访问并创建 `huzz-site` 组织仓库。
5. 从 `CLOUDFLARE_API_TOKEN` 环境变量读取 Cloudflare 的 `Edit Cloudflare Workers` Token，并用 `wrangler whoami --json` 验证。
6. 从 Token 可访问的 Accounts 中选择默认 Account；只有一个时自动选择，多个时由用户选择一次。
7. 保存非敏感的默认 Account ID 和名称。
8. 验证完整配置并输出结果；CLI 不持久化 Token。

同一个受限 API Token 可以同时服务本地 Wrangler 和 CI。用户负责在执行 CLI 前把 Token 注入 `CLOUDFLARE_API_TOKEN`；CLI 不把它写入项目文件或日志。创建仓库时，CLI 从当前环境读取 Token，并通过标准输入写入该仓库自己的 GitHub Actions Secret。

不使用 Organization Secret：`huzz-site` 当前是 GitHub Free，组织级 Secret/Variable 无法被私有仓库使用。仓库级 Secret 可同时支持公开和私有站点，也不需要 `admin:org` 权限。

```bash
site init
site init --non-interactive --json
```

非交互模式遇到未完成的登录或缺失参数时直接失败，不等待输入。

### 8.2 `site doctor`

检查：

- 固定 GitHub Organization 是否可访问。
- GitHub 登录和 Cloudflare API Token 是否有效。
- 默认 Cloudflare Account 是否可访问。
- 当前环境中是否存在 `CLOUDFLARE_API_TOKEN`。
- Node.js、pnpm、Wrangler 和 CLI 版本是否兼容。
- 工作区、目录和仓库是否冲突。

稳定错误示例：

```text
AUTH_GITHUB_MISSING
AUTH_GITHUB_SCOPE_INSUFFICIENT
AUTH_CLOUDFLARE_MISSING
CF_ACCOUNT_NOT_FOUND
CF_CI_SECRET_MISSING
WORKSPACE_INVALID
```

### 8.3 `site create`

```bash
site create huzz.cn \
  --display-name "弧之舟" \
  --domain huzz.cn \
  --alias www.huzz.cn \
  --with-backend \
  --visibility private
```

流程：

1. 运行 `site doctor`。
2. 校验本地目录、仓库名、Worker 名和域名。
3. 检查本地目录、GitHub 仓库和 Worker 名冲突；Cloudflare 域名路由冲突由部署返回。
4. 渲染固定版本的 Vue 模板。
5. 生成 `site.config.json`、`wrangler.jsonc` 和最小工作流。
6. 安装依赖并执行 `site check`。
7. 初始化 Git，创建首次提交。
8. 创建 `huzz-site/<repository>` GitHub 仓库。
9. 为新仓库设置 `CLOUDFLARE_API_TOKEN` Secret 和 `CLOUDFLARE_ACCOUNT_ID` Variable。
10. 推送 `main` 并等待中央工作流完成首次部署。
11. 运行线上健康检查。
12. 输出仓库、Worker、Version 和 URL。

任何步骤失败时输出已完成步骤和恢复建议。默认不删除已经创建的远端资源。

非交互调用必须提供完整参数：

```bash
site create huzz.cn \
  --display-name "弧之舟" \
  --domain huzz.cn \
  --alias www.huzz.cn \
  --with-backend \
  --visibility private \
  --non-interactive \
  --json
```

### 8.4 `site check`

固定执行：

1. 配置 Schema 校验。
2. TypeScript 类型检查。
3. 单元测试。
4. 前端与 Worker 构建。
5. `wrangler deploy --dry-run`。

本地和 CI 使用同一实现。

### 8.5 `site deploy`

```bash
site deploy
site deploy --dry-run
```

流程：

1. 确认当前目录是受管理站点。
2. 拒绝存在未提交改动的生产部署。
3. 运行 `site check`。
4. 执行 `wrangler deploy`。
5. 读取 Version、Deployment 和 URL。
6. 执行线上健康检查。
7. 输出结构化结果。

站点仓库只保存中央工作流调用入口：

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    uses: huzz-site/site-toolkit/.github/workflows/deploy.yml@v1
    with:
      cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### 8.6 `site rollback`

```bash
site versions
site rollback --previous
site rollback --to <version-id>
```

回滚流程：

1. 读取当前 Worker 的 Versions 和 Deployments。
2. 验证目标 Version 属于当前 Worker。
3. 显示当前 Version 和目标 Version。
4. 调用站点固定版本的：

   ```bash
   pnpm exec wrangler rollback <VERSION_ID> --message <MESSAGE>
   ```

5. 读取新 Deployment，确认目标 Version 已恢复到 100% 流量。
6. 重新执行健康检查。
7. 输出回滚前后 Version 和新 Deployment ID。

回滚不执行 Git revert，也不重新构建历史提交。它不会回退 D1、KV、R2 或 Durable Objects 中的数据。

## 9. 轻量维护方式

早期维护不需要额外平台：

- `site status` 查看单个站点的仓库、Actions、Worker 和线上版本。
- 修改内容或代码后提交到 GitHub，`main` 自动部署。
- 部署失败由 GitHub Actions 和 CLI 返回明确错误。
- 线上异常时执行 `site rollback --previous`。
- 域名、Bindings 和健康检查继续保存在站点仓库中。

当站点还可以在几分钟内定位和处理时，不增加数据库、Registry、Dashboard 或定时巡检服务。

## 10. Skill 与 CLI 边界

允许的调用链：

```text
用户
  → AI Skill 收集明确参数
  → site ... --non-interactive --json
  → CLI 校验并执行
```

禁止的调用链：

```text
AI
  → 自行选择账号或域名
  → 自行拼接 gh / wrangler / curl
  → 绕过 CLI 直接部署或回滚
```

JSON 输出：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "deploy",
  "site": "huzz.cn",
  "result": {
    "repository": "huzz-site/huzz.cn",
    "worker": "huzz-cn",
    "versionId": "<version-id>",
    "urls": ["https://huzz.cn"]
  },
  "warnings": []
}
```

- stdout 只输出 JSON，日志写 stderr。
- 成功退出码为 `0`。
- 参数、认证、权限、冲突、构建和部署失败使用稳定错误类型。
- Skill 不解析彩色终端文本。

## 11. 安全与幂等性

- Token 只通过环境变量、标准输入或仓库级 GitHub Secret 传递；本地持久化由用户管理。
- Token 不进入命令参数、Git、stdout、日志或部署记录。
- GitHub Organization 固定为 `huzz-site`。
- 每个站点的 `wrangler.jsonc` 固定 Account ID，部署前必须校验。
- 每个站点仓库只持有自身部署所需的 Cloudflare Secret；不依赖付费的组织级 Secret。
- `init` 和 `create` 可重复执行；已满足步骤返回 `unchanged`。
- 删除仓库、Worker、域名和持久化数据不属于 v1 命令面。
- 回滚必须由用户明确要求，Skill 不自行判断。

## 12. 按需演进清单

只有出现右侧触发条件时，才设计和实现对应能力。数字是决策参考，不是硬性规则。

| 延后能力 | 触发信号 | 届时可能的方案 |
| --- | --- | --- |
| 私有 `site-registry` | 约 10 个以上活跃站点，或仅靠 Topic/仓库名已多次找错资源 | 增加非敏感站点与客户索引 |
| `site list` 与 Topic | 本地目录和 GitHub Organization 已明显难以检索 | 先增加只读发现，不引入数据库 |
| 通用 `site secret` | 第一个轻量后端需要由 CLI 管理业务 Secret | 只封装 Wrangler 的最小 put/list 操作 |
| 多 Cloudflare Account | 第一个客户明确要求资源归自己，或共享账号产生账单/隔离风险 | 增加 Account Ref 和 Wrangler auth profile 适配 |
| 预览与批准后上线 | 第一个需要正式客户验收或生产审批的项目 | `versions upload` + Preview URL + `versions deploy` |
| Delivery Manifest、`plan/apply` | 开始一次批量创建多个站点，或创建中断恢复成为常见问题 | 增加声明式 Manifest 和幂等执行计划 |
| `site import` / `site adopt` | 第一个需要接管非标准项目的真实订单 | 只为实际遇到的框架增加适配器 |
| Astro 或纯静态模板 | Vue 模板明显不适合已确认的内容型项目 | 增加第二个模板，不提前做通用插件系统 |
| Fleet 巡检 | 手工检查每周持续超过约 30 分钟，或遗漏问题造成事故 | 增加 `site status --all` 和定时只读检查 |
| 模板批量升级 | 同一升级需要在至少 3 个站点重复操作 | 生成逐站 PR，不批量直推 `main` |
| 自动上线质量门 | 人工 Checklist 经常漏项 | 把已经稳定的 Checklist 固化为 `site launch-check` |
| 客户移交工具 | 第一个真实迁出或账号交接需求 | 先实现只读资源清单，再考虑迁移自动化 |
| 数据备份编排 | 第一个站点使用重要的 D1、KV、R2 或 Durable Objects 数据 | 针对实际存储类型单独设计，不做抽象备份框架 |
| 独立 Dashboard/SaaS | CLI 和 GitHub 已不能满足日常操作人员 | 再评估是否值得建设常驻服务和数据库 |

原则：先手工完成一次，重复两三次后再抽象；先增加最窄能力，再根据真实差异扩展。

## 13. v1 完成标准

以下条件全部满足才算 v1 完成：

1. `site init` 能验证环境中的 Token、完成默认账号准备，并可重复执行。
2. `site doctor --json` 能报告依赖、GitHub、Cloudflare 和工作区状态。
3. 一条非交互 `site create` 能创建独立仓库并完成首次部署。
4. 默认站点包含 Vue 3 + Vite、可选 Worker 后端、`/api/health` 和测试。
5. 推送 `main` 调用中央复用工作流并部署生产。
6. 本地 `site check` 与 CI 使用同一实现。
7. `site status` 能关联仓库、Actions、Worker、Version 和 Deployment。
8. `site rollback --previous` 和 `--to <version-id>` 能恢复版本并通过健康检查。
9. 初始化和创建命令重复执行时不会产生重复仓库或破坏配置。
10. AI Skill 只依赖非交互 JSON 命令完成明确授权的创建、部署、查询和回滚。
11. 自动化测试覆盖认证缺失、权限不足、名称冲突、构建失败、部署失败和回滚失败。
12. `huzz-site/huzz.cn` 通过完整流程部署成功。

## 14. 实现顺序

### Phase 1：最短闭环

- CLI 框架、配置 Schema、JSON 协议和稳定错误类型。
- Vue 3 + Vite + 可选 Worker 后端模板。
- `doctor`、`check`、`dev`。
- 先在本地手工配置的 Cloudflare Account 上完成部署验证。

### Phase 2：全自动交付

- `init`、`create`、`deploy`、`status`。
- 固定 GitHub Organization 和仓库创建。
- GitHub Actions 中央复用工作流。
- Cloudflare Token 验证、Account 和仓库级 CI Secret 初始化。
- `versions`、`rollback`。
- 使用 `huzz.cn` 完成端到端验收。

### Phase 3：Skill 绑定

- 创建薄 Skill。
- Skill 只调用 `--non-interactive --json`。
- 删除、销毁和隐式账号切换不向 Skill 暴露。

第 12 节能力不属于上述阶段，只有触发信号出现后才另立目标。

## 15. 官方依据

- Cloudflare Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- Cloudflare Workers Versions 与 Deployments：<https://developers.cloudflare.com/workers/versions-and-deployments/>
- Cloudflare Workers 回滚：<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>
- Wrangler Workers 命令：<https://developers.cloudflare.com/workers/wrangler/commands/workers/>
- Wrangler 认证：<https://developers.cloudflare.com/workers/wrangler/commands/general/>
- Wrangler 配置：<https://developers.cloudflare.com/workers/wrangler/configuration/>
- Cloudflare API Token：<https://developers.cloudflare.com/fundamentals/api/get-started/create-token/>
- GitHub 可复用工作流：<https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows>
- GitHub Organization Secrets：<https://docs.github.com/en/rest/actions/secrets>
