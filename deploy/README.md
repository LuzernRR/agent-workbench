# 部署与运维

`deploy/compose.yaml` 管理当前可交付的六个服务：Web、Search Agent、PostgreSQL、
Milvus、etcd 与 MinIO。Milvus 使用项目独立目录 `D:\001-agent\milvus`，不会读取、
停止、重建或删除既有 `D:\milvus` 实例和数据。

## 本地启动

前置条件：

- `config/agent-runtime.local.json`、`config/search.local.json` 与
  `config/deploy.local.env` 已按本地规范准备；
- `D:\001-agent\milvus` 是专用于本项目的新目录，包含 `etcd`、`minio`、`milvus`；
- 正式 Web 使用 `127.0.0.1:3100`，Search Agent 健康/调试端口使用
  `127.0.0.1:18100`，Milvus gRPC/健康端口使用 `127.0.0.1:29530/29091`。

只做静态解析且不输出插值后的密钥：

```powershell
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml config --quiet
```

启动本项目管理的服务：

```powershell
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml up -d --build
docker compose --env-file config/deploy.local.env -f deploy/compose.yaml ps
```

验证 Web、Search Agent 与项目 Milvus：

```powershell
Invoke-RestMethod http://127.0.0.1:3100/health
Invoke-RestMethod http://127.0.0.1:18100/health
Invoke-WebRequest http://127.0.0.1:29091/healthz -UseBasicParsing
```

Search Agent 的 `/health` 在 Milvus 不可达时返回 `degraded`，进程仍可执行不带
向量记忆的搜索。PostgreSQL 不可达时服务启动失败，这是有意的 fail-closed：
checkpoint 与搜索幂等账本不能在生产环境静默丢失。

## 配置与生产约束

- 非密钥默认值集中在 `config/search-agent.json`；密钥只保存在被忽略的
  `config/*.local.json` 或生产密钥管理系统中。镜像构建不会复制 `config/`。
- Compose 将 `config/` 只读挂载到 Web 与 Search Agent。生产环境必须设置随机的
  `POSTGRES_PASSWORD`、与其一致且密码已 URL 编码的
  `SEARCH_AGENT_DATABASE_URL`，以及 `WORKBENCH_INTERNAL_TOKEN`。
- `config/deploy.env.example` 只列变量名和非密钥占位值，不可作为生产密钥文件。
- Web、PostgreSQL、Search Agent 和 Milvus 的宿主机端口默认只绑定
  `127.0.0.1`；容器间只通过 `agent-backend` / `agent-milvus` 内部网络通信，
  不得直接暴露数据库、对象存储或 gRPC 端口到公网。
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
- Search Agent 发布失败：回滚上一镜像，保持 PostgreSQL schema 与 Milvus
  collection 不动；检查 checkpoint/工具账本后再恢复流量。
- 不要将 Milvus 2.6 的逻辑备份直接恢复到更低版本。需要降级 Milvus 时，启动
  隔离的兼容版本并使用升级前备份验证，原 2.6.21 实例保持不变直到验收完成。

参考：

- [Milvus Docker Compose 安装](https://milvus.io/docs/install_standalone-docker-compose.md)
- [Milvus Backup](https://github.com/zilliztech/milvus-backup)
- [Docker Compose 服务定义](https://docs.docker.com/reference/compose-file/services/)
