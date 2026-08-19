# DeepSeek Harness 平台（旁路控制面）

`platform/` 是多用户外壳。Upstream [deepseek-harness](../deepseek-harness) 仍是**单用户本地 Agent**（`dsh web`）。多人场景是「控制面 + 每用户一个 dsh 容器」，不要把 Harness 改成多租户单体。

本目录已完成**板块 A（基础设施）**、**板块 B（身份、会话与应用网关）**、**板块 C（运行时管理器）**、**板块 F（真正的 `dsh web`）**、**板块 D（登录用户读写自己的 workspace 文件）**、**板块 G（workspace/sites 打快照、子域名出静态站）**、**板块 H（已发布站的公网有限 JSON KV）**与**板块 I（对话里 Agent 调用 `publish_site` 打快照发布）**。没有插件市场、Admin 中台。

## 目录

```
platform/
  README.md
  .gitignore
  control-plane/         # /healthz、/auth/*、/me、/files、/sites；登录后 / 与 /api 反代该用户 dsh
  runtime-manager/       # 按用户 ensure/start/stop 隔离容器（仅 internal 调用）
  pages/src/             # 按 Host 出静态站 + /v1/kv；未知 Host → 404「No site」
  agent-bridge/          # Cordis 插件：模型工具 publish_site（装进 runtime 末层）
  deploy/
    docker-compose.yml
    Caddyfile
    Dockerfile.control
    Dockerfile.manager
    Dockerfile.pages     # Pages：只读快照静态站 + 公网 KV
    Dockerfile.runtime   # 多阶段：构建 deepseek-harness → 末层 COPY agent-bridge
    runtime/start.sh     # dsh web 127.0.0.1:3079 + socat 3080→3079
    Dockerfile.caddy     # 可选：带 DNS 模块，供服务器 DNS-01
    tls/internal.caddy   # 本机内部证书
    tls/dns.caddy        # 服务器通配证书（DNS-01）
    .env.example
```

以后会补上、本步不要写：`admin-web/`。插件市场与 Admin 中台仍未做。

## 架构约束

- 登录域（`APP_HOST`，如 `app.example.com`）与站点域（`*.PAGES_PARENT`，如 `*.pages.example.com`）拆开，避免用户页读到登录 cookie。
- Cookie `Domain` 只能是 `APP_HOST` 本身，**不要**写成父域（`.example.com`），否则会进 pages。
- 公网站点以后只服务**发布快照**，不挂直播工作区，不把用户容器端口映射到宿主机。
- **全局环境禁止 `DEEPSEEK_API_KEY`**（Compose、镜像、`.env`、用户容器 Env 都不设）。Key 以后只在该用户的 `DSH_HOME`。
- 用户容器：非 root（`USER node`）、`no-new-privileges`、不要 privileged、不要挂 `docker.sock`、不要 publish 宿主机端口。
- **`docker.sock` 只给 runtime-manager**（只读挂载即可）。用户容器与 control-plane 都不挂。
- postgres **只**在 `dsh-internal`（用户容器进不去库）。
- 用户容器 **只**在 `dsh-runtimes`，不进 `dsh-internal`。
- runtime-manager：`dsh-internal` + `dsh-runtimes`。
- control-plane：`dsh-internal`（postgres）+ `dsh-runtimes`（反代用户 3080）。Caddy 已在三张网；`APP_HOST` 仍整站反代 `control-plane:8080`。

## 宿主机数据目录（`DATA_ROOT` / `HOST_DATA_ROOT`）

Compose 卷可以用相对路径 `DATA_ROOT=./data`（相对 `platform/deploy`）。用户容器的 bind **源路径**必须是 Docker Engine 看到的**宿主机绝对路径** `HOST_DATA_ROOT`：manager 容器内的 `./data` 不能当 bind 源。

两者应指向同一目录：

| 环境 | `DATA_ROOT` | `HOST_DATA_ROOT` |
| --- | --- | --- |
| Linux 服务器 | `/data` | `/data` |
| Linux 检出目录 | `./data` 或绝对路径 | `/home/you/Deepseek_Harness/platform/deploy/data` |
| Windows（仅作配置示例） | `./data` | `C:/Deepseek_Harness/platform/deploy/data` |

| 路径 | 用途 |
| --- | --- |
| `{DATA_ROOT}/postgres` | Postgres 数据 |
| `{DATA_ROOT}/users/{id}/home` | 该用户 `DSH_HOME`（注册 mkdir；ensure 时 bind 到 `/data/home`） |
| `{DATA_ROOT}/users/{id}/workspace` | 该用户工作区（注册 mkdir；ensure 时 bind 到 `/data/workspace`） |
| `{DATA_ROOT}/snapshots` | 站点发布快照（板块 G） |
| `{DATA_ROOT}/caddy` | Caddy 证书与本地 CA |

## 本机启动

需要 Docker Compose，并占用宿主机 **80 / 443**。复制 `.env.example` 后**把 `HOST_DATA_ROOT` 改成这台机器上 `DATA_ROOT` 的绝对路径**。

```bat
cd platform\deploy
copy .env.example .env
docker compose up -d --build
```

```sh
cd platform/deploy
cp .env.example .env
# 编辑 .env：HOST_DATA_ROOT 必须是绝对路径
docker compose up -d --build
```

