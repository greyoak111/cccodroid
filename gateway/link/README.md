# linkd —— 手机 ↔ 电脑设备互联

一个不引第三方包的小服务，跑在 cccodroid 旁边，把两边的 Claude Code 会话（`.claude/projects/*.jsonl`）对齐。

同一局域网直接配对；跨网络用 `../relay/relay.mjs` 做公网中转（HTTPS、只需出站），
设备端在「公网中转」里填地址和令牌即可，不用配对码。详见 [`../relay/README.md`](../relay/README.md)。

## 端口

| 端口 | 绑定 | 用途 |
|---|---|---|
| 9377 | 127.0.0.1 | 管理页面 + 本机接口，用 cccodroid 网关的令牌鉴权 |
| 9378 | 0.0.0.0 | 已配对设备之间传会话，每台设备一份 32 字节密钥 |
| 9379/UDP | 0.0.0.0 | 局域网广播发现（只在开启互联时） |

端口可以用 `--local-port` / `--lan-port` / `--udp-port` 改；手机和电脑的默认值相同。

## 启动

```sh
node linkd.mjs --home <数据目录> --workspace <工作区> --gateway-port 8792 [--name 电脑名]
```

- Windows：`shell/main.mjs` 在网关就绪后拉起 linkd，应用退出时一起结束；设置 → 设备互联 → 打开。
- 安卓：linkd 放在 `<应用 files>/home/.cccodroid/link/`，`server.mjs` 在网关启动时拉起（detached，网关重启不打断同步）；设置 → 设备互联 → 打开。

linkd 会读 `<home>/.gateway-token` 作为本机令牌；管理页地址是 `http://127.0.0.1:9377/?t=<令牌>`。也可以接受网关种的 `cc_t_<端口>` Cookie（Cookie 不按端口隔离）。

## 配对

1. A 点「生成配对码」，得到 6 位码，10 分钟有效，连续输错 5 次作废。
2. B 在「配对另一台设备」里填 A 的局域网地址（默认 9378）和码，或从「附近发现」里选 A。
3. B → `POST http://A:9378/api/pair`，A 校验码后生成密钥返回；两边各存一份。
4. 之后所有 `/api/peer/*` 都带 `Authorization: Bearer <密钥>`。

配对码接口只接受局域网私有地址（10/8、172.16/12、192.168/16、169.254、fc00::/7、fe80::/10），每个 IP 每分钟最多 12 次。UDP 发现只广播设备名 / id / 端口。

## 公网中转

两台设备不在一个网络、或者不想开局域网时，用一台双方都能访问的服务器跑 `relay.mjs`：

1. 服务器上按 [`../relay/README.md`](../relay/README.md) 部署，拿到中转地址（HTTPS）和 64 位令牌。
2. 手机 / 电脑：设置 → 设备互联 → 公网中转，填地址和令牌，保存即可。
3. 中转被当成一个假 peer（`relay-<hash>`）：清单、zip、名称 / 置顶、回收站都走 `/api/peer/*`，和设备间同步同一套规则。
4. 局域网关掉也能同步；两端不需要同时在线，也不需要公网 IP。
5. 中转不解压、不认来源：会话包里的 `origin` 照旧保留，所以拉下来的会话仍会标「手机 / 电脑」。

**局域网优先**：配了中转也不代表每次都走它。只要有一个已配对设备在局域网里在线（30 秒内见过），
自动同步就只走局域网；等它掉线才回退到中转，恢复后自动切回来。手动「全部同步」例外，两条路都会对齐。

**长轮询**：中转服务器提供 `GET /api/relay/events?since=<rev>&wait=25`。linkd 常驻一个 25 秒的请求，
服务器上一旦有会话或任务变化就立刻返回，随后马上同步 / 取任务；没有变化就等超时再重新挂上。
正常的中转链路延迟在 1 秒以内。老服务器没有这个接口（404）时自动退回 5 秒轮询。

