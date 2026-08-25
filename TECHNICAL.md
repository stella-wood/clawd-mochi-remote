# Clawd Mochi 技术与文档审计

本文件补充 `README.md`，用于维护代码、排查远程链路，以及说明旧文档如何合并。它不记录任何实际凭据。

## 事实来源与证据等级

本次整理使用以下优先级：

1. 当前固件 `clawd_mochi/clawd_mochi.ino`；
2. 当前 Worker `cloudflare worker代码/worker7.js`；
3. 当前目录结构和 3MF 容器元数据；
4. 当前文档中的验收记录；
5. `backup/` 和 `等待更新/` 中的历史材料。

代码可以证明某个分支、配置入口或协议存在，不能证明固件已刷入、Worker 已部署、Cloudflare Secret 已设置、EMQX Rule 已启用或屏幕当前正常。

## 当前实现

### 固件启动顺序

1. 初始化串口、背光、SPI 和 ST7789。
2. 显示启动文字和一次 logo 动画。
3. 切换为 `WIFI_AP_STA`，同时启动本地热点和家庭 Wi-Fi 连接。
4. 最多阻塞等待家庭 Wi-Fi 15 秒；失败时热点仍保留。
5. MQTT 客户端使用 TLS、30 秒 keepalive、5 秒重连节流。
6. 注册本地 HTTP GET 路由并启动 WebServer。
7. 主循环依次调用 MQTT 重连、`mqtt.loop()` 和 `server.handleClient()`。

MQTT 和大部分动画共用单线程循环；长动画中的 `delay()` 会推迟网络处理。

### VIEW 与命令

| VIEW | 值 | 远程命令 | 本地字符 | 重绘行为 |
|---|---:|---|---|---|
| 普通眼睛 | 0 | `blink`, `normal` | `w` → `blink` | 普通眼睛 |
| 挤眼 | 1 | `squish` | `s` | 挤眼 |
| Code/终端 | 2 | — | `d` → `code` | Code 画面 |
| Canvas | 3 | `canvas` | 页面 `/canvas` | 清为画布背景 |
| Wink | 4 | `wink` | `e` | 单眼闭合 |
| Sleep | 5 | `sleep` | `f` | 闭眼与 z/Z |
| Angry | 6 | `angry` | `g` | 怒眼 |
| Sad | 7 | `sad` | `h` | 伤心眼 |
| Cute | 8 | `cute` | `i` | 小圆眼 |
| Dead | 9 | `dead` | `j` | X 眼 |
| Love | 10 | `love` | `l` | 爱心眼 |
| Surprised | 11 | `surprised` | `m` | 大圆眼与嘴 |
| Happy | 12 | `happy` | `n` | `^^` 眼 |

`logo` 仅为本地字符 `a` 和启动动画。`normal` 没有独立本地字符；网页的普通眼睛按钮实际调用 `blink`。

### 本地 HTTP 接口

所有路由都由设备上的 `WebServer` 提供，均为 GET。

| 路径 | 参数 | 行为 |
|---|---|---|
| `/` | — | 返回内嵌控制页，禁止缓存 |
| `/cmd` | `k=<首字符>` | 本地命令映射；先返回 200，再同步执行 |
| `/char` | `c=<字符>` | 终端输入；非终端模式也返回成功 |
| `/speed` | `v=1..3` | 设置慢、正常或快 |
| `/redraw` | `bg=#RRGGBB` | 更新背景并按当前 VIEW 重绘 |
| `/canvas` | `on=1/0` | `on=1` 进入 Canvas；`on=0` 不切换 VIEW |
| `/draw/clear` | `bg=#RRGGBB` | 清屏并进入 Canvas |
| `/draw/stroke` | `pen=<hex>&pts=x,y;...` | 绘制折线；没有点数或范围限制 |
| `/backlight` | `on=1/0` | 控制 GPIO3 |
| `/state` | — | 返回 `view`、`busy`、`term`、`bl`、`speed` |