身份或 runtime-manager 改动后需重建镜像：

```sh
docker compose up -d --build
```

默认主机：

- 控制面：`https://app.localhost/healthz` → `ok`
- 登录 API：`https://app.localhost/auth/register`、`/auth/login`、`/me`
- 登录后 `/files`（workspace 上传/列表；**不是** dsh UI）
- 站点发布：登录后 `https://app.localhost/sites`（打快照；**不是** dsh UI）；Agent 也可调用 `publish_site`
- Agent UI：登录后打开 `https://app.localhost/`（或 `/runtime`）→ dsh Web，**不是** `dsh-runtime-skeleton`
- Pages：`https://pages.localhost/` → 404「No site」；已发布则 `https://{slug}.pages.localhost/` 出该快照

`*.localhost` 一般指向本机。若浏览器打不开，写入 hosts：

```
127.0.0.1 app.localhost pages.localhost demo.pages.localhost
```

本机 TLS 为 Caddy **内部 CA**（`TLS_MODE=internal`）。首次需在浏览器信任该证书，或导出根证：

```sh
docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt
```

只检查编排是否合法（不必 up；本机 Docker/WSL 起不来时用这条）：

```sh
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env.example config
```

语法检查（不必 Docker）：

```sh
node --check platform/control-plane/src/server.js
node --check platform/control-plane/src/files.js
node --check platform/control-plane/src/platform-token.js
node --check platform/control-plane/src/platform-auth.js
node --check platform/control-plane/src/sites.js
node --check platform/pages/src/server.js
node --check platform/pages/src/serve.js
node --check platform/pages/src/kv.js
node --check platform/runtime-manager/src/server.js
node --check platform/runtime-manager/src/runtimes.js
node --check platform/agent-bridge/index.js
node platform/scripts/h-kv-selftest.js
node platform/scripts/i-publish-selftest.js
```

## 服务器启动

1. 主机：Linux x86_64，Docker + Compose，放行 80/443。
2. 复制 `.env.example` 为 `.env`，改主机名，并把 `DATA_ROOT` 与 `HOST_DATA_ROOT` 都设成同一绝对路径（例如 `/data`）。
3. 通配证书必须走 DNS-01。构建带 DNS 模块的 Caddy，再切模式：

```sh
cd platform/deploy
docker build -t dsh-caddy:dns -f Dockerfile.caddy .
```

`.env`：

```
APP_HOST=app.example.com
PAGES_HOST=pages.example.com
PAGES_PARENT=pages.example.com
TLS_MODE=dns
CADDY_IMAGE=dsh-caddy:dns
ACME_EMAIL=admin@example.com
DNS_API_TOKEN=...
DATA_ROOT=/data
HOST_DATA_ROOT=/data
RUNTIME_MANAGER_TOKEN=change-me-runtime-manager-token
PLATFORM_TOKEN_SECRET=change-me-platform-token-secret
```

`Dockerfile.caddy` / `tls/dns.caddy` 默认示例是 Cloudflare。若区在阿里云 DNS 等，换成对应 `caddy-dns` 模块与令牌变量。DNS 令牌只给 Caddy，不要写进控制面。

```sh
docker compose up -d --build
```

## DNS 与证书

| 记录 | 值 |
| --- | --- |
| `APP_HOST` A/AAAA | 这台主机 |
| `PAGES_HOST` A/AAAA | 同一主机（或以后独立 Pages 机） |
| `*.PAGES_PARENT` CNAME 或 A | 同一主机 |

- 本机：`TLS_MODE=internal`，不必公网 DNS。
- 服务器：`*.pages.…` **必须** DNS-01（HTTP-01 签不了通配名）。
- 登录域与 pages 域保持兄弟关系（或不同注册域），不要把 App 放在 `example.com` 再把站点放在 `*.example.com`。

## 服务、端口、网络

Compose 项目名：`dsh-platform`。用户运行时**不要**写成长期 running 的 Compose 服务；`runtime-image` 只是 one-shot build（`command: true` 后退出），真正的用户容器由 runtime-manager 按需 `create/start`。

| 服务 | 容器名 | 监听 | 发布到宿主机 | 网络 |
| --- | --- | --- | --- | --- |
| caddy | `dsh-caddy` | 80, 443 | **80, 443** | `dsh-edge`, `dsh-internal`, `dsh-runtimes` |
| postgres | `dsh-postgres` | 5432 | 无 | **仅** `dsh-internal` |
| control-plane | `dsh-control-plane` | **8080** | 无 | `dsh-internal` + `dsh-runtimes` |
| pages | `dsh-pages` | **8080** | 无 | `dsh-internal` |
| runtime-manager | `dsh-runtime-manager` | **8080** | **无**（勿对公网暴露） | `dsh-internal` + `dsh-runtimes`；**唯此**可挂 docker.sock |
| 用户 dsh（按需） | `dsh-runtime-{userId}` | **3080** | **无** | **仅** `dsh-runtimes` |

Compose 网络键名 → Docker 网络名：

- `edge` → **`dsh-edge`**（公网入口）
- `internal` → **`dsh-internal`**（`internal: true`，无出网；postgres 与 manager/control-plane 互访）
- `runtimes` → **`dsh-runtimes`**（用户容器 + control-plane 反代 3080 + manager 探测 3080）

