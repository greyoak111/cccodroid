# relay —— 公网中转（手机 ↔ 电脑跨网络同步）

linkd 原本只会在同一个局域网里配对。relay 把「一台双方都能访问的服务器」伪装成第三台设备：
手机和电脑都只向它发起**出站** HTTPS 连接，不需要公网 IP、不需要端口映射、不需要装 VPN，
两端也不必同时在线——谁先上线谁把会话交上去，另一台上线时再取走。

```
手机 linkd ──HTTPS 2443──┐
                         ├─→ Caddy ─→ relay 127.0.0.1:9380 ─→ sessions/*.zip + index.json
Windows linkd ─HTTPS 2443┘
```

- 中转只是一个「会存会话的对端」，接口和 linkd 的 `/api/peer/*` 一致；设备端把中转当成普通 peer。
- 中转不解压、不看内容：清单字段由设备放在 `x-link-meta` 头里（百分号编码的 JSON），zip 原样落盘。
- 局域网开关关闭时中转照样工作；两端都在 NAT 后面也没关系。

## 文件

| 文件 | 说明 |
|---|---|
| `relay.mjs` | 中转本体，单文件，无第三方依赖，Node ≥ 20 |
| `test.mjs` | 端到端测试：一个 relay + 两台真 linkd，全程只走中转 |
| `deploy/Caddyfile` | 示例：Caddy 做 TLS 终结，自动申请 / 续期证书 |
| `deploy/cccodroid-relay.service` | 示例：systemd 单元，监听 127.0.0.1:9380 |

## 部署（Ubuntu 24.04 / 阿里云 ECS 实测）

### 1. 准备域名