`POST /api/relay` 保存配置（`{url,token,name,enabled}`），`POST /api/relay/test` 只探活，
`POST /api/relay/off` 临时停用。令牌只存在本机状态文件里，`/api/status` 不会回显。

## 远程执行（把任务派到另一台设备）

会话默认在打开它的设备上执行。远程执行让模型在**任务必须依赖另一台设备的环境**时，
把那一段任务交给对端跑一次 headless Claude，再把最终文本拿回来：

- 电脑派手机：抖音 / 抖音商城 / 小红书 / 安卓 App、读屏点按、手机通知 / 登录态。
- 手机派电脑：Windows 编译、winget / Visual Studio、桌面程序。

对端由 `linkd` 用 `remote-exec.mjs` 拉起一次性 claude（`--no-session-persistence`，
不写会话），执行器复用网关自己的厂商 / 密钥 / 模型 / shell 配置。安卓上还会挂
`app/bin/device-mcp.mjs`（设备工具 MCP），所以读屏点击这类操作也能做。

**开关与权限**：互联页「远程执行」默认关闭。打开后还要逐台设备「放行」；放行等于允许
对方在本机运行任意命令（包括读写文件），只在自己的设备之间开。任务和结果以明文存在
`<home>/.cccodroid/link/remote/`，保留 7 天 / 最近 60 条。

**Claude 工具**（`remote-mcp.mjs`，MCP stdio）：`remote_devices` / `remote_task` /
`remote_result` / `remote_cancel` / `remote_history`。MCP 配置：

```json
"ccapp-remote": {
  "command": "<node>",
  "args": ["<link>/remote-mcp.mjs"],
  "env": {
    "CCAPP_LINKD": "http://127.0.0.1:9377",
    "CCAPP_GW_TOKEN_FILE": "<home>/.gateway-token"
  }
}
```

**传输**：局域网直接 POST `/api/peer/task`；跨网络走中转的 `/api/relay/task` 信箱，
目标设备靠中转长轮询收到 `task` 事件后立即取件（兜底仍每 5 秒扫一次）。发起方轮询结果，
长任务用 `remote_result` 等。任务上限：
提示 64 KB、结果 512 KB、默认 600 秒（最大 3600 秒）、默认 40 轮。

**实时事件流**：`remote-exec.mjs` 把 Claude 的输出拆成结构化事件（`delta` 文本增量、
`thinking`、`tool_use`、`tool_result`，以及兜底的 `text`），随任务一路带回去：局域网对端
把事件存进任务文件，中转把事件合并进信箱记录，发起方用
`GET /api/remote/task/<id>/events?since=<seq>&wait=20` 长轮询取。事件有递增序号、上限
2000 条 / 单条文本 16 KB，任务结束后仍可取到完整一轮。网关据此把对端的执行过程画进当前
会话（`@shouji-…` / `@diannao-…` 点名时用，见 README-Windows）；普通 MCP 调用只拿最终文本。

**点名轮次（@手机 / @电脑）与会话**：这类任务会带上调用方的 `sessionId`、`text`（用户原话）
和 `context`。目标设备在本机找到同步过来的同名会话时，`remote-exec.mjs` 用
`claude -p --resume <sid>` 接着这个会话跑（不再是 `--no-session-persistence` 的一次性任务）：
对端因此读得到完整上下文，回复直接写进 transcript，再由 linkd 的普通会话同步回到调用方；
两端的会话记录因此保持一致。找不到该会话（新会话、还没同步）时退回一次性任务，把
`context` 拼在提示后面。`remote_task`（Claude 自己派活）不带这些字段，行为不变。