镜像：`dsh-runtime:web`（`Dockerfile.runtime` 多阶段构建，`EXPOSE 3080`）。容器内 `dsh web --host 127.0.0.1 --port 3079 --trusted-host $APP_HOST`，socat 把 `0.0.0.0:3080` 转到 3079（CLI 禁止 `--host 0.0.0.0`）。`DSH_HOME=/data/home`，`WORKDIR=/data/workspace`，`USER node`。**镜像内不设 `DEEPSEEK_API_KEY`**。

Caddy 的 `{$APP_HOST}` 整站反代 `control-plane:8080`；会话 Cookie 只写 `APP_HOST` 本身。pages 站点继续去掉 `Cookie` / `Set-Cookie`。

## 注册 / 登录（板块 B）

密码用 **scrypt**（不是明文或 md5）。会话是不透明 token，库里只存 `sha256(SESSION_SECRET + ":" + token)`。

| 路由 | 登录 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 否 | `200` 明文 `ok`（compose healthcheck） |
| `POST /auth/register` | 否 | `{ username, password, inviteCode }`；无邀请 → 400 |
| `POST /auth/login` | 否 | `{ username, password }` |
| `POST /auth/logout` | 是 | 删当前 session，清 Cookie |
| `GET /me` | 是 | 当前用户；无 Cookie → 401 |
| `GET /runtime/status` | 是 | JSON 运行时状态（不代理 UI） |
| `GET /`、`/api`、静态资源、WebSocket | 是 | ensure 后反代到该用户 dsh 的 `/`（**不**剥前缀；SPA 请求 `/api` 不是 `/runtime/api`） |
| `GET /runtime`、`/runtime/*` | 是 | 同上，但去掉 `/runtime` 前缀（别名） |
| `GET /files` | 是 | 极简上传/列表/删除页（控制面 HTML，不是 dsh UI） |
| `POST /files/upload`、`GET /files/list`、`DELETE /files`、`GET /files/download` | 是 | 只读写该用户 `workspace` |
| `GET /sites` | 是 | 极简发布/列表/回滚/下线页（控制面 HTML，不是 dsh UI） |
| `GET /sites/list`、`POST /sites/publish`、`POST /sites/rollback`、`POST /sites/takedown`、`POST /sites/token` | 是（Cookie）；`list`/`publish` 也可 Bearer `PLATFORM_USER_TOKEN` | 快照发布 / 轮换站点写令牌（明文只回一次） |
| 未登录 `GET /` | 否 | HTML 登录说明（401），不暴露 dsh |
| 未登录 `/files`、`/sites`、`/api` 或其他 | 否 | 401 JSON |

`APP_HOST` 上除 `/healthz`、`/auth/login`、`/auth/register` 外都要有效会话。

控制面**保留路径**（不会反代进 dsh）：`/healthz`、`/auth/*`、`/me`、`/runtime/status`、`/files`、`/files/*`、`/sites`、`/sites/*`。`/api` 仍是 dsh，不要占用。

`PLATFORM_USER_TOKEN` **不能**当 `dsh_session`，也不能调 `/auth`、`/files`、`/me` 或 `/sites` HTML / rollback / takedown / token；只开放 `POST /sites/publish` 与 `GET /sites/list`。过期作废。KV `writeToken` 调这些接口是 **401**。

### 引导邀请码

`users` 表为空时，控制面启动会插入一条一次性 invite，并打到 **control-plane 日志**：

```
bootstrap: users table is empty; one-time invite code: ...
```

也可在 `platform/deploy/.env`（不要写进 `DATA_ROOT`）设 `BOOTSTRAP_INVITE_CODE`，空库时用这个码。第一个注册成功的用户 `role=admin`，之后默认 `user`。本步没有「再发邀请」的 API；测第二个用户可：

```sh
docker compose exec postgres psql -U dsh -d dsh -c "INSERT INTO invites (code) VALUES ('second-invite');"
```

### Cookie

`Set-Cookie` 名：`dsh_session`。

- `Domain` = `APP_HOST` 本身（如 `app.localhost`），**禁止** `.example.com` / `.localhost` 父域
- `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`
- 只由 `{$APP_HOST}` 的控制面下发。Caddy 对 `{$PAGES_HOST}` 与 `*.{$PAGES_PARENT}` 已 `request_header -Cookie` 且 `header -Set-Cookie`，pages 域用不了这条会话

`SESSION_SECRET` 见 `.env.example`（占位，不要提交真实值）。换 secret 会使已有 session 全部失效。

### curl 示例（本机，内部 CA 用 `-k`）

```sh
cd platform/deploy

# 启动后读一次性邀请码
docker compose logs control-plane

# 无邀请：应 400 invite_required / invalid_invite
curl -sk -D - -H "content-type: application/json" \
  -d '{"username":"alice","password":"secret-pass"}' \
  https://app.localhost/auth/register

# 有邀请：201 + Set-Cookie
curl -sk -c cookies-a.txt -D - -H "content-type: application/json" \
  -d '{"username":"alice","password":"secret-pass","inviteCode":"PASTE_CODE"}' \
  https://app.localhost/auth/register

curl -sk -b cookies-a.txt https://app.localhost/me
```

