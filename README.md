# 小红书直播游客评论采集服务

独立的 Node.js 服务，为每个公开直播间建立独立游客会话，通过 HTTP 和 WebSocket 实时接收文字评论。提供房间启停、SQLite 持久化、分钟 JSON 缓存、时间窗口查询、SSE 和有明确截止时间的并发测试。

运行时不需要浏览器或平台登录账号。平台协议和签名来自网页游客访问链及第三方签名库，属于非官方实现；平台变更可能影响兼容性。

## 功能

- 每房间独立游客身份、Cookie、设备标识和 WS 连接；明确确认 `guest=true` 后进房。
- 鉴权、进房 ACK、心跳、超时检测、退避重连和关播等待。
- SQLite 事务去重，稳定的时间戳评论 ID；按房间、北京时间分钟导出 JSON。
- 默认 48 小时评论留存，按接收时间分页查询。
- 视频时间窗口默认向前冗余 5 分钟；重叠窗口保留原评论 ID。
- 本地 HTTP 管理接口和 SSE 新评论推送。
- 有时限测试、进程监督、恢复原截止时间、状态与校验报告。
- 每房间 JSON 数组导出，便于离线查看或交给下游系统。

本项目采集文字评论，不采集视频、不发送平台评论，也不调用外部视频分析服务。`/v1` 是本项目本地 API 的版本前缀。

## 快速开始

要求 **Node.js 24 或更新版本**，使用内置 `node:sqlite`；依赖由 `package-lock.json` 固定。

```sh
npm ci --ignore-scripts
npm run config:init
npm run check
npm start
```

`config:init` 从示例创建本地配置，**不会覆盖已有配置**。示例房间字典为空，首次启动仅提供 API。`npm test` 和 `npm run check` 使用模拟网络、临时数据库，不会自动进入真实直播间。

健康检查：

```sh
curl http://127.0.0.1:8789/health
curl http://127.0.0.1:8789/v1/status
```

配置房间并调用启动接口后才采集；若存在尚未截止的运行中测试，且启用 `resume_active_test`，启动时会恢复该测试。

## 配置与启停

编辑本地 `config/rooms.json`。以下数字为虚构示例，需要替换为实际公开直播间 ID：

```json
{
  "shop_01": {
    "room_id": "123456789012345678",
    "url": "https://www.xiaohongshu.com/livestream/123456789012345678",
    "enabled": true
  }
}
```

业务编号 `shop_01` 与平台 `room_id` 分开。长 ID 必须写成字符串；`url` 可省略，若提供必须与 ID 匹配。配置保存不自动启动采集。修改运行中房间前应先停止。

```sh
curl -X POST http://127.0.0.1:8789/v1/rooms/shop_01/start
curl -X POST http://127.0.0.1:8789/v1/rooms/shop_01/stop
```

启动/停止会将房间 `enabled` 持久化为 `true`/`false`。测试到期停止不修改开关。启动响应表示后台任务开始，应继续检查订阅状态和真实评论数；握手或心跳不能替代文字采集成功。

`config/settings.json`：

| 设置                 | 默认值      | 说明                             |
| -------------------- | ----------- | -------------------------------- |
| `host`               | `127.0.0.1` | API 监听地址，`HOST` 可覆盖      |
| `port`               | `8789`      | API 端口，`PORT` 可覆盖          |
| `data_dir`           | `data`      | 数据目录，`DATA_DIR` 可覆盖      |
| `output_dir`         | `outputs`   | 报告目录，`OUTPUT_DIR` 可覆盖    |
| `retention_hours`    | `48`        | 评论留存小时数                   |
| `preroll_seconds`    | `300`       | 时间窗口向前冗余秒数             |
| `resume_active_test` | `true`      | 恢复尚未截止的运行中测试         |
| `raw_frames`         | `false`     | 原始协议帧开关；公开发布保持关闭 |

相对路径以项目根目录为基准。不要将本地配置、评论、Cookie 或运行日志提交到 Git。

## 评论格式

查询接口以房间信息包装评论列表。以下为虚构数据：

```json
{
  "room_number": "shop_01",
  "room_id": "123456789012345678",
  "comments": [
    {
      "user_id": "987654321",
      "user_name": "示例用户",
      "content": "这个包多少钱？",
      "id": "1791864005123",
      "received_at": "2026-10-13T12:00:05.123+08:00"
    }
  ],
  "truncated": false,
  "next_after_id": null
}
```

`received_at` 是采集端收到消息的北京时间，不能视为观众点击发送的精确时刻。评论 ID 是持久化的时间戳字符串，在同一业务房间内递增；跨房间使用 `(room_number, id)` 标识评论。内部保留上游 ID 去重，对外固定五个评论字段。

默认每页 1000 条，最高 10000 条。`truncated=true` 时以 `next_after_id` 继续查询。窗口接口返回 `[视频开始前 5 分钟, 视频结束)` 的记录，需要调用方提供视频时刻；实际视频同步需另行联测。

完整接口与分页示例见 [API 文档](docs/api.md)。

## 有时限的真实测试

先配置实际需要测试的房间。PowerShell 示例使用当前时间之后 30 分钟：

```powershell
$stopAt = [DateTimeOffset]::Now.AddMinutes(30).ToString('o')
npm run test:live -- --stop-at $stopAt
```