**执行端即本体**：续跑的这一轮不再由 linkd 拉起一次性进程，而是 linkd 调本机网关的
`POST /api/chat`（带 `sessionId` 和用户原话）真正起一轮 —— 和执行端自己打字发出去的一样：
写进 transcript、界面里有气泡和执行过程、可以插话、可以通过界面按钮停止。linkd 先订阅网关的
`GET /api/events`，再发消息，按下发回来的 `runId` 过滤事件、回传给调用方；调用方只做镜像。
找不到本机会话（还没同步 / 新会话）或会话 20 秒内还在写时，仍退回 `remote-exec.mjs` 的一次性任务：
不写 transcript、只回传文本，调用方也不能对它插话。

**插话**：调用方在远程轮次进行中再发一条消息时，必须以 `@手机` / `@电脑` 开头（网关的
`/api/chat` 会拦下不带 @ 的消息并提示）。带 @ 的正文经 `/api/remote/inject` → 对端
`/api/peer/task/<id>/inject`（中转是信箱里的一封 `kind:"control"` 控制消息）投给执行端网关的
`/api/chat`（`mode:"inject"`），直接写进正在跑的 claude 的 stdin。

**停止**：调用方点停止 → 任务取消 → 对端 linkd 调 `/api/abort {id}` 停掉真正在跑的那一轮；
执行端这边点停止 → 网关发 `run_end`（aborted）→ linkd 把任务标成 `cancelled` → 调用方的镜像
轮次跟着结束。两端看到的是同一轮。

**安全**：`remote` 配置默认关闭；局域网来源靠配对密钥，中转来源靠共享令牌 + 来源设备 id
放行。中转令牌泄露的影响也包括远程执行，按同一级别保护。执行器默认 `bypassPermissions`，
这是「无人值守」的代价；不用的设备请保持关闭 / 不放行。

接口速查（本机，需 `x-link-token`）：

```
GET  /api/remote                  开关、放行表、目标设备、最近任务
POST /api/remote/config           {"enabled","allow":{"<设备id>":"auto"|false},"maxRunning"}
POST /api/remote/task             {"device","prompt","cwd?","timeout?","maxTurns?","wait?"}
GET  /api/remote/task/<id>
GET  /api/remote/task/<id>/events?since=&wait=   长轮询实时事件流（≤30 秒）
GET  /api/remote/tasks?limit=
POST /api/remote/cancel           {"id"}
POST /api/remote/inject           {"id","text"}            远程轮次进行中插话
POST /api/remote/fetch            {"path"}                 本机缺的工作区文件，向局域网对端要一份
POST /api/remote/mirror           {"op":"start|event|end","id","sessionId","text","ev"}(linkd 内部用)
```

局域网（Bearer 配对密钥）：

```
POST /api/peer/task               {"task":{…},"from":{…}}
GET  /api/peer/task/<id>          带 ?since= 时同时返回该任务的事件
POST /api/peer/task/<id>/cancel
POST /api/peer/task/<id>/inject   {"text"}                 插进对端正跑的这一轮
GET  /api/peer/file?rel=<工作区相对路径>                    按需取产物（只读、≤32 MB）
```

中转（Bearer 令牌）：`POST /api/relay/device`、`GET /api/relay/devices`、
`POST /api/relay/task`、`GET /api/relay/tasks?to=&status=`、`GET /api/relay/task/<id>`、
`POST /api/relay/task/<id>/claim|/cancel`。

## 同步规则

- 清单：`GET /api/peer/manifest` 返回本机所有会话的 `{id,title,cwd,mtime,size,pinned}`、名字 / 置顶表、回收站 id 列表、工作区路径。没有内容，只有元数据。
- 单会话：`GET /api/peer/session/<id>` 返回 zip（`manifest.json` + `session.jsonl` + `sidecar/…` 子代理记录 + 可选的 `artifacts.json` 与 `artifacts/…` 产物文件）。
- 推送：`POST /api/peer/session/<id>`，body 同上；接收方按修改时间做 last-writer-wins，覆盖前先把旧版本放进 `.ccapp-link-backups/<id>/<时间>/`。如果本地比来包新，返回 409，让发送方改拉取。
- 时间差在 2 秒内、内容又不同：不猜，记为冲突，在管理页里让人选「以本机为准 / 用对端的 / 两份都留」。
- 回收站（`.ccapp-trash/<id>/`）不参与同步，也不会被对端重新导入。
- 最近 `activeSec`（默认 30 秒，最小 30）内写过的会话先跳过，避免覆盖正在生成的文件。
- 默认每 15 秒自动同步一次；局域网对端在线时不走中转。
- 每 8 秒扫描一次 `.claude/projects` 的文件名，出现新会话（或被删除）时约 2.5 秒后再主动同步一次，
  不用等满一个间隔。