Windows `cmd` 把 JSON 里的引号写成 `\"` 即可。

## 运行时管理器（板块 C）

登录用户访问 `/`、`/api` 或 `/runtime` 时，控制面用**当前会话的 `users.id`** 调 runtime-manager（不会从 URL 读别人的 id）：

1. `POST http://runtime-manager:8080/ensure` `{ "userId": "<当前用户 UUID>" }`（`Authorization: Bearer $RUNTIME_MANAGER_TOKEN`）
2. 反代到 `http://dsh-runtime-{userId}:3080`。根路径与 `/api` **不剥前缀**；`/runtime` 仍剥前缀当别名
3. 支持 HTTP Upgrade / WebSocket（`/api/events.mux`、`/api/events.host`）
4. 反代不转发 `Cookie` / `Authorization`，避免用户容器拿到会话 token
5. 发给 dsh 的 `Host` 是 `APP_HOST`（与 `--trusted-host` 一致），不是内部容器名

runtime-manager **不要对公网暴露端口**。Caddy 不反代它。Token 只在 `dsh-internal` 上 control-plane ↔ manager 使用。

用户容器：

| 项 | 值 |
| --- | --- |
| 名称 | `dsh-runtime-{userId}` |
| 镜像 | `dsh-runtime:web`（compose build `Dockerfile.runtime`） |
| 网络 | 仅 `dsh-runtimes` |
| 端口 | 容器内 3080（socat → 127.0.0.1:3079）；**无** Ports 映射到宿主机 |
| bind | `{HOST_DATA_ROOT}/users/{userId}/home` → `/data/home` ；`workspace` → `/data/workspace` |
| 环境 | `APP_HOST`、`DSH_TRUST_GATEWAY=1`、`DSH_HOME=/data/home`、`PLATFORM_URL=http://control-plane:8080`、`PLATFORM_TOKEN`（短时 HMAC）；**不**注入 `DEEPSEEK_API_KEY`、**不**注入 `SESSION_SECRET` |
| 安全 | `USER node`、`no-new-privileges`、非 privileged、不挂 sock |
| 限额 | 默认内存 `1g`、CPU `1.0`（`RUNTIME_MEMORY` / `RUNTIME_CPUS`） |
| 全机上限 | `MAX_RUNTIMES`（默认 **2**，4C/8G）个 **running** 容器；超限 ensure 返回 **429** `too_many_runtimes` |
| 就绪 | `RUNTIME_READY_TIMEOUT_MS` 默认 **120000**（dsh 冷启动可能 >30s） |

### ensure / 空闲回收

- 无容器：`docker create` + `start`，等到 3080 可连再 200 `{ name, status }`
- 已有已停：`start`（不 rm）
- 已在跑：直接等 3080 可连
- **空闲回收**：该用户容器 3080 上无 **ESTABLISHED** TCP 超过 `IDLE_SECONDS`（默认 900）则 `stop`，**不要 rm**。下次 `/runtime` 再 ensure/start
- `GET /runtime/status` **不** ensure、**不**代理占位页，返回 JSON，便于看 `running` / `exited` / `missing`

### curl /runtime

未登录应为 401，不再是 503 `runtime_not_ready`：

```sh
curl -sk -D - https://app.localhost/runtime
# HTTP/1.1 401
# {"error":"unauthenticated"}
```

登录后打开根路径应是 dsh Web UI（HTML），不是 `dsh-runtime-skeleton` 纯文本：

```sh
curl -sk -b cookies-a.txt https://app.localhost/me
# 记下 id

curl -sk -b cookies-a.txt https://app.localhost/runtime/status
# {"name":"dsh-runtime-<id>","status":"missing"|"exited"|"running",...}

curl -sk -b cookies-a.txt -D - https://app.localhost/
# HTML：dsh Web（含 <!DOCTYPE 或 script /assets），不是 dsh-runtime-skeleton

curl -sk -b cookies-a.txt https://app.localhost/runtime
# 同上（/runtime 别名）
```

未登录不能进别人的 Agent：

```sh
curl -sk -D - https://app.localhost/
# 401 HTML 登录说明

curl -sk -D - https://app.localhost/api
# HTTP/1.1 401
# {"error":"unauthenticated"}
```

用户 A 的 cookie 打不到用户 B 的容器：主机名永远来自会话里的 id，URL 不能指定别人的 runtime。用 B 的 cookie 打 `/runtime` 只会 ensure `dsh-runtime-{B}`。

内部调用 manager（不要映射到宿主机）：

```sh
docker compose exec control-plane node -e "fetch('http://runtime-manager:8080/healthz').then(r=>r.text()).then(console.log)"
```

## Agent UI 与自己的 Key（板块 F）