监督程序创建专属 API 子进程，最多恢复 5 次；恢复沿用原测试和绝对截止时间。到期由服务自己停止采集，监督程序约在截止后 30 秒关闭子进程。

不要同时运行 `npm start` 和 `npm run test:live` 争用端口。已有 API 时可直接开始一小时测试：

```powershell
$body = @{
  stop_at = [DateTimeOffset]::Now.AddHours(1).ToString('o')
  room_numbers = @('shop_01')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8789/v1/test/start' -ContentType 'application/json' -Body $body
Invoke-RestMethod 'http://127.0.0.1:8789/v1/test'
```

`stop_at` 必须带时区，处于未来 24 小时内。已有运行中测试时拒绝第二轮。提前结束使用 `POST /v1/test/stop`。服务没有内置“每 30 分钟报告”；外部监控可只读查询，采集截止不依赖监控调度。

## 导出 JSON 列表

导出每个配置房间的独立 JSON 数组文件：

```sh
npm run export:comments -- --out exports
npm run export:comments -- --room shop_01 --out exports
```

可用 `--from`、`--to` 指定带时区的 ISO 时间，范围为 `[from, to)`；`--room` 可重复。不指定房间时导出所有配置房间，不指定输出时写入 `outputs/comments_<北京时间戳>/`。无评论房间输出 `[]`。导出读取数据库中仍存在的记录，已清理的数据不会恢复。目录为本地数据，应排除在源码发布之外。

## 项目结构

```text
src/
  application/collector-service.cjs       房间生命周期、测试与报告
  http/router.cjs                         HTTP 路由和 SSE
  infrastructure/
    xiaohongshu/guest-client.cjs           游客 HTTP、WS、心跳与重连
    xiaohongshu/parser.cjs                 协议解析、文字提取、串房过滤
    storage/comment-store.cjs             SQLite、去重、分钟 JSON、留存
  shared/atomic-json-writer.cjs            原子快照与临时文件重试
  shared/time.cjs                         北京时间与时刻处理
  config/runtime-config.cjs               配置、默认值、环境变量
  cli.cjs                                启动与进程信号处理
  index.cjs                              模块入口
  server.cjs                             旧入口兼容层
config/                                  可提交的 *.example.json
scripts/                                 配置初始化、监督、导出与检查
tests/                                   离线测试
docs/                                    架构、API、匿名验证记录
.github/                                 CI 和协作模板
```

架构职责、协议流程及方案优劣见 [架构说明](docs/architecture.md)。

## 数据与验证

运行数据默认写入 `data/` 和 `outputs/`：SQLite 是评论事实来源，分钟 JSON 是可重试的导出；临时 JSON 写入失败不会抹掉已入库评论。每 10 秒维护留存、缓存和状态。

```text
data/
  comments.sqlite
  comment_cache/room_<安全编号>/<安全房间ID>/<北京时间日期>/<时分>.json
  service_state.json
  service_events.jsonl
  current_test.json
outputs/
  latest.json
  guest_validation_<时间>/state.json、summary.json、validation.json、events.jsonl
  supervisor_<时间>/events.jsonl、service_<次数>_stdout.log、service_<次数>_stderr.log
```

评论默认保留 48 小时；测试报告、事件日志和手工导出不随评论清理，需另外管理。SQLite 删行后文件大小可能保留供复用。

重构前基线 **31 项离线测试通过**。一轮五房间实测得到 **132 条评论**，三间有文字、两间未验证，发生两次受控恢复间隙；五房间共同文字并发验收未通过。详细事实和未验证项目见 [验证记录](docs/validation.md)。十路容量、完整交付、真实 48 小时运行、token 到期续期及视频同步仍需单独验证。

## Docker

```sh
docker compose run --rm collector npm run config:init
docker compose up --build -d
```

Compose 使用非 root 服务进程和三个具名卷保存配置、数据、输出，宿主端口仅绑定 `127.0.0.1:8789`。通过 API 配置房间或编辑配置卷；卷中的配置与宿主本地 `config/` 独立。容器内监听 `0.0.0.0`，不代表应将管理接口暴露到公网。

管理 API 当前没有鉴权，默认供本机使用；跨主机部署应在入口配置鉴权与访问控制。Docker 构建和容器内实际采集的验证范围见验证记录。

## 开发与源码包

```sh
npm run check
npm run lint
npm run format:check
npm run format
npm run package:source
```

`check` 验证语法、格式并运行离线测试；`lint` 检查语法及格式，`format:check` 只用 Prettier 检查格式，`format` 修改格式。`package:source` 使用允许列表及敏感内容检查，生成 `outputs/releases/xiaohongshu-live-comments-0.1.0-source.tar.gz`，保留锁定依赖文件。打包需要系统 `tar`，可先运行 `tar --version`。此命令不创建 GitHub 仓库或上传文件。

贡献方式见 [CONTRIBUTING](CONTRIBUTING.md)，安全报告见 [SECURITY](SECURITY.md)，版本记录见 [CHANGELOG](CHANGELOG.md)。GitHub 发布只包含源码、示例配置、离线测试和匿名文档。本地 `config/settings.json`、`config/rooms.json`、`data/`、`outputs/`、导出评论、日志及 `node_modules/` 不属于源码包；发布前请核对实际提交列表。

项目源码采用 [MIT License](LICENSE)。依赖保留各自许可证。MIT 许可不代替平台访问条件，也不授予对评论数据的额外权利。本项目与小红书平台无官方关联。
