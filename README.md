# Clawd Mochi

Clawd Mochi 是一个 ESP32-C3 桌面表情屏项目。设备驱动一块 240×240 的 ST7789 屏幕，既能通过自身 Wi-Fi 热点和本地网页控制，也能通过 Cloudflare Worker、EMQX MQTT 和 MCP 工具远程控制。

本文以当前源码为准：

- 固件：`clawd_mochi/clawd_mochi.ino`
- Worker：`cloudflare worker/worker7.js`（文件名为 `worker7.js`，MCP 服务内部版本为 `5.0.0`）

旧文档中的部署成功、在线配置和硬件验收只能视为历史记录，不能代替重新测试。协议、路由和命令等可由源码确认的内容，以源码为最高事实来源。

## 项目结构

```text
.
├─ clawd_mochi/
│  ├─ clawd_mochi.ino              # 当前 ESP32 固件，内含本地网页
│  └─ .theia/launch.json           # 空的 IDE 启动配置
├─ cloudflare worker/
│  └─ worker7.js                    # 当前 Worker/MCP 源码
├─ AGENTS.md                        # Agent 协作边界
```

更详细的代码行为、接口和旧文档审计见 [TECHNICAL.md](TECHNICAL.md)。

## 当前功能

### 控制路径

```text
本地：手机 → ESP32 热点 → HTTP → executeCommand() → 屏幕

远程：MCP 客户端 → Worker → EMQX → command#nonce → ESP32 → 屏幕
      ESP32 → 状态 topic → EMQX HTTP 转发 → Worker /report → D1 → MCP 客户端
```

远程返回“屏幕已执行”只表示 ESP32 处理了命令并回报相同 nonce，不表示液晶像素经过物理自检。

### MCP 命令

Worker 与固件共同支持 13 个远程命令：

| 命令 | 效果 | 最终状态 |
|---|---|---|
| `blink` | 移动并眨眼 | 普通眼睛 |
| `squish` | 挤眼动画 | 保持挤眼 |
| `wink` | 单眼眨眼 | 保持单眼闭合 |
| `sleep` | 闭眼并显示 z/Z | 保持睡眠画面 |
| `angry` | 怒眼与斜眉 | 保持 |
| `sad` | 下垂眉与泪滴 | 保持 |
| `cute` | 小圆眼 | 保持 |
| `surprised` | 大圆眼与张嘴 | 保持 |
| `dead` | X 眼 | 保持 |
| `love` | 爱心眼 | 保持 |
| `happy` | `^^` 眼 | 保持 |
| `normal` | 普通眼睛 | 保持 |
| `canvas` | 画布背景 | 保持 |

固件还支持本地内部命令 `code` 和 `logo`，Worker 不会向 MCP 暴露它们。

### 本地网页

固件内嵌一个手机控制页，提供：

- 普通眼睛、挤眼、终端和 Canvas；
- 动画速度、背光和背景色；
- 画笔颜色、清屏和触摸绘图；
- 状态查询。

其余表情没有网页按钮，但可通过 `/cmd?k=<字符>` 调试，映射见“使用方法”。

## 硬件与接线

当前代码对应 ESP32-C3 Super Mini 和 ST7789 1.54 英寸 240×240 SPI 屏幕。

| ST7789 | ESP32-C3 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA / MOSI | GPIO10 |
| SCL / SCK | GPIO8 |
| RES | GPIO2 |
| DC | GPIO1 |
| CS | GPIO4 |
| BL / BLK | GPIO3 |

屏幕 VCC 使用 3V3。开发板通过 USB-C 供电；接线时先断电。

## 安装与启动

### 1. 准备 Arduino 环境

安装支持 ESP32-C3 的 Arduino 环境，以及源码直接引用的库：

- Adafruit GFX Library
- Adafruit ST7735 and ST7789 Library
- PubSubClient

如果 Arduino IDE 中找不到 ESP32-C3，可在 Additional Boards Manager URLs 中加入 Espressif 的索引：