1. 注册/登录（Cookie `dsh_session`）。
2. 浏览器打开 `https://$APP_HOST/`（或 `/runtime`）。应看到 dsh Web，不是纯文本占位。
3. 打开 **Models**，填写该用户自己的 DeepSeek API Key。配置写到该用户卷 `$DSH_HOME/.credentials.yaml`（即 `{DATA_ROOT}/users/{id}/home/.credentials.yaml`）。
4. 平台补丁：容器环境 `DSH_TRUST_GATEWAY=1` 且请求 `Host` 已在 `--trusted-host $APP_HOST` 时，settings/credentials 不再要求 loopback。`host.pickDirectory` / `host.openPath` 仍锁 loopback。测法：`packages/client/connection/tests/node-half.host.spec.ts` 中 `lets a gateway-trusted Host reach settings/credentials but not native desktop methods`。
5. 若 Models 仍写不了 Key，可临时把 Key 写入该用户 `home/.credentials.yaml`（不要写进 Compose / 镜像 / 全局 `.env`）。

目录选择走 **browse**（容器无 DISPLAY / 设了 `SSH_CONNECTION=gateway`），工作区根是 `/data/workspace`。不要组装 native 桌面能力。

## 自己的 workspace 文件（板块 D）

登录后通过控制面 `/files` 读写**当前会话用户**的 `{USERS_ROOT}/{userId}/workspace/...`（默认 `USERS_ROOT=/data/users`）。**不要**写 `home`（`home/.credentials.yaml` 是 Key）。客户端只传相对 workspace 的 **posix 相对路径**；服务端不接受任意绝对 path。

| 路由 | 说明 |
| --- | --- |
| `GET /files` | 登录后极简 HTML：选文件上传、列一层、删除。未登录 **401** |
| `POST /files/upload` | multipart 字段 `file` + 可选 `destDir`（相对路径，默认 `.`） |
| `GET /files/list?path=` | 列一层：`name`、`type`（`dir`/`file`）、`size`；`path` 默认 `.` |
| `DELETE /files?path=` | 删文件或空目录。非空目录默认 **409** `directory_not_empty`；要递归删则 `recursive=1` |
| `GET /files/download?path=` | 只下载自己的普通文件（`lstat` 为 file，不跟 symlink） |

`/files` 与 `/files/*` 已加入 `isReservedControlPath`。未登录一律 401，**不会**进 dsh。根路径 `/` 仍反代该用户 dsh。

### 安全规则

- 路径禁止 `..`、绝对路径（`/` 开头）、盘符（`C:`）、反斜杠、`://`。此类请求 **400** `invalid_path`，不会去读 Key 文件。
- 落盘前 `realpath` 必须仍在该用户 `workspace` 下（防 symlink 逃到 `home` 或其他用户）。
- 用户 id 只来自会话 Cookie，不从 URL 指定。A 的 cookie 打 list/download 只会看到 A 的 workspace，打不到 B。
- 单文件默认 **20MB**（`FILE_MAX_BYTES`），整户 workspace 默认 **500MB**（`FILE_QUOTA_BYTES`）。超限 **413**（`payload_too_large` / `quota_exceeded`）。
- 不新建用户容器，不改 runtime-manager。

### curl 示例

```sh
# 未登录：401
curl -sk -D - https://app.localhost/files
curl -sk -D - -X POST https://app.localhost/files/upload
# HTTP/1.1 401
# {"error":"unauthenticated"}

# 登录后上传到 workspace 根（destDir 默认 .）
curl -sk -b cookies-a.txt -F "file=@./hello.txt" -F "destDir=." \
  https://app.localhost/files/upload
# 201 {"ok":true,"path":"hello.txt","size":...}

curl -sk -b cookies-a.txt https://app.localhost/files/list
# {"path":".","entries":[{"name":"hello.txt","type":"file","size":...}]}

# 文件在该用户卷：{DATA_ROOT}/users/{aliceId}/workspace/hello.txt

# 逃出 workspace：400，且不会读到 home/.credentials.yaml
curl -sk -b cookies-a.txt -D - \
  "https://app.localhost/files/list?path=../home/.credentials.yaml"
curl -sk -b cookies-a.txt -D - \
  "https://app.localhost/files/download?path=/etc/passwd"
# HTTP/1.1 400
# {"error":"invalid_path"}

# A 的 cookie 打不到 B 的文件（主机路径只绑会话 userId）
curl -sk -b cookies-a.txt https://app.localhost/files/list
# 只有 A 的 workspace 条目，不会出现 B 的文件

# 删除；非空目录需 recursive=1
curl -sk -b cookies-a.txt -X DELETE "https://app.localhost/files?path=hello.txt"
curl -sk -b cookies-a.txt -X DELETE "https://app.localhost/files?path=sites&recursive=1"

# / 仍是 dsh；/files 是控制面页
curl -sk -b cookies-a.txt -D - https://app.localhost/files
# HTML：Workspace 文件
curl -sk -b cookies-a.txt -D - https://app.localhost/
# dsh Web（不是 /files 页）
```

## 发布静态站（板块 G）

登录后通过控制面 `/sites` 把**当前用户**的 `{USERS_ROOT}/{id}/workspace/sites/<name>` 打成不可变快照，写到 `{DATA_ROOT}/snapshots/{siteId}/{version}/`。pages 只读挂 snapshots，**不挂 users**，**不服务直播 workspace**。

典型流程：先在 `/files` 上传 `sites/demo/index.html`，再在 `/sites` 发布，用 `https://{slug}.{PAGES_PARENT}/` 打开。