接口不鉴权。未知 `/cmd` 字符、缺少绘图参数和非终端字符输入仍可能返回 `{"ok":1}`，不能把 HTTP 200 当作动作成功。

## MQTT 与设备确认

### 下行

Worker 向 `clawd/mochi/cmd` 发布：

```text
<command>#<8字符随机nonce>
```

发布参数为 QoS 1、`retain: false`。固件也兼容不带 `#` 的旧式纯命令。

### 上行

固件在 `executeCommand()` 返回后向 `clawd/mochi/state` 发布 retained JSON：

```json
{
  "cmd": "love",
  "nonce": "abcd1234",
  "ok": 1,
  "view": 10,
  "up": 123456
}
```

- `ok` 是数字 `1` 或 `0`；
- `up` 是设备 `millis()`；
- 本地 `/cmd` 也尝试上报，但 nonce 为空；
- MQTT 未连接时 `publishState()` 直接返回，不影响本地显示；
- 状态消息设置 `retain: true`，但当前 Worker 不读取 EMQX retained API。

当前回程由外部 EMQX Rule 把状态 payload POST 到 `/report`。Worker 把原始正文保存到 D1 的固定键 `last_state`，然后每 250 ms 查询一次，最多 12 次，找到相同 nonce 即确认。

## Worker 行为

### MCP

- 仅接受对当前 MCP 路径的 POST；
- 默认路径为 `/mcp`；设置 `MCP_PATH_SECRET` 后改为 `/mcp/<secret>`，其他 `/mcp...` 路径返回 404；
- 实现 `initialize`、`notifications/initialized`、`tools/list` 和 `tools/call`；
- `protocolVersion` 固定为 `2025-03-26`；
- `tools/list` 和 command 校验共用单一 `COMMANDS` 数组；
- `tools/call` 不校验 `params.name`，只读取 `params.arguments.command`；
- 未实现会话、OAuth、Origin 校验、请求大小限制或限流。

### HTTP 入口

| 路径 | 保护 | 行为 |
|---|---|---|
| `/report` | `X-Report-Token` | 将原始正文写入 D1；写失败仍返回 200 |
| `/peek` | 无 | 返回 D1 中最后状态 |
| `/mcp` 或私密路径 | 可选私密路径 | MCP JSON-RPC |
| 其他路径 | 无 | 返回服务版本文字 |

Worker 调用 EMQX HTTP API 时只返回 HTTP `ok/status`，没有请求超时和异常分类。D1 读取使用普通 `env.DB.prepare(...)`；当前源码没有历史文档所称的 `withSession('first-primary')`。

## 敏感配置边界

当前有四类不同凭据，不能混用：

1. 设备热点与家庭 Wi-Fi；
2. ESP32 连接 EMQX 的 MQTT 客户端凭据；
3. Worker 调用 EMQX HTTP API 的 Deployment API Key/Secret；
4. EMQX Rule 调用 Worker `/report` 的报告 token。

此外还有可选的 MCP 私密路径。当前固件把 Wi-Fi、MQTT 凭据，以及一套已停用 HTTPS 上报的 URL/token 直接编译进二进制；Worker 的 Deployment API 凭据仍从环境变量读取。`MQTT.txt` 还保存交接字段。文档只应记录字段名和配置位置，不应记录值。

## 维护流程

### 只修改固件效果

1. 从磁盘重新读取正式 `.ino` 并建立恢复点。
2. 最小修改绘制或动画。
3. 用记录的 Board/分区设置编译并记录空间。
4. 上传并检查完整成功日志。
5. 串口分别验证 Wi-Fi、MQTT、订阅和状态回报。
6. 本地页面与原命令回归。
7. 命令名不变时，不需要改 Worker 或刷新 MCP schema。

### 新增或改名远程命令

1. 先在固件中增加 VIEW、绘制、动画、`executeCommand()`、`routeRedraw()` 和本地测试映射。
2. 编译、上传并本地验收。
3. 同步 Worker `COMMANDS` 和工具描述。
4. 部署前比较线上 Worker 与本地 `worker7.js`。
5. 保留 `command#nonce`、`publishState()`、`/report` 和 D1 链路。
6. Deploy 后让 MCP 客户端重新读取 schema。
7. 验证在线成功与设备断电超时。

