# 部署与运维

`deploy/compose.yaml` 管理当前可交付的八个服务：Web、独立 Run Worker、Search Agent、PostgreSQL、
Milvus、etcd、MinIO 与内部 `xiaohongshu-mcp`。Worker 与 Web 使用同一镜像但运行不同入口；Worker 不
开放端口，可用 `docker compose ... --scale worker=2` 横向扩展。Milvus 使用项目独立目录
`D:\001-agent\milvus`，不会读取、停止、重建或删除既有 `D:\milvus` 实例和数据。

## 本地启动

前置条件：

- `config/agent-runtime.local.json`、`config/search.local.json` 与
  `config/deploy.local.env` 已按本地规范准备；
- `D:\001-agent\milvus` 是专用于本项目的新目录，包含 `etcd`、`minio`、`milvus`；
- 正式 Web 使用 `127.0.0.1:3000`，Search Agent 健康/调试端口使用
  `127.0.0.1:8080`；Milvus gRPC/健康端口只在 `agent-milvus` 私网内使用。

首次部署可运行 `.\deploy\new-local-env.ps1` 生成被 Git 忽略的
`config/deploy.local.env`。脚本分别生成内部传输 Token 与租户断言密钥，不会在
终端输出任何密钥；默认模式不会覆盖已有文件。

从旧版本升级已有环境文件时必须显式执行：

```powershell
.\deploy\new-local-env.ps1 -UpgradeTenantAssertionSecret
```

该模式只补充或修复 `WORKBENCH_TENANT_ASSERTION_SECRET`，合规值保持不变，其他
配置逐字保留并通过同卷临时文件原子替换。创建、升级和轮换都会关闭文件 ACL
继承，只允许当前 Windows 用户、Administrators 与 SYSTEM 访问；不支持 Windows
ACL 的卷或无权修改 ACL 的账户会在写入密钥前失败。不要用复制示例文件覆盖已有
环境，也不要把密钥粘贴到终端历史。若替换后的 ACL 终检失败，脚本会先原子恢复
旧文件并再次验证；只有更新成功或回滚验证成功才删除 backup。回滚也失败时会保留
backup 路径并 fail-closed，运维人员不得继续重建三端。

只做静态解析且不输出插值后的密钥：

```powershell
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml config --quiet
```

在不读取真实环境文件的系统临时目录中验证创建、升级、轮换、原子替换与 ACL：

```powershell
.\deploy\test-new-local-env.ps1
```

启动本项目管理的服务：

```powershell
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml up -d --build
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml ps
```

验证 Web、Search Agent、Run Worker 与项目 Milvus：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:8080/health
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml ps worker
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml logs --tail 20 worker
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml exec milvus `
  curl --fail http://127.0.0.1:9091/healthz
```

正式公网入口为
[https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench)。当前
Cloudflare Tunnel 只把 `luzern.cc.cd` 与 `www.luzern.cc.cd` 转发到
`http://127.0.0.1:3000`；不得添加 Search Agent、数据库、Milvus、MinIO 或
MCP 的公网 ingress。

Search Agent 的 `/health` 在 Milvus 不可达时返回 `degraded`，进程仍可执行不带
向量记忆的搜索。PostgreSQL 不可达时服务启动失败，这是有意的 fail-closed：
checkpoint 与搜索幂等账本不能在生产环境静默丢失。

Web API 只创建 `queued` Run 和用户事件，不直接调用模型或搜索。Worker 使用 PostgreSQL
`FOR UPDATE SKIP LOCKED` 领取任务，默认 lease 30 秒、heartbeat 10 秒；每次接管递增 epoch，事件、
续租、释放和终态提交都必须匹配 owner + epoch。SIGTERM/SIGINT 会停止领取、取消当前上游连接、交还
未完成 lease 并关闭数据库连接。Worker 崩溃时不执行清理，租约到期后由其他实例以 `resume=true`
从 LangGraph Checkpoint 接管。

## PostgreSQL 集成测试隔离

`apps/web` 的真实 PostgreSQL 集成测试不会回退到业务数据库。运行前必须显式设置
`WORKBENCH_INTEGRATION_DATABASE_URL`；runner 只接受 loopback PostgreSQL，并要求数据库名以
`_test` 或 `_integration` 结尾。示例：

```powershell
$env:WORKBENCH_INTEGRATION_DATABASE_URL = "postgresql://postgres:<password>@127.0.0.1:5432/agent_workbench_integration"
cd apps/web
npm run test:integration
```

不得把 `WORKBENCH_DATABASE_URL`、Compose 业务库或远程 PostgreSQL 复制到该变量。URL 解析错误使用固定
脱敏消息，不应在测试日志中回显密码。

## 小红书登录

`xiaohongshu-mcp` 不发布宿主机端口，Web 也不加入它的私有网络。首次使用或
登录态失效时，在部署主机运行：

```powershell
.\deploy\get-xiaohongshu-login-qrcode.ps1
```