没有域名也可以：用 [sslip.io](https://sslip.io) 的公共通配 DNS，把 IP 写进主机名即可。
`47.103.209.3.sslip.io` 会直接解析到 `47.103.209.3`，Let's Encrypt 可以正常签发证书。

有域名就把 A 记录指到服务器 IP，把下面配置里的主机名换掉。

### 2. 端口

| 端口 | 用途 | 对外开放 |
|---|---|---|
| 80/tcp | ACME HTTP-01 校验 + 跳转 HTTPS（Caddy） | 是（仅签发证书用） |
| 2443/tcp | 中转 HTTPS（Caddy） | 是 |
| 9380/tcp | relay 本体 | **否**，只绑 127.0.0.1 |
| 443/tcp | 留给服务器上原有的服务（本例是 xray） | 不动 |

安全组 / 防火墙放行 80 和 2443：

```sh
ufw allow 80/tcp
ufw allow 2443/tcp
```

阿里云安全组也要放行这两个端口（控制台 → 安全组 → 入方向）。

### 3. 放文件、建用户

```sh
useradd --system --home-dir /var/lib/cccodroid-relay --shell /usr/sbin/nologin ccrelay
mkdir -p /opt/cccodroid-relay
install -m 755 relay.mjs /opt/cccodroid-relay/relay.mjs
mkdir -p /var/lib/cccodroid-relay
chown -R ccrelay:ccrelay /var/lib/cccodroid-relay
```

### 4. 启动 relay（只监听回环）

```sh
install -m 644 deploy/cccodroid-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cccodroid-relay
curl -s http://127.0.0.1:9380/api/health
```

首次启动会在 `/var/lib/cccodroid-relay/token` 生成 64 位十六进制令牌（mode 600）。
复制这个值，填到手机 / 电脑的「公网中转 → 访问令牌」里：

```sh
cat /var/lib/cccodroid-relay/token
```

### 5. Caddy 做 HTTPS

```sh
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
journalctl -u caddy -f   # 等到 "certificate obtained successfully"
```

示例配置的关键点：

- `https_port 2443`：443 已经被别的服务占用，HTTPS 换到 2443。
- `disable_tlsalpn_challenge`：强制走 HTTP-01（TLS-ALPN 校验固定用 443，换端口后会校验失败）。
- 证书由 Caddy 自动续期，不需要 cron；续期也用 80 端口。

如果 80 端口被别的程序占用，先停掉它，或者把 ACME 校验改到别的方式（DNS-01）。

### 6. 设备端

手机和 Windows 都是：**设置 → 设备互联 → 公网中转**，填

- 地址：`https://47.103.209.3.sslip.io:2443`（换成你的域名 / 端口）
- 令牌：第 4 步拿到的 64 位十六进制
- 点「保存并连接」，或者先点「测试」

不需要配对码，不需要开局域网。两台设备填同一个地址和令牌即可。
连上后「上次同步」会开始走，列表里的会话会按修改时间双向对齐。

## 接口

所有 `/api/peer/*`、`/api/relay/*` 都要 `Authorization: Bearer <token>`；
`/api/health` 不需要（只返回 `{ok,v,at}`）。

```
GET  /api/peer/ping                 探活，返回 {kind:"relay", ...}
GET  /api/peer/manifest             会话清单 + 名称 / 置顶 / 回收站
GET  /api/peer/session/<id>         取会话 zip
POST /api/peer/session/<id>         存会话 zip（元数据在 x-link-meta 头）
POST /api/peer/meta                 名字 / 置顶 / 回收站（并集，取较新）
GET  /api/relay/info                用量、配额、uptime
POST /api/relay/trim                按最旧上传时间清到配额以下
GET  /api/relay/events?since=&wait= 长轮询：有变化立刻返回，没变化最多挂 wait 秒（≤30）
GET  /api/health                    健康检查

# 远程执行（设备登记 + 任务信箱）
POST /api/relay/device              {"id","name","kind","platform","caps"} 设备每 15 秒登记
GET  /api/relay/devices             在线设备清单（含技能）
POST /api/relay/task                {"to","from","task"} 发起任务
GET  /api/relay/tasks?to=&status=   目标设备取收件箱
GET  /api/relay/task/<id>           查状态 / 结果；?since=<seq> 只返回该序号之后的事件
POST /api/relay/task/<id>/claim     目标设备认领 {"by"}
POST /api/relay/task/<id>           上报状态，可带 events[] 合并事件
POST /api/relay/task/<id>/cancel    发起方取消
```

远程任务的事件（文本增量、思考、工具调用 / 结果）由目标设备随状态上报，中转合并进任务
记录（每个任务保留最近 500 条，单条文本 16 KB），发起方带 `?since=` 增量取，用来在
`@设备-…` 点名时实时显示对端的执行过程。任务记录落盘，重启后事件还在。

点名派出的任务还会带上 `sessionId`、`text`、`context`：目标设备用它们在本地续跑同一个会话
（`claude --resume`），回复由 linkd 的普通会话同步回到发起方。中转只是把这些字段原样存进
`tasks/<id>.json`、随任务交给目标设备，不解压也不理解会话内容。

- 写入按 `mtime` 做 last-writer-wins，2 秒内不回退；被覆盖的设备自己留备份。
- 中转上的会话没有「归属设备」概念：谁最后推的版本新就是谁。
- 配额：`--max-gb`（默认 8 GiB）按会话总字节算，超了返回 507；
  单个会话上限 `--max-session-mb`（默认 64）和设备端 `maxMB` 一致，超了返回 413。
- 回收站只记 id，不存内容；在任一台设备删掉的会话，不会被中转搬回来。
- 令牌错误限流：同一 IP 连续 401 会短暂拒绝，防暴力猜。

### 长轮询事件

`GET /api/relay/events?since=<rev>&wait=25` 平时会把请求挂着，服务器上会话或任务一变就
立刻返回 `{ok, rev, kind, timeout:false}`；`kind` 是 `sessions` 或 `task`。没变化就等到
`wait` 秒（上限 30），返回 `timeout:true`。`since` 比服务器当前序号还大（服务器重启过、
内存里的序号归零）时返回 `kind:"reset"`，客户端从 0 重新对齐。

事件序号只存在内存里，重启后归零；会话和任务本身是落盘的。linkd 收到事件后立刻同步或取任务，
所以中转链路上的正常延迟在一秒以内；老版本 linkd 不认识这个接口，会拿到 404 后退回 5 秒轮询。

## 远程执行信箱

中转也能让两台设备隔着 NAT 互相派任务：设备每 15 秒登记一次（`/api/relay/device`），
发起方写任务，目标设备按 `to` 取收件箱、claim 后执行、把结果写回。中转只存 JSON，
不执行任何东西。任务放在 `<data>/tasks/<id>.json`，保留 7 天；提示上限 64 KB、结果 512 KB；
设备端还会各留一份本地记录（见 `link/README.md`）。

- `from` 由发起方自报，目标设备按自己的「远程执行 → 放行」表决定跑不跑。
  共享令牌持有者本来就能读写全部会话，远程执行的信任边界与令牌同级。
- 任务提示和结果在中转上是明文 JSON，可能含商品链接、账号信息；按会话数据同等级别保护。

## 直连 HTTPS（不套 Caddy）

relay 自己也能做 TLS，适合已经有证书、又不想跑反代的场景：

```sh
node relay.mjs --data /var/lib/cccodroid-relay --port 9380 --bind 0.0.0.0 \
  --tls-cert /etc/letsencrypt/live/example.com/fullchain.pem \
  --tls-key  /etc/letsencrypt/live/example.com/privkey.pem
```

注意设备端 Node 只认公共 CA：自签证书需要额外让两端信任（`NODE_EXTRA_CA_CERTS`），
不推荐，除非你清楚自己在做什么。

## 安全

- **令牌就是唯一的口令**。泄露等于把会话同步权限交出去：泄露后换 `token` 文件、重启服务、两台设备重新填。
- 传输走公共 CA 签发的 TLS，链路是加密的；但中转**落盘的是明文 zip**（transcript 里可能有密钥、路径、代码）。
  服务器本身要按「存着你的 Claude 会话」来保护：禁 root 密码登录、只用密钥、及时打补丁。
- relay 只监听 127.0.0.1，公网只暴露 Caddy 的 80 / 2443；不要把 9380 放进安全组。
- Caddy 默认不记访问日志；需要排障时再在站点块里加 `log`。
- 不建议把中转放在共享主机上；同机的其他租户能读磁盘就能读会话。

## 排障

| 现象 | 查什么 |
|---|---|
| 设备显示「连不上 中转」 | `curl -v https://<域名>:2443/api/health`；安全组 / UFW 是否放行 2443；Caddy 是否 active |
| 401 | 令牌不一致；`cat /var/lib/cccodroid-relay/token` 重新填 |
| 证书报错 | `journalctl -u caddy`；80 端口是否被占用；域名是否解析到本机 |
| 413 / too big | 单会话超过 64 MB；在设备端把 `maxMB` 调大，或中转加 `--max-session-mb` |
| 507 | 中转配额满；`POST /api/relay/trim` 或调大 `--max-gb` |
| 一直「延迟」 | 会话正在写入（`activeSec` 内），等它静下来会自动同步 |
| 换域名 / 换端口 | 两台设备都要改地址；中转数据不随域名走 |

## 测试

```sh
node relay/test.mjs
node relay/test-remote.mjs
```

`test.mjs` 21 项：鉴权、只走中转的同步、LWW 与备份、来源保留、名称同步、回收站不复活、配额清理、停用中转。

`test-remote.mjs` 14 项：长轮询的立即返回 / 超时 / 序号重置，两台 linkd 都只配中转时的设备登记、
跨中转派任务、结果回传、任务状态落盘、执行事件（文本增量 / 工具调用）经中转回到发起方，
以及 B 靠长轮询在 1 秒内收到 A 推来的新会话。

## 本机实际部署（2026-10-27）

| 项 | 值 |
|---|---|
| 服务器 | 阿里云 ECS `47.103.209.3`，Ubuntu 24.04.5，Node v22.13.1 |
| 地址 | `https://47.103.209.3.sslip.io:2443`（Let's Encrypt，Caddy 自动续期） |
| relay | `/opt/cccodroid-relay/relay.mjs`，systemd `cccodroid-relay`，127.0.0.1:9380 |
| 数据 | `/var/lib/cccodroid-relay/`（`index.json`、`sessions/*.zip`、`token`、`relay.log`） |
| TLS | `/etc/caddy/Caddyfile`（原配置备份为 `Caddyfile.bak-*`），Caddy 80 + 2443 |
| 配额 | 8 GiB / 单会话 64 MB |

改配置后：

```sh
systemctl restart cccodroid-relay
systemctl reload caddy
```