### 新增简单静态表情的完整检查点

旧的“新增表情手册”删除后，以本节为准：

1. 先确定小写英文命令名、最终画面、进入动画、保持/退出方式和未占用的本地测试字符。当前 `o` 未占用，但修改前仍须重新检查 `routeCmd()`。
2. 增加新的 `VIEW_EYES_*` 常量；当前编号使用到 12，新 VIEW 应使用未占用值。
3. 增加独立 `draw...Eyes()` 绘制函数，优先复用 `eyeLX()`、`eyeRX()`、`eyeY()`、`eyeCY()`、`EYE_W`、`EYE_H`、`animBgColor` 和现有几何 API。
4. 增加 `anim...()`；先设置 `busy=true`，最终画面必须停在新表情，结束时恢复 `busy=false`，不要在末尾画普通眼睛。
5. 在 `executeCommand()` 中设置新 VIEW、退出终端模式并调用动画。
6. 在 `routeRedraw()` 中增加新 VIEW 的静态重绘，否则改背景色后会丢失表情。
7. 在 `routeCmd()` 增加测试字符映射，保留末尾统一的 `executeCommand()` 和 `publishState(cmd, "", ok)`，不要另造状态协议。
8. 需要网页按钮时，要同步 HTML、JavaScript 映射、高亮和锁定逻辑；默认可只保留调试 URL。
9. 固件本地验收通过后，再把同名命令加入 Worker `COMMANDS` 和工具描述。不要向 Worker 暴露 `code`、`logo` 等仅供本地的命令，除非明确改变产品行为。
10. 验收静态保持、`normal` 退出、背景重绘、nonce 相同、在线确认和断电超时。

如果命令需要文字、坐标、颜色或速度参数，它不再属于“简单表情”；应先单独设计输入 schema 和固件协议，不能把参数硬塞进现有字符串命令。

### 外壳文件

`clawd_mochi.3mf` 是 Bambu Studio 归档，包含两个模型对象。内嵌实际切片配置记录为 Bambu Lab A1 mini、0.4 mm 喷嘴、0.20 mm Standard、2 圈墙、15% grid infill、tree(auto) support；归档说明文字另建议 0.15–0.20 mm、15% gyroid 和支撑，两者有冲突。打印前应在切片器中检查朝向、支撑和预览，不要把说明文字自动覆盖到内嵌配置。模型的设计者和许可信息见 README。

## 删除旧文档后的保留集

为了让 Agent 在删除旧说明文件后仍能接手，必须保留：

- `AGENTS.md`；
- `docs-merged/README.md`；
- `docs-merged/TECHNICAL.md`；
- 两份当前源码；
- 运行硬件时所需的实际私密配置，保存位置由用户决定。

旧根目录手册、`等待更新/` 中的 Markdown、备份中的文档副本和 `MQTT.txt` 都不是这三份文档的阅读依赖。`backup/` 中的代码恢复点和 `clawd_mochi.3mf` 不是“说明文档”，是否保留应按恢复与外壳需求另行决定，不能在清理文档时顺手删除。

## 旧文档盘点

### 合并前的根目录文档

| 文件 | 独有或最有价值的信息 | 大量重复 | 冲突或边界 |
|---|---|---|---|
| `AGENTS.md` | 源码优先、敏感信息、备份和协作规则 | 命令表、链路、验收 | 基线日期和外部状态不能自动当作当前在线事实 |
| `clawd-mochi-guide.md` | 接线、Arduino 操作、本地与远程部署入口 | 功能、命令、故障表 | 库版本与编译结果未由构建文件锁定；云端状态不可由仓库证明 |
| `Clawd-Mochi-验收与维护手册.md` | 分层验收、串口现象和排障顺序 | 架构、命令、配置 | 验收记录不能冒充本轮复测 |
| `Clawd-Mochi-MCP维护与加固建议.md` | `/peek`、`/report`、TLS、认证等风险清单 | 架构、待办、回归 | 部分路线图和规范描述不是当前代码行为 |
| `新增 Claude 表情操作手册.md` | 新表情所需的 VIEW/绘制/命令/重绘步骤 | 编译、部署、验收 | `confused` 只是示例，当前代码并未实现 |
| `MQTT.txt` | 敏感配置交接字段 | 固件中已有部分配置 | 不应作为普通说明文档或复制来源 |