```text
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

历史验收记录使用：

- Arduino IDE：`2.3.10`
- ESP32 core：`3.3.10`
- Board：`ESP32C3 Dev Module`
- Partition Scheme：`Huge APP (3MB No OTA/1MB SPIFFS)`
- Serial：`115200`
- Adafruit GFX：`1.12.6`
- Adafruit ST7735/ST7789：`1.11.0`
- PubSubClient：`2.8.0`

这些版本来自最后保留的环境记录，可作为重建起点，但项目没有 lockfile 或 CLI 构建配置证明它们是唯一兼容版本。换电脑后需要在 Arduino IDE 中重新选择 Board 和分区。

### 2. 配置固件

打开正式文件 `clawd_mochi/clawd_mochi.ino`，配置以下常量：

- 本地热点名称和密码；
- 家庭 2.4 GHz Wi-Fi 名称和密码；
- MQTT 主机、TLS 端口、用户名和密码。

当前固件把这些值直接写在源码中。不要把真实值复制到 README、日志、截图或补丁。运行不依赖 `MQTT.txt`；如果删除该文件，以正式源码中已有配置或用户自己的私密存储为准。

### 3. 编译和上传

1. 选择 `ESP32C3 Dev Module`、正确串口和 Huge APP 分区。
2. 编译并记录本次程序和 RAM 占用。
3. 上传固件。
4. 如果连接阶段卡住，按住 BOOT，点一下 RST；写入开始后松开 BOOT。
5. 看到 `Hash of data verified` 和 `Hard resetting via RTS pin` 才算上传结束；若没有自动启动，松开 BOOT 后只按一下 RST。
6. 上传完成后以串口日志确认启动、家庭 Wi-Fi、MQTT 连接和 topic 订阅是不同的成功阶段。

项目记录的最近一次结果为程序 1,179,449 bytes（38%）、全局变量 39,400 bytes（12%）。这是历史验收记录，本次文档整理没有重新编译。

### 4. 配置远程链路

Worker 需要以下环境变量或绑定：

| 名称 | 用途 |
|---|---|
| `EMQX_HOST` | EMQX 主机名；Worker 调用其 8443 HTTP API |
| `EMQX_API_KEY` | EMQX Deployment API Key |
| `EMQX_SECRET_KEY` | EMQX Deployment API Secret |
| `REPORT_TOKEN` | 保护 `/report` 的共享值 |
| `DB` | Cloudflare D1 数据库绑定 |
| `MCP_PATH_SECRET` | 可选；把 MCP 路径改为 `/mcp/<secret>` |

D1 需要的表：

```sql
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  at INTEGER
);
```

EMQX 侧需要：

- Worker 通过 HTTP API 向 `clawd/mochi/cmd` 发布命令，QoS 1、`retain: false`；
- ESP32 向 `clawd/mochi/state` 发布状态；
- Data Integration/Rule 把状态 payload 原样 POST 到 Worker `/report`，并带上匹配的报告 token。

历史可工作配置记录的 Rule SQL 和 Action Body 是：

```sql
SELECT payload FROM "clawd/mochi/state"
```

```text
${payload}
```

HTTP Action 指向 Worker `/report`，Header 名为 `X-Report-Token`。Cloudflare 的 `REPORT_TOKEN` 与 EMQX Action Header 的值必须一致。以上是重建参数；仓库无法证明线上当前仍这样配置。

部署 Worker 前，先从 Cloudflare 取回线上代码并与磁盘 `worker7.js` 比较。现有文件不能证明线上是否有额外修正或是否启用了私密 MCP 路径。

### 5. 启动

1. 给设备通电。
2. 本地使用时，启动信息页会显示热点名、热点密码和地址；连接该热点并打开 `http://192.168.4.1`。
3. 远程使用时，等待串口明确显示家庭 Wi-Fi 已连接、MQTT 已连接并订阅 `clawd/mochi/cmd`。
4. 在 MCP 客户端中配置当前实际生效的 Worker MCP URL，并调用 `clawd_command`。

## 配置项

| 配置 | 当前来源 | 说明 |
|---|---|---|
| 屏幕尺寸和 GPIO | 固件常量 | 240×240；引脚见接线表 |
| AP/STA Wi-Fi | 固件常量 | 设备同时开启 AP 和 STA |
| MQTT 连接 | 固件常量 | TLS 8883；当前使用 `setInsecure()` |
| MQTT Client ID | 固件调用参数 | 当前固定；相同固件设备会互相顶掉 |
| 命令 topic | 固件与 Worker | `clawd/mochi/cmd` |
| 状态 topic | 固件 | `clawd/mochi/state` |
| MCP 命令表 | Worker `COMMANDS` | 13 个命令 |
| D1 表和键 | Worker SQL/常量 | `state` 表，保存一条最新状态 |
| MCP 路径 | Worker 环境变量 | 默认 `/mcp`，可选私密子路径 |
| Arduino Board/分区 | IDE 外部设置 | 项目未提供可复现的 CLI 构建配置 |

## 使用方法

### 本地网页

打开 `http://192.168.4.1` 使用页面控件。扩展表情调试地址如下：

| 字符 | 命令 |
|---|---|
| `w` | `blink` |
| `s` | `squish` |
| `d` | `code` |
| `a` | `logo` |
| `e` | `wink` |
| `f` | `sleep` |
| `g` | `angry` |
| `h` | `sad` |
| `i` | `cute` |
| `j` | `dead` |
| `l` | `love` |
| `m` | `surprised` |
| `n` | `happy` |

示例：`http://192.168.4.1/cmd?k=l`。

