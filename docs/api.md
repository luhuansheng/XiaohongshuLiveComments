# HTTP API

默认地址为 `http://127.0.0.1:8789`。请求和普通响应使用 JSON；SSE 使用 `text/event-stream`。管理接口没有内置鉴权，默认供本机或已有访问控制的入口使用。`/v1` 仅为本项目 API 的版本前缀。

普通成功响应为 HTTP 200，受控服务重启为 202。未知路径或房间返回 404，不支持的方法返回 405；参数和业务校验错误返回 400，例如 `{"error":"错误说明"}`。请求体最大 128 KiB，没有统一 `data` 包装层。

所有 ID 示例均为虚构数字字符串。长 ID 不应转换为 JavaScript Number。

## 接口一览

| 方法 | 路径                              | 功能                           |
| ---- | --------------------------------- | ------------------------------ |
| GET  | `/health`                         | 服务存活、PID、北京时间        |
| GET  | `/v1/status`                      | 服务、资源、房间和当前测试状态 |
| GET  | `/v1/rooms`                       | 房间配置、采集状态和缓存统计   |
| PUT  | `/v1/rooms/:room_number`          | 新增或替换配置并持久化         |
| POST | `/v1/rooms/:room_number/start`    | 启动，保存 `enabled=true`      |
| POST | `/v1/rooms/:room_number/stop`     | 停止，保存 `enabled=false`     |
| GET  | `/v1/rooms/:room_number/comments` | 按接收时间与 ID 分页查询       |
| GET  | `/v1/rooms/:room_number/stream`   | SSE 新评论                     |
| POST | `/v1/rooms/:room_number/window`   | 视频时间及前置冗余窗口查询     |
| POST | `/v1/test/start`                  | 开始有截止时间的测试           |
| POST | `/v1/test/stop`                   | 提前停止当前测试               |
| GET  | `/v1/test`                        | 当前测试或 `{"phase":"idle"}`  |
| POST | `/v1/service/restart`             | 受控重载，需监督程序恢复进程   |

## 房间配置与生命周期

`room_number` 是业务编号，允许 1–80 位 ASCII 字母、数字、下划线、点和短横线，不能为 `.` 或 `..`。`room_id` 是平台数字字符串。

```http
PUT /v1/rooms/shop_01
Content-Type: application/json

{
  "room_id": "123456789012345678",
  "url": "https://www.xiaohongshu.com/livestream/123456789012345678",
  "enabled": true
}
```

`url` 可以省略。提供时必须为与 ID 完全匹配的 HTTPS 小红书公开直播页，不能有查询参数、片段或账号密码。`enabled` 默认为 true。

PUT 替换指定编号的配置，保存后不自动采集；运行中房间须先停止。启动接口幂等，不等待第一条评论。停止接口终止客户端并持久化关闭开关，重启后开关保持。

房间视图包含配置、`state`、`guest_confirmed` 和 `cache`；运行客户端还提供 `room_subscribed`、最后帧、心跳、身份哈希、解码与连接计数。身份哈希用于区分会话，不是可直接登录的游客凭据。

判断采集成功应同时检查游客确认、订阅与真实文字数量。缓存量是当前留存期内的数量；`client.comment_count` 是当前服务进程的客户端计数；`rooms[].test_comments` 才是本轮测试数量。

## 评论查询与分页

```http
GET /v1/rooms/shop_01/comments?limit=1000
```

| 参数       | 说明                               |
| ---------- | ---------------------------------- |
| `from`     | 带时区的 ISO 8601 起始时刻，包含   |
| `to`       | 带时区的 ISO 8601 结束时刻，不包含 |
| `limit`    | 1–10000 整数，默认 1000            |
| `after_id` | 仅返回 ID 大于该值的记录           |

查询参数中的 `+08:00` 需将 `+` 编码为 `%2B`。`from` 早于留存期时限制为当前留存起点；记录按 ID 升序返回，并限定为当前配置的 `room_id`。

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

五个评论字段均为字符串。`received_at` 是采集端接收北京时间；`id` 为稳定且同房递增的时间戳字符串。跨房间用 `(room_number, id)` 标识。