| 路由 | 说明 |
| --- | --- |
| `GET /sites` | 登录后极简 HTML：填相对路径（如 `sites/demo`）、可选 slug、发布、列表、回滚、下线。未登录 **401** |
| `GET /sites/list` | JSON：当前用户的站 |
| `POST /sites/publish` | JSON `{ dir, slug? }` → 打快照、切 `current_version`、`status=live`，返回公网 URL |
| `POST /sites/rollback` | JSON `{ siteId, version }` → 切回已有版本并 live |
| `POST /sites/takedown` | JSON `{ siteId }`：自己的站；`users.role=admin` 可下线任意站 |
| `POST /sites/token` | JSON `{ siteId }`：轮换写令牌（站主或 admin）；明文只回一次 |

`/sites` 与 `/sites/*` 已加入 `isReservedControlPath`。未登录一律 401，**不会**进 dsh。根路径 `/` 仍反代该用户 dsh。不要占 `/api`。公网 KV 在站点域，不在 `APP_HOST`。

默认 slug：`{username}-{name}`（小写，`_` → `-`）。格式 `[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?`，全局唯一。保留：`www` `api` `admin` `login` `app` `static` `pages`。

必须有根目录 `index.html`。拒绝打包 `.env`、`.credentials.yaml`、`*.pem`、`*.key`。整站默认 ≤ **20MB**（`SITE_MAX_BYTES`）。保留最近 **5** 版（外加当前版）。

pages 按 `Host` 解析 slug（`foo.pages.localhost` → `foo`）。`PAGES_HOST` 本身仍 404「No site」。`live` 只出该版本目录里的常见静态 Content-Type；`taken_down` 统一下线页；未知 Host →「No site」。响应带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`X-Content-Origin: user-generated`。不执行用户 JS 当后端。Caddy 已对 pages 域剥 Cookie；APP 会话不会带到用户站。pages **不会** `Set-Cookie`。同一 Host 上提供有限 JSON KV（见下节）。

### curl 示例

```sh
# 未登录：401
curl -sk -D - https://app.localhost/sites
# HTTP/1.1 401
# {"error":"unauthenticated"}

# 1) /files 上传站点源（destDir=sites/demo）
curl -sk -b cookies-a.txt -F "file=@./index.html" -F "destDir=sites/demo" \
  https://app.localhost/files/upload
# 201 {"ok":true,"path":"sites/demo/index.html",...}

# 2) /sites 发布（slug 可省略，默认 {username}-demo）
curl -sk -b cookies-a.txt -H "content-type: application/json" \
  -d '{"dir":"sites/demo"}' \
  https://app.localhost/sites/publish
# {"ok":true,"slug":"alice-demo","url":"https://alice-demo.pages.localhost/",...}

# 3) 用子域名打开快照（需要 hosts：127.0.0.1 alice-demo.pages.localhost）
curl -sk -D - https://alice-demo.pages.localhost/
# 快照里的 HTML；响应无 Set-Cookie

# 改直播 workspace 不影响已发布快照
curl -sk -b cookies-a.txt -F "file=@./index.html" -F "destDir=sites/demo" \
  https://app.localhost/files/upload
# pages 仍是发布时的 HTML，直到再次 publish

# 拒绝逃出 workspace / 打包密钥
curl -sk -b cookies-a.txt -H "content-type: application/json" \
  -d '{"dir":"../home"}' https://app.localhost/sites/publish
# HTTP/1.1 400  {"error":"invalid_path"}

# 源目录里若有 .env → 400 forbidden_file

# A 不能下线 B 的站
curl -sk -b cookies-a.txt -H "content-type: application/json" \
  -d '{"siteId":"<B-site-uuid>"}' https://app.localhost/sites/takedown
# HTTP/1.1 404

# / 仍是 dsh；/sites 是控制面页
curl -sk -b cookies-a.txt -D - https://app.localhost/sites
# HTML：发布静态站
curl -sk -b cookies-a.txt -D - https://app.localhost/
# dsh Web（不是 /sites 页）
```

## 公网站点 KV（板块 H）

已发布站（`sites.id`，`status=live`）有一份**有限 JSON KV**，够计数器 / 留言。绑站点 id，不绑目录路径，也不绑直播 workspace。

**读写只走 pages 域**，不走 `APP_HOST`。静态页用同源：

```js
fetch('/v1/kv/count')
fetch('/v1/kv/count',{method:'PUT',headers:{Authorization:'Bearer …','content-type':'application/json'},body:'1'})
```

这样带不上 app 的登录 Cookie。Caddy 继续剥 pages 的 `Cookie` / `Set-Cookie`。app Cookie **不能**当写令牌；写令牌也换不了用户 JWT。

| 路由 | 登录 | 说明 |
| --- | --- | --- |
| `GET /v1/kv/:key`（站点 Host） | 否 | 匿名读；无 key → 404；`taken_down` / 非 live → 404 |
| `PUT /v1/kv/:key`（站点 Host） | 站点写令牌 | `Authorization: Bearer <site_write_token>`，body 必须是 JSON |
| `POST /sites/token`（`APP_HOST`） | 是 | `{ siteId }` 轮换；仅站主或 admin；明文 token **只回一次** |
| `GET /sites/list` | 是 | 只含 `hasWriteToken`，不回明文 |

首次发布若还没有令牌，会生成并在 `POST /sites/publish` 响应里带一次 `writeToken`。之后列表只显示是否已签发。