脚本只通过容器内的登录端点获取二维码，把 PNG 临时写入系统临时目录并打开。
二维码原始内容不会写入仓库、配置或终端日志；登录成功或四分钟超时后临时文件
会被删除。Cookie 只保存在命名卷
`001-agent-live-xiaohongshu-session-v2`。Search Agent 的适配器只允许登录状态、
二维码、搜索、笔记详情和用户主页五类读取，发布、评论、点赞、收藏和删除
Cookie 会在网络请求前被拒绝。

仓内 `services/xiaohongshu-mcp/` 固定自上游提交 `a5bb5b8`，并保留
Apache-2.0 许可证。项目补丁只把搜索页的全局 network-idle 等待改为等待非空
的真实 `search.feeds` 数据，既避免持续埋点请求导致假超时，也避免响应式空数组
被误报成“搜索成功但 0 条”。部署服务本身也只注册上述五类只读能力；所有写
路由返回 404；HTTP 与 MCP 工具 panic 均不返回或记录原始错误，导航日志不包含
带签名 URL。完整基线和升级规则见
`services/xiaohongshu-mcp/UPSTREAM.md`。
当前项目部署版本为 `v2.2.6-agent-workbench.5`。安全验证入口复用触发风控的
原工具会话，从当前 CAPTCHA 页读取二维码；不会打开普通小红书页面代替验证。

## 配置与生产约束

### 租户断言密钥轮换与回滚

密钥轮换没有双密钥兼容窗口，Web、Run Worker 与 Search Agent 的任意新旧组合
都会 fail-closed。`docker compose restart` **不会**重新读取 env 文件，不能用于
密钥轮换。使用以下维护顺序：

1. 暂停公网新请求，等待 `queued`/`running` Run 排空；随后停止 Worker，确保不再
   领取任务。若维护窗口不能等待当前 Run 完成，`stop worker` 会走 SIGTERM 释放
   lease，稍后由新 Worker 从 checkpoint 接管。
2. 显式轮换且不输出新值：

   ```powershell
   docker compose --env-file config/deploy.local.env -f deploy/compose.yaml stop worker
   .\deploy\new-local-env.ps1 -RotateTenantAssertionSecret
   docker compose --env-file config/deploy.local.env -f deploy/compose.yaml config --quiet
   ```

3. 在 Worker 保持停止时重建 Search Agent 与 Web，使二者读取同一新值：

   ```powershell
   docker compose --env-file config/deploy.local.env -f deploy/compose.yaml up -d --force-recreate search-agent web
   Invoke-RestMethod http://127.0.0.1:3000/health
   Invoke-RestMethod http://127.0.0.1:8080/health
   ```

4. 健康检查通过后重建 Worker，完成一次真实的 Web→Worker→Search Agent smoke，再
   恢复公网入口：

   ```powershell
   docker compose --env-file config/deploy.local.env -f deploy/compose.yaml up -d --force-recreate worker
   docker compose --env-file config/deploy.local.env -f deploy/compose.yaml ps worker
   ```

回滚版本时同样先停止入口并排空/停止 Worker，然后把 Web、Worker、Search Agent
三个镜像作为一个单元回退并 `--force-recreate`；绝不能只回滚 Search Agent。若只
需撤销一次密钥轮换，不要把旧值贴回 shell，可再次生成一个新的共同密钥并按上述
顺序重建三端。混合版本或混合密钥期间不得启动 Worker，否则认证拒绝可能把已领取
Run 记录为失败。

### 配置存放

- 非密钥默认值集中在 `config/search-agent.json`；DeepSeek、Tavily 等 Provider
  密钥保存在被忽略的 `config/*.local.json`，Compose 服务凭据保存在被忽略的
  `config/*.local.env`，生产环境使用密钥管理系统。镜像构建不会复制 `config/`。
- Compose 将 `config/` 只读挂载到 Web、Run Worker 与 Search Agent。生产环境必须设置随机的
  `POSTGRES_PASSWORD`、与其一致且密码已 URL 编码的
  `SEARCH_AGENT_DATABASE_URL`、`WORKBENCH_INTERNAL_TOKEN`，以及独立的
  `WORKBENCH_TENANT_ASSERTION_SECRET`。租户断言密钥按 UTF-8 计算至少 32 字节，
  不得与内部传输 Token 相同或由其派生；Web、Run Worker 与 Search Agent 必须
  注入同一个断言密钥。
- 轮换租户断言密钥时应把 Web、Run Worker 与 Search Agent 作为一个发布单元协调
  重建；新旧密钥不匹配期间运行请求会被 fail-closed 拒绝。生产 Compose 中 Search
  Agent 绑定 `0.0.0.0`，不能使用无密钥例外。只有同时设置
  `SEARCH_AGENT_ALLOW_INSECURE_LOOPBACK=1` 且 Search Agent 主机为 loopback 的显式
  本机开发进程，才允许不配置断言密钥。
- Search Agent 容器固定启用 `LANGGRAPH_STRICT_MSGPACK=true`，只反序列化
  LangGraph 内建安全类型；不要在生产环境关闭该限制。