`truncated=true` 时，以 `next_after_id` 作为下一页的 `after_id`，保持相同时间范围；取到 `truncated=false` 为止。最后一页的 `next_after_id=null`，增量轮询需自行保留最后一条 ID。

## SSE 新评论

```http
GET /v1/rooms/shop_01/stream
```

```text
: connected

event: comment
data: {"room_number":"shop_01","room_id":"123456789012345678","user_id":"987654321","user_name":"示例用户","content":"示例评论","id":"1791864005123","received_at":"2026-10-13T12:00:05.123+08:00"}

```

每 15 秒有注释心跳。仅推送成功入库的新评论，重复消息不重复推送。SSE 不启动房间、不重放历史，也没有 `Last-Event-ID` 恢复机制。重连后可用 comments 接口和上次 ID 补查已入库且仍留存的评论；采集连接本身断线期间没有平台历史补拉。

## 视频时间窗口

```http
POST /v1/rooms/shop_01/window
Content-Type: application/json

{
  "video_start": "2026-10-13T12:00:00+08:00",
  "video_end": "2026-10-13T12:15:00+08:00",
  "preroll_seconds": 300,
  "limit": 1000
}
```

这些时刻仅示意历史数据查询。开始、结束必填且带时区，结束晚于开始。`preroll_seconds` 可省略，使用配置默认值 300，为非负数；`limit`、`after_id` 与评论查询相同。

完整响应包含评论查询的房间信息、评论、分页字段及以下 `window`：

```json
{
  "window": {
    "video_start": "2026-10-13T12:00:00.000+08:00",
    "video_end": "2026-10-13T12:15:00.000+08:00",
    "comments_from": "2026-10-13T11:55:00.000+08:00",
    "comments_to_exclusive": "2026-10-13T12:15:00.000+08:00",
    "preroll_seconds": 300
  }
}
```

区间为 `[video_start - preroll_seconds, video_end)`。重叠窗口返回原评论 ID，数据受当前留存期限制；窗口描述不代表全程有采集覆盖。接口不录制、切片或向外部发送请求。

## 有时限测试

PowerShell 示例动态计算未来一小时截止，避免固定日期过期：

```powershell
$body = @{
  stop_at = [DateTimeOffset]::Now.AddHours(1).ToString('o')
  room_numbers = @('shop_01', 'shop_02')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8789/v1/test/start' -ContentType 'application/json' -Body $body
```

`stop_at` 必须处于未来 24 小时内并带时区。`room_numbers` 可省略，选择配置中 `enabled=true` 的房间；显式列表须非空、无重复且已注册。存在 running/stopping 测试时拒绝第二轮。关闭配置的房间不会因恢复测试而重新启动。

GET `/v1/test` 返回 `run_id`、`phase`、`started_at`、`stop_at`、各房间 `test_comments`、共同订阅窗口及窗口评论数。评论数按本轮时间范围筛选，不能用当前进程计数替代。

到期或 `POST /v1/test/stop` 会结束本轮客户端、保留评论和 enabled 配置、生成 `validation.json`。单独 API 服务可继续查询；`test:live` 监督程序约在截止后 30 秒关闭自己创建的子进程。

共同文字验收要求所有房间确认游客、身份独立，且每房间在共同订阅窗口内有文字。0 评论房间不能用心跳、商品或进场消息代替验收。完成状态仅表示测试结束，还应检查 `interruptions`、`resume_count`、订阅区间与错误。

## 受控服务重启

`POST /v1/service/restart` 要求运行中的测试，返回 HTTP 202：

```json
{
  "accepted": true,
  "restart_by": "supervisor",
  "preserves_test": true
}
```

响应后保存中断标记并关闭当前服务，由 `npm run test:live` 的监督程序重新拉起，保留原测试截止和入库评论。单独 `npm start` 没有该监督程序，不会自动重新启动服务。此接口用于受控恢复验证，可能产生采集缺口；不是周期性维护命令。

## 本地导出与外部对接

JSON 数组导出是本地 CLI 功能，不新增 HTTP 路由，参见 README 中的 `export:comments`。该服务不调用外部业务 v1；下游应主动查询 comments/window 或订阅 SSE，再组织自己的业务请求。