约束：

- 无 LIST、无前缀扫描。key：`^[A-Za-z0-9._-]{1,64}$`
- value 必须是 JSON（数字 / 对象 / 数组都可）；单 key ≤ **64KB**（超限 **400**）；整站 ≤ **1MB**（超限 **413** `quota_exceeded`）
- 写入限速默认每站 **30 次/分钟**（`KV_WRITE_PER_MINUTE`），超限 **429**
- 无令牌 / 错令牌 PUT → **401**。A 站令牌打 B 站 Host → **401**
- CORS：若有 `Origin`，只允许该站 `https://{slug}.{PAGES_PARENT}`。同源请求即可
- pages 注入 `POSTGRES_*`（第一期与控制面共用 `dsh` 角色）。**不要**把 `SESSION_SECRET` 给 pages；写令牌是 `sha256(token)`，与 session 哈希分开
- 控制面只做令牌管理（`/sites/*`），app 域不提供匿名写，也不占 `/api`

### curl 示例（KV）

```sh
# 未登录打 APP 令牌接口 → 401（与其它 /sites/* 同一会话闸）
curl -sk -D - -X POST -H "content-type: application/json" \
  -d '{"siteId":"00000000-0000-0000-0000-000000000000"}' \
  https://app.localhost/sites/token
# HTTP/1.1 401
# {"error":"unauthenticated"}

# 登录后轮换（明文只这一次）
curl -sk -b cookies-a.txt -H "content-type: application/json" \
  -d '{"siteId":"<site-uuid>"}' \
  https://app.localhost/sites/token
# {"ok":true,"siteId":"...","writeToken":"..."}

# 匿名读（live 站；无此 key → 404）
curl -sk -D - https://alice-demo.pages.localhost/v1/kv/count

# 无令牌 / 错令牌写 → 401
curl -sk -D - -X PUT -H "content-type: application/json" -d "1" \
  https://alice-demo.pages.localhost/v1/kv/count
curl -sk -D - -X PUT -H "authorization: Bearer wrong" \
  -H "content-type: application/json" -d "1" \
  https://alice-demo.pages.localhost/v1/kv/count

# 对的令牌写再读
curl -sk -X PUT -H "authorization: Bearer PASTE_WRITE_TOKEN" \
  -H "content-type: application/json" -d "1" \
  https://alice-demo.pages.localhost/v1/kv/count
curl -sk https://alice-demo.pages.localhost/v1/kv/count
# 1

# A 的令牌写不了 B（Host 是 B 的 slug）→ 401
# 超大 value / 非法 key → 400；超配额 → 413；限速 → 429
# pages 响应无 Set-Cookie
```

进程内验收（无 Docker / 无库）：

```sh
node platform/scripts/h-kv-selftest.js
```

## Agent 发布（板块 I）

`/sites` 网页继续能用。I 多一条 **Agent 通道**：对话里模型可调用 `publish_site({ dir, slug? })`，把**当前用户**的 `workspace/sites/<name>` 打成与 G 相同的快照（仍不绑直播 workspace）。工具**不占 `/api`**。

用户容器没有 `dsh_session`（反代仍不转发 Cookie / Authorization）。KV `writeToken` 不是身份，也不能换 JWT。因此 runtime-manager 在 **ensure/create** 时为该 `userId` 签发短时 **`PLATFORM_USER_TOKEN`**：

- HMAC-SHA256，密钥 **`PLATFORM_TOKEN_SECRET`**（不要复用 `SESSION_SECRET`，不要用 KV write token）
- 形态 `dshput.v1.<payload>.<sig>`，payload 含 `sub`（userId）与 `exp`
- 默认 TTL **12 小时**（`PLATFORM_TOKEN_TTL_SECONDS`，最短 60s）。每次 ensure 换新并写入 `$DSH_HOME/.platform-token`（mode **0600**）
- 注入用户容器：`PLATFORM_TOKEN`、`PLATFORM_URL=http://control-plane:8080`（控制面已在 `dsh-runtimes`）
- 控制面 `POST /sites/publish` 与 `GET /sites/list` 除 Cookie 外接受 `Authorization: Bearer <PLATFORM_USER_TOKEN>`，只能发布/列出该 token 绑定的 userId
- token **不能**当登录 Cookie，不能调 `/auth`、`/files`、`/me`、rollback/takedown/token；过期作废
- 缺 token 从容器打 publish → **401**；KV writeToken 打 `/sites/publish` → **401**

插件：`platform/agent-bridge`（Cordis），注册 `publish_site`。描述写明：**仅当用户明确要求发布网站时使用**；若组合里有 approval，发布前要人点同意。成功则把公网 URL 和（若响应里有一次性 `writeToken`）写进工具结果。

装进运行时：`Dockerfile.runtime` **末层 COPY** 到 `/opt/dsh-platform/agent-bridge`（不要为了改插件重编整个 monorepo）。ensure 时若用户 home **没有** `cordis.patch.yml` 则写入一行加载该插件；**已有用户 patch 不覆盖**。

### 8G 机器与镜像构建