`/cmd` 的 `{"ok":1}` 只表示路由接受了请求。代码会在执行前就返回 HTTP 200，未知字符也不会返回错误，因此仍需观察屏幕或串口。终端模式下只有 `q` 会退出终端，其他 `/cmd` 字符不会执行表情。

### MCP

调用工具 `clawd_command`，参数示例：

```json
{
  "command": "love"
}
```

结果语义：

- “屏幕已执行”：D1 中出现同 nonce 且 `ok=1` 的状态；
- “设备收到了但不认识命令”：同 nonce 且 `ok=0`；
- “已发出，没等到设备确认”：发布成功，但约 3 秒内没有读到匹配 nonce。

## 已知限制

- 线上 Worker、D1、EMQX Rule、MCP 路径和实际硬件状态无法仅凭仓库确认。
- MQTT TLS 使用 `setInsecure()`，流量加密但不验证服务器证书。
- Wi-Fi、MQTT 和停用上报代码中的敏感值硬编码在固件里。
- `/peek` 无认证，可读取最后状态。
- `/report` 在 D1 写入失败时仍返回 HTTP 200。
- Worker 没有显式超时、限流、Origin 校验或正式身份验证；私密路径只是一种能力型地址。
- Worker 检查 command，但没有检查 `tools/call.params.name` 是否为 `clawd_command`。
- 本地 HTTP 控制路由没有第二层认证，而且状态修改使用 GET。
- 固件使用固定 MQTT Client ID；两块相同固件不能同时在线。
- 动画使用阻塞式 `delay()`；执行期间 HTTP/MQTT 响应能力有限。
- 状态确认只能证明软件处理和回报，不能检测屏幕像素或供电质量。
- 固件保留一套已停用的 ESP32 直连 Worker HTTPS 上报代码及相关敏感常量。
- 项目没有自动化测试、可复现构建脚本或持续集成；编译、上传和端到端验收需要人工完成。
- `clawd_mochi.3mf` 的说明文字、推荐参数和内嵌切片配置并不完全一致，打印前应以实际切片预览为准。

## 常见故障

| 现象 | 优先检查 |
|---|---|
| 本地 `192.168.4.1` 也打不开 | 供电、USB 线、设备是否启动、手机是否仍连接设备热点；先不要改云端 |
| 某个充电宝下经常失联 | 低电流自动关机或输出不稳；换电脑 USB 或可靠电源 |
| 上传卡在 `Connecting...` | 按住 BOOT、点一下 RST，开始写入后松开 BOOT |
| 上传成功但没有启动 | 松开 BOOT，只点一下 RST |
| 屏幕黑屏 | 断电检查 VCC→3V3、GND→GND、BLK→GPIO3 |
| 本地返回 `ok` 但屏幕不动 | 检查字符映射、终端模式，以及 Arduino IDE 上传的是否为正式固件 |
| MQTT 状态码 `5` | MQTT 客户端认证错误；不要把 Deployment API Key 当作设备密码 |
| MQTT 状态码 `-4` 或 `-2` | 检查家庭 Wi-Fi、DNS、MQTT 主机、端口和网络超时 |
| 本地正常、远程无命令日志 | 等待 MQTT 已订阅，再查 Worker、EMQX、topic 和 MCP 客户端 |
| 串口收到命令但屏幕不动 | 检查 `executeCommand()`、VIEW 和对应绘制/动画函数 |
| 屏幕变化但没有设备确认 | 依次检查 `publishState()` 日志、EMQX Rule、`/report`、D1 |
| EMQX Rule Success 但 D1 不更新 | 当前 `/report` 写库失败仍可能返回 200；查看 Worker 日志 |
| 确认总是晚一条 | 先比较 Cloudflare 线上 Worker 与磁盘 `worker7.js`，尤其是 D1 读取实现 |
| 改背景后表情消失 | 当前表情缺独立 VIEW 或 `routeRedraw()` 分支 |
| MCP 客户端看不到新命令 | 确认 Worker 已 Deploy，并让客户端重新读取工具 schema |

排障顺序保持为：本地供电/热点 → 家庭 Wi-Fi → MQTT 连接与订阅 → Worker 发布 → ESP32 执行 → 状态回报 → EMQX Rule → D1 → MCP 返回。不要因为单次失败就重建整套云端。

## 修改后的最低验收

- 编译和上传分别成功，并记录空间占用；
- 串口分别确认 Wi-Fi、MQTT 和订阅成功；
- 本地网页、终端、Canvas、速度、背光和绘图无回归；
- 静态表情能保持，`normal` 能恢复，改背景色后按当前 VIEW 重绘；
- 远程命令带 `command#nonce`，状态回报相同 nonce；
- 在线调用返回“屏幕已执行”；设备断电后返回“没等到设备确认”；
- Worker `COMMANDS` 与固件远程命令一致；
- 工具 schema 改变后，MCP 客户端已重新读取工具列表。