- `config/deploy.env.example` 只列变量名和非密钥占位值，不可作为生产密钥文件。
- Web、PostgreSQL 和 Search Agent 的宿主机端口默认只绑定 `127.0.0.1`；Run Worker 不发布端口；
  Milvus、etcd、MinIO 与小红书 MCP 不发布宿主机端口，小红书 MCP 使用独立的
  私有/出站网络。
  不得直接暴露 MCP、数据库、对象存储或 gRPC 端口到公网。
- Compose project 为 `001-agent-live`，PostgreSQL 使用显式卷
  `001-agent-live-postgres-v1`。禁止执行 `docker compose down -v`。
- 发布前将基础镜像改为经验证的 digest，并在 CI 中生成 SBOM、执行镜像扫描。

## 项目 Milvus 与 D 盘边界

当前项目实例的持久化边界是一个不可拆分的一致性组：

```text
D:\001-agent\milvus\etcd
D:\001-agent\milvus\minio
D:\001-agent\milvus\milvus
```

只复制 `volumes\milvus` 不能形成可恢复备份。etcd 保存元数据，MinIO 保存对象，
Milvus 目录保存本地运行数据；三者必须来自同一维护窗口/存储快照。当前 Compose
使用 `agent-workbench-live-milvus-*` 容器名、项目内部网络和独立宿主机端口，避免
与既有 `milvus-*` 容器及 `D:\milvus` 冲突。远程生产 Milvus 可通过
`SEARCH_AGENT_MILVUS_URI=https://milvus.internal:19530` 覆盖。

## 哨兵重启/恢复验证

维护前在实际 Evidence collection 写入隔离哨兵；它的
`memory_type=ops_sentinel`，不会进入业务召回：

```powershell
$tag = "maintenance-20260728-01"
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml exec search-agent `
  python /workspace/deploy/ops/milvus_sentinel.py write --tag $tag
```

在**已批准的维护窗口**重启或恢复 `D:\001-agent\milvus` 后，等待三个容器恢复
healthy，
再验证并清理单条哨兵：

```powershell
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml exec search-agent `
  python /workspace/deploy/ops/milvus_sentinel.py verify --tag $tag
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml exec search-agent `
  python /workspace/deploy/ops/milvus_sentinel.py cleanup --tag $tag
```

该脚本从不创建/删除 collection；本次代码交付不会执行 write/cleanup，避免对
正在运行的 Milvus 产生任何写入。

## 备份与恢复

优先使用官方 `milvus-backup` 做在线逻辑备份。它必须同时连接 Milvus、Milvus
使用的对象存储和备份目标；备份应恢复到同版本或更高版本的 Milvus。每次备份
后在隔离实例执行恢复演练，并用上述哨兵及业务抽样查询验证。

如必须做冷文件级备份：

1. 停止 Web/Search Agent 写流量并记录哨兵 tag；
2. 在批准的维护窗口停止 standalone、MinIO、etcd；
3. 将上述三个目录复制到 `D:\001-agent\milvus-backups\<timestamp>\`，不要覆盖源目录；
4. 启动原实例，确认三个容器 healthy 并核验哨兵；
5. 保存 `deploy/compose.yaml`、`deploy/milvus/user.yaml`、镜像版本、目录校验清单与恢复记录。

恢复时不要原地覆盖 `D:\001-agent\milvus`。先恢复到新的 D 盘目录、不同 Compose project
和不同宿主机端口，核验 collection、实体数量、哨兵与抽样查询后再切换
`SEARCH_AGENT_MILVUS_URI`。若验证失败，切回原 URI 即可。

PostgreSQL 使用 `pg_dump --format=custom` 做逻辑备份，并只恢复到新建空数据库
进行演练。`002_search_agent_runtime.sql` 是前向兼容的幂等迁移；应用降级时保留
该表，不执行删除迁移。

## 降级与回滚

- Milvus 故障：保持 Search Agent 在线并观察 `/health` 的 `degraded`，暂停记忆
  写入告警；搜索与核验链路继续运行，恢复后再做召回抽样。
- Search Agent 发布失败：按“租户断言密钥轮换与回滚”先排空并停止 Worker，同时
  回滚 Web、Worker、Search Agent 三个兼容镜像并强制重建；保持 PostgreSQL schema
  与 Milvus collection 不动，检查 checkpoint/工具账本后再恢复流量。
- 新入口回滚：旧容器 `kanna-workbench-backend-1` 仅被停止，没有删除镜像、卷
  或数据；需要恢复时执行 `docker start kanna-workbench-backend-1`。恢复前先
  确认它要占用的端口不会与本项目 `127.0.0.1:8080` 冲突。
- 不要将 Milvus 2.6 的逻辑备份直接恢复到更低版本。需要降级 Milvus 时，启动
  隔离的兼容版本并使用升级前备份验证，原 2.6.21 实例保持不变直到验收完成。

参考：

- [Milvus Docker Compose 安装](https://milvus.io/docs/install_standalone-docker-compose.md)
- [Milvus Backup](https://github.com/zilliztech/milvus-backup)
- [Docker Compose 服务定义](https://docs.docker.com/reference/compose-file/services/)