4C/8G 生产机：`.env.example` 默认 `MAX_RUNTIMES=2`、`RUNTIME_MEMORY=1g`。现场 `pnpm build` 容易 OOM。`Dockerfile.runtime` 是多阶段：构建阶段编译 monorepo，运行镜像只含已构建产物 + socat，**最后一层**才 COPY `agent-bridge`。

只改插件 / 末层时，让 Docker 命中前面的 build 缓存：

```sh
cd platform/deploy
docker compose build runtime-image
# 应复用 pnpm 构建层，只重建末层 COPY
docker compose up -d
# 已有用户容器仍是旧镜像时删掉，下次打开 APP 会 ensure 再创建
docker rm -f dsh-runtime-<userId>
```

缺 `PLATFORM_URL` / `PLATFORM_TOKEN` 的旧容器，ensure 会 **force rm** 再创建（home/workspace bind 还在）。

第一次从零构建，或改了 `deepseek-harness/`，仍可能要在更强机器上 build 再 `docker save` / `load`：

```sh
# 更强机器
cd platform/deploy
docker compose build runtime-image
docker save dsh-runtime:web -o dsh-runtime-web.tar

# 生产机
docker load -i dsh-runtime-web.tar
```

然后 `docker compose up -d`（runtime-image 的 `pull_policy: never` 会用已 load 的标签）。

从板块 C 的 `dsh-runtime:skeleton` 升级时，ensure 会 **force rm** 缺少 `APP_HOST` / `DSH_TRUST_GATEWAY=1` 的旧容器再创建。也可手动 `docker rm -f dsh-runtime-<id>`。

### 1Panel / 双占 80/443

若主机已用 1Panel（或其它面板）占了 **80/443**，不要再和本仓库 Caddy 同时 bind。本步不拆 Caddy；可先停面板的网站反代，或以后再把 Caddy 换成面板证书。记下即可。

用 1Panel 代替本仓库 Caddy 时：`APP_HOST` 反代到 `control-plane:8080`；`PAGES_HOST` 与通配 **`*.pages`（即 `*.PAGES_PARENT`）** 反代到 **`pages:8080`**。不要把 pages 或用户容器的端口 publish 到宿主机。pages 域不要转发 Cookie。

### 验收（Docker 可用时）

```sh
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env.example config
```

- 登录后打开 `APP_HOST` 根路径（或 `/runtime`）是 **dsh Web UI**，不是 `dsh-runtime-skeleton` 纯文本
- 未登录打 `/` 或 `/api` **不能**进别人的 Agent（401 HTML 或 JSON）
- 未登录 `/sites` → **401**；`/` 仍是 dsh，`/sites` 不进 dsh
- 登录后发布含 `index.html` 的 `sites/demo`，pages 按 Host 读快照 HTML；改 workspace 不影响已发布快照
- 发布 `../home` 或源里混进 `.env` → **400**；A 不能发布/下线 B 的站；pages 响应无 `Set-Cookie`
- 未登录 `POST /sites/token` → **401**；live 站匿名 `GET /v1/kv/count` 可读（无则 404）；无/错令牌 PUT → 401；对的令牌 PUT 再 GET 能读到；A 令牌写不了 B；非法 key / 超大 value → 400；超配额 / 限速 → 413 / 429
- Cookie 发布仍可用；Bearer `PLATFORM_USER_TOKEN`（用户 A）只能发 A 的 `sites/`，不能发 B；KV `writeToken` 调 `/sites/publish` → **401**；无 token 从容器逻辑上 **401**
- `publish_site` 是 Agent 工具，不出现在 `/api` 占用冲突
- A/B 会话仍隔离：主机名来自会话 id
- 用户容器无宿主机 Ports：`docker inspect dsh-runtime-<id> --format "{{json .HostConfig.PortBindings}}"` → `{}` 或 `null`
- 无全局 `DEEPSEEK_API_KEY`（Compose / 镜像 / 用户容器 Env）
- 用户能在自己的 UI 里配置 Key（补丁生效），或把 Key 写入该用户 `home/.credentials.yaml`

服务器上（本机无 Docker 时把下面当现场测法）：

```sh
# 登录后
curl -sk -b cookies-a.txt -D - https://$APP_HOST/
# 应含 HTML / dsh 前端，不是 dsh-runtime-skeleton

docker inspect dsh-runtime-<id> --format "{{json .Config.Env}}"
# 有 APP_HOST、DSH_TRUST_GATEWAY=1、DSH_HOME、PLATFORM_URL、PLATFORM_TOKEN；没有 DEEPSEEK_API_KEY

docker inspect dsh-runtime-<id> --format "{{json .HostConfig.PortBindings}}"
# {} 或 null
```

本机 Docker/WSL 不可用时，至少：

```sh
node --check platform/control-plane/src/server.js
node --check platform/control-plane/src/files.js
node --check platform/control-plane/src/sites.js
node --check platform/control-plane/src/platform-token.js
node --check platform/control-plane/src/platform-auth.js
node --check platform/control-plane/src/runtime.js
node --check platform/pages/src/server.js
node --check platform/pages/src/serve.js
node --check platform/pages/src/kv.js
node --check platform/runtime-manager/src/server.js
node --check platform/runtime-manager/src/runtimes.js
node --check platform/agent-bridge/index.js
node platform/scripts/h-kv-selftest.js
node platform/scripts/i-publish-selftest.js
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env.example config
```