### 历史材料与其他文件

| 文件或目录 | 结论 |
|---|---|
| `等待更新/ESP32补丁 状态回传.md` | `publishState()` 与 nonce 补丁已并入当前固件；施工步骤已过期 |
| `等待更新/worker4.js` | retained API 读取方案已被当前 D1 Worker 取代 |
| `等待更新/部署顺序与验收.md` | 实施顺序有历史价值，但“未实测”“最后再启用”等状态不代表现在 |
| `backup/backup-20260716-*` | 记录从 4/7 个命令扩展到 13 个命令、统一 `executeCommand()` 和静态 VIEW 的过程 |
| `backup/backup-20260809-*` | 保存状态回程和文档同步前后的快照；当前源码与其中一个恢复点哈希一致 |
| `backup/backup-root/` | 更早的 4 命令基线，已被当前实现取代 |
| `clawd_mochi.3mf` | 两个外壳对象及 Bambu Studio A1 mini 切片配置；营销描述不是固件事实，且描述与内嵌切片参数有差异 |
| `.theia/launch.json` | 配置列表为空，对构建和启动没有实际作用 |

## 已判定过期或冲突的内容

- Worker 名称 `worker(3).js`、`worker(5).js` 或 `worker4.js`：当前文件是 `worker7.js`，内部版本 5.0.0。
- 当前恢复点为不存在的 `backup-20260808-state-report/`：磁盘实际存在的是 2026-08-09 恢复点。
- Worker 直接读取 retained API：只存在于施工稿，当前 Worker 使用 D1。
- ESP32 直接 HTTPS POST 为当前回程：函数仍在，但调用被注释，当前启用 MQTT 状态 topic。
- Cloudflare KV 为当前状态存储：当前 Worker 没有 KV 访问。
- 当前 Worker 已使用 `withSession('first-primary')`：磁盘源码中没有。
- Worker 仍维护 enum 与 allowlist 两份命令表：当前已统一为 `COMMANDS`。
- “Broker 接受即已送达/屏幕已执行”：当前必须等待相同 nonce；即便确认也不是像素自检。
- 旧分区下约 88% 的编译占用：已被 Huge APP 下的历史记录取代，且任何修改后都应重编译。
- `confused` 已存在：它只是新增表情文档中的示例。
- 旧 HiveMQ、公开 `/mcp` 必然在线、云端已经部署或 13 个命令当前已实测：均不能由当前代码单独证明。

## 仅凭仓库无法确定，需要用户或在线环境确认

1. Cloudflare 线上 Worker 是否与 `worker7.js` 完全一致，是否存在未回存的 D1 读取修正。
2. `MCP_PATH_SECRET` 当前是否已配置；若未配置，是保持 `/mcp`、启用私密路径，还是实施正式认证。
3. `/peek` 是删除还是加认证。
4. `/report` 的 D1 写入失败是否改为非 2xx，以及 EMQX Rule 的重试策略。
5. 报告 token 是否已经轮换；何时删除固件中停用的直连 HTTPS 上报代码和常量。
6. EMQX Rule、D1 表、Worker Secrets、MCP 客户端连接和设备端固件当前是否实际在线。
7. 当前 Arduino IDE、ESP32 core 和库版本；仓库没有锁定这些依赖。
8. 最近编译占用和完整硬件验收是否仍有效；本次没有编译、上传或操作设备。
9. 是否要继续把 Wi-Fi/MQTT 凭据硬编码在固件，或另行设计安全的本地配置流程。
10. 3MF 打印时采用说明文字中的推荐参数，还是采用文件内嵌的实际切片配置；两者不完全一致。