- 单个会话超过 `maxMB`（默认 64，可调 1–256）跳过；单次请求体有硬上限。
- 导入时把每一行的 `cwd` 改成本机存在的目录：对端工作区 → 本机工作区；否则看本机工作区里有没有同名目录，有就用它。会话名 / 置顶通过本机网关的 rename / pin 接口写回，网关不用重启就能看到。
- 产物（会话引用到的本机工作区文件）：打包时从 transcript 的工具参数和正文里认出工作区内的文件路径，按修改时间从新到旧装进包，默认总预算 24 MB、单文件上限 8 MB，超出的记进 `artifacts.json` 的 `dropped`；解包时写到接收方工作区里对应的相对路径，**不会写到工作区外面**，本地已有且不比来包旧的跳过。产物随会话包一起走局域网 / 中转；局域网里还有一条按需通道：查看器打开一个本机没有、但属于工作区的文件时，网关请 linkd 向在线对端 `GET /api/peer/file?rel=…` 取一份再打开（只读、单文件 ≤ 32 MB，失败后 30 秒内不重复问）。
- 不同步：接口 Key、设置、项目定义、整份工作区（只带上面说的产物）、回收站。
- 名字 / 置顶：以 `ccapp-session-names.json` 的文件时间新的一方为准；置顶取较大的时间戳。

## 会话来源

每条会话记一份来源 `{kind:"phone"|"pc", name, dev, platform}`，跟着会话包里的 `manifest.json` 的 `session.origin` 走：本机建的会话推给对端时带上自己的设备类别，对端收到后原样保存；以后无论怎么回传，来源都不变（记录的是「最初在哪台设备上建的」）。

- 工作台通过 `GET /api/origins` 读来源，在列表和侧栏给「不是本机创建」的会话标「手机 / 电脑」。**这只表示出处，不改变执行位置**：会话在本机打开时仍由本机的 claude 运行。
- 老会话（升级前就同步过来的）第一次启动时按 transcript 开头的环境快照回填：安卓上的 Claude Code 报 `Platform: linux`，Windows 报 `win32`；没有快照时看 `link.log` 里「收到会话」的记录，再没有就当作本机创建。
- 启动时会清掉本机已经不存在的会话的来源；识别规则升级用 `originsV` 触发一次重扫，只清按环境猜出来的（`src:"seed"`），对端明确给的不动。
- 工作台页面（网关端口）跨端口读 `/api/origins`：只对 `127.0.0.1:<网关端口>` / `localhost:<网关端口>` 放开 CORS，并且仍然要带网关 Cookie 鉴权。

## 安全

- 局域网接口只接受私有地址；Host 必须是本机地址（防 DNS rebinding），带 Origin 的请求必须是本机页面。
- 每个配对设备一份密钥，计时安全比较；本机令牌与 cccodroid 网关共用。
- 局域网这一段是明文 HTTP，没有 TLS：只在可信的家庭 / 办公室局域网开启，不要把 9378 暴露到公网；
  跨网络请走 HTTPS 的公网中转。
- 解压限制：总大小 128 MB、最多 5000 个文件、路径不能穿越；符号链接不跟随。
- 传输的 transcript 里可能包含密钥、路径等敏感内容；配对等于允许对端读写这些会话。

## 接口速查

本机（需 `x-link-token` / `t=` / 网关 Cookie）：

```
GET  /api/status              设备、局域网、发现、已配对设备、同步结果、冲突
GET  /api/local               本机会话数与列表
GET  /api/origins             本机设备的类别 + 每条会话的来源（手机 / 电脑）
POST /api/lan                 {"enabled":true|false}
POST /api/settings            {"deviceName","autoSync","interval","maxMB","activeSec"}
POST /api/pair/code           生成配对码
POST /api/pair/cancel         作废配对码
POST /api/pair/connect        {"addr","port","code"} 主动连另一台
POST /api/sync                {"id"?} 手动同步（不带 id 为全部）
POST /api/relay               {"url","token","name","enabled"} 保存公网中转
POST /api/relay/test          {"url"?,"token"?} 只探活，不改配置
POST /api/relay/off           停用公网中转（保留地址和令牌）
POST /api/peers/auto          {"id","autoSync"}
POST /api/peers/remove        {"id"} 解除配对
POST /api/conflict            {"peer","id","choice":"local"|"remote"|"both"}
GET  /api/backups[?id=]       本机备份
POST /api/backups/restore     {"id","stamp"} 恢复成新会话
GET  /api/log                 最近 200 行日志
```

局域网（需 Bearer 密钥；`/api/pair` 除外）：

```
POST /api/pair                {"code","id","name","port"} → {secret,self}
GET  /api/peer/ping
GET  /api/peer/manifest
GET  /api/peer/session/<id>
POST /api/peer/session/<id>[?force=1&peerWorkspace=...]
POST /api/peer/meta           {"names","pins","namesMtime","pinsMtime"}
POST /api/peer/unpair
```

## 测试

```sh
node test.mjs
node test-remote.mjs
node test-lan-first.mjs
node test-artifacts.mjs
```

`test.mjs`（30 项）在临时目录里起两个真实 linkd 进程（回环端口），覆盖：令牌 / 局域网鉴权、配对码、双向同步、cwd 改写、路径映射（transcript 与 sidecar 按对端 workspace / home 改写、哈希不误报冲突）、回收站不复活、活跃会话跳过、较新一方获胜、备份、名称同步、重复同步不重复写入、解除配对。

`test-remote.mjs`（15 项）用假执行器覆盖：默认拒绝、放行后派任务、来源与身份不一致拒绝、执行器报错回传、取消（两端）、关闭后拒绝，以及文本增量 / 工具调用事件回传到发起方。中转路径见 `relay/test-remote.mjs`。

`test-lan-first.mjs`（7 项）：两端都配了中转且局域网已配对，确认有局域网时自动同步不往中转上传；
关掉 A 的局域网后，自动回退到中转并完成上传。中转长轮询与事件驱动同步见 `relay/test-remote.mjs`。

`test-artifacts.mjs`（10 项）：只跑 `core.mjs`，覆盖产物的收集与落盘——按修改时间从新到旧挑选、
超预算的记进 `skipped`、会话包里的 `artifacts.json` 与文件、解包写出、二进制原样、不写到工作区外面、
本地更新的文件不被覆盖、不带 artifacts 时包里没有产物、上限很小时不超预算。

## 已知限制

- 只同步 Claude 会话；工作区文件、项目定义、设置、密钥不同步。
- 被同步的会话如果属于某个项目，而另一台设备没有同名目录，会落到工作区；会话能继续聊，但项目标签会变。
- 单会话上限是硬跳过；要同步超大会话，在管理页把上限调大（最大 256 MB）。
- 局域网同步是明文 HTTP；不要在公共 Wi-Fi 开启。公网中转走 HTTPS。
- 公网中转落盘的是明文会话 zip，服务器本身要按敏感数据保护。
- 安卓应用本体升级会覆盖 `files/app` 下的网关和网页；linkd 本体在 `files/home/.cccodroid/link/` 不受影响，但自启动和设置入口需要重新放回去。
