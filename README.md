# Clawd Mochi Remote

一只放在桌上的 ESP32 表情屏小螃蟹🦀。手机连它的热点就能点表情，也能从地球另一端通过 MCP 让它眨眼。

> **来源与许可**
>
> 本项目基于 [yousifamanuel/clawd-mochi](https://github.com/yousifamanuel/clawd-mochi) 修改而来，
> 原作者 Yousuf Amanuel，代码以 MIT 许可证发布，完整文本见 [LICENSE](LICENSE)。
>
> 相对原项目「设备热点 + 本地网页」的控制方式，本版本增加了由 Cloudflare Worker、
> EMQX MQTT 和 MCP 工具组成的远程控制链路。
>
> 原项目的 3D 模型与媒体资源采用 CC BY-NC-SA 4.0（署名 / 非商业 / 相同方式共享）。 
>资源地址：https://makerworld.com/en/models/2559505-clawd-mochi-physical-claude-code-mascot#profileId-2820000 
>
> Clawd 是 Anthropic 的 Claude Code 吉祥物。本项目是独立的粉丝作品，
> 不隶属于 Anthropic，也未获其赞助或认可。

---

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
  - [1. 硬件与接线](#1-硬件与接线)
  - [2. 准备 Arduino 环境](#2-准备-arduino-环境)
  - [3. 配置并烧录固件](#3-配置并烧录固件)
  - [4. 配置远程链路（可选）](#4-配置远程链路可选)
  - [5. 启动](#5-启动)
- [使用](#使用)
  - [本地网页](#本地网页)
  - [MCP 远程调用](#mcp-远程调用)
- [命令表](#命令表)
- [配置参考](#配置参考)
- [自定义](#自定义)
- [安全须知](#安全须知)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [修改后的最低验收](#修改后的最低验收)
- [项目结构与文档](#项目结构与文档)

---

## 这是什么

**成本 ~$6–8 · 组装约 1 小时 · 难度：新手friendly**

设备是一块 ESP32-C3 驱动的 240×240 ST7789 屏幕，显示一只会做表情的小螃蟹。它有两条控制路径：

```text
本地：手机 → ESP32 热点 → HTTP → executeCommand() → 屏幕

远程：MCP 客户端 → Worker → EMQX → command#nonce → ESP32 → 屏幕
      ESP32 → 状态 topic → EMQX HTTP 转发 → Worker /report → D1 → MCP 客户端
```

**本地**不需要任何云服务，连上设备自己发的热点，打开网页就能用。

**远程**要额外部署 Cloudflare Worker、EMQX 和 D1，好处是可以从任何地方控制，并且拿得到执行确认。

> ⚠️ 远程返回「屏幕已执行」只表示 ESP32 处理了命令并回报了相同 nonce，
> 不表示液晶像素经过物理自检。

---

## 快速开始

### 1. 硬件与接线

**物料清单**

| 部件 | 规格 | 参考价 |
|---|---|---|
| ESP32-C3 Super Mini | 带 Wi-Fi 的微控制器 | ~$2.50 |
| ST7789 1.54" TFT | 240×240 SPI 彩色屏 | ~$3.00 |
| 杜邦线 8 根 | 8–10 cm | ~$0.50 |
| M2×6mm 螺丝 ×2 | 固定屏幕压边 | ~$0.10 |
| 双面胶 | 固定壳内元件 | ~$0.10 |
| USB-C 线 | 供电 | — |
| 3D 打印外壳 | PLA 或 PETG，约 30g | ~$0.50 |

**合计 ~$7–8。**


**接线**

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

屏幕 VCC 使用 3V3，开发板通过 USB-C 供电。**接线时先断电。**

### 2. 准备 Arduino 环境

安装支持 ESP32-C3 的 Arduino 环境，以及源码直接引用的三个库：

- Adafruit GFX Library
- Adafruit ST7735 and ST7789 Library
- PubSubClient

如果 Arduino IDE 里找不到 ESP32-C3，在 Additional Boards Manager URLs 中加入 Espressif 的索引：

```text
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

<details>
<summary>历史验收使用的版本组合（可作为重建起点）</summary>

- Arduino IDE：`2.3.10`
- ESP32 core：`3.3.10`
- Board：`ESP32C3 Dev Module`
- Partition Scheme：`Huge APP (3MB No OTA/1MB SPIFFS)`
- Serial：`115200`
- Adafruit GFX：`1.12.6`
- Adafruit ST7735/ST7789：`1.11.0`
- PubSubClient：`2.8.0`

这些版本来自最后保留的环境记录。项目没有 lockfile 或 CLI 构建配置，
不能证明它们是唯一兼容的版本组合。换电脑后需要在 IDE 里重新选择 Board 和分区。

</details>

### 3. 配置并烧录固件

凭据不写在固件里。把 `clawd_mochi/secrets.h.example` 复制成 `secrets.h`，填入自己的值：

- 本地热点名称和密码
- 家庭 2.4 GHz Wi-Fi 名称和密码
- MQTT 主机、用户名和密码（TLS 端口 8883 写在固件里）
- 上报地址与 token（仅停用的直连上报路径需要）

固件顶部 `#include "secrets.h"` 读取它们。



烧录步骤：

1. 选择 `ESP32C3 Dev Module`、正确串口和 Huge APP 分区。
2. 编译，记录本次程序和 RAM 占用。
3. 上传固件。
4. 如果卡在 `Connecting...`：按住 BOOT，点一下 RST，写入开始后松开 BOOT。
5. 看到 `Hash of data verified` 和 `Hard resetting via RTS pin` 才算结束；
   若没有自动启动，松开 BOOT 后只点一下 RST。
6. 用串口日志逐个确认：启动、家庭 Wi-Fi、MQTT 连接、topic 订阅
   ——**这是四个不同的阶段，不要合并判断。**



### 4. 配置远程链路（可选）

只用本地控制的话，这一步可以跳过。

**Worker 需要的环境变量与绑定：**

| 名称 | 用途 |
|---|---|
| `EMQX_HOST` | EMQX 主机名；Worker 调用其 8443 HTTP API |
| `EMQX_API_KEY` | EMQX Deployment API Key |
| `EMQX_SECRET_KEY` | EMQX Deployment API Secret |
| `REPORT_TOKEN` | 保护 `/report` 和 `/peek` 的共享值 |
| `DB` | Cloudflare D1 数据库绑定 |
| `MCP_PATH_SECRET` | 可选；把 MCP 路径改为 `/mcp/<secret>` |

**D1 建表：**

```sql
CREATE TABLE IF NOT EXISTS state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  at INTEGER
);
```

**EMQX 侧：**

- Worker 通过 HTTP API 向 `clawd/mochi/cmd` 发布命令，QoS 1、`retain: false`
- ESP32 向 `clawd/mochi/state` 发布状态
- Data Integration / Rule 把状态 payload 原样 POST 到 Worker `/report`，并带上匹配的 token

历史可工作配置记录的 Rule SQL 与 Action Body：

```sql
SELECT payload FROM "clawd/mochi/state"
```

```text
${payload}
```

HTTP Action 指向 Worker `/report`，Header 名为 `X-Report-Token`。
Cloudflare 的 `REPORT_TOKEN` 与 EMQX Action Header 的值必须一致。


### 5. 启动

1. 给设备通电。
2. **本地使用**：启动信息页会显示热点名、密码和地址；连接该热点，打开 `http://192.168.4.1`。
3. **远程使用**：等待串口明确显示家庭 Wi-Fi 已连接、MQTT 已连接、并已订阅 `clawd/mochi/cmd`。
4. 在 MCP 客户端中配置当前实际生效的 Worker MCP URL，调用 `clawd_command`。

---

## 使用

### 本地网页

打开 `http://192.168.4.1`，页面提供：

- 普通眼睛、挤眼、终端和 Canvas
- 动画速度、背光和背景色
- 画笔颜色、清屏和触摸绘图
- 状态查询

其余表情没有按钮，可通过 `/cmd?k=<字符>` 调试：

| 字符 | 命令 | | 字符 | 命令 |
|---|---|---|---|---|
| `w` | `blink` | | `i` | `cute` |
| `s` | `squish` | | `j` | `dead` |
| `d` | `code` | | `l` | `love` |
| `a` | `logo` | | `m` | `surprised` |
| `e` | `wink` | | `n` | `happy` |
| `f` | `sleep` | | | |
| `g` | `angry` | | | |
| `h` | `sad` | | | |

示例：`http://192.168.4.1/cmd?k=l`


### MCP 远程调用

调用工具 `clawd_command`：

```json
{
  "command": "love"
}
```

返回语义：

| 返回 | 含义 |
|---|---|
| 屏幕已执行 | D1 中出现同 nonce 且 `ok=1` 的状态 |
| 设备收到了但不认识命令 | 同 nonce 且 `ok=0` |
| 已发出，没等到设备确认 | 发布成功，但约 3 秒内没读到匹配 nonce |

---

## 命令表

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

固件另有本地内部命令 `code` 和 `logo`，Worker 不会向 MCP 暴露它们。

---

## 配置参考

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

---

## 自定义

以下常量都在 `clawd_mochi/clawd_mochi.ino` 顶部，改完重新编译上传即可。

**眼睛几何**

| 常量 | 默认 | 含义 |
|---|---|---|
| `EYE_W` | 30 | 眼睛宽度 |
| `EYE_H` | 60 | 眼睛高度 |
| `EYE_GAP` | 120 | 两眼间距（中心到中心） |
| `EYE_OX` | 0 | 整体水平偏移 |
| `EYE_OY` | 40 | 整体上移量（从画面中心往上减） |

**动画与显示**

| 变量 | 默认 | 含义 |
|---|---|---|
| `animSpeed` | 1 | 动画速度：1=慢（默认）／2=正常／3=快 |
| `animBgColor` | 0 | 表情与 logo 动画的背景色 |
| `drawBgColor` | 0 | 画板背景色 |
| `backlightOn` | true | 背光开关 |

**终端模式布局**

| 常量 | 默认 |
|---|---|
| `TERM_COLS` | 15 |
| `TERM_ROWS` | 8 |
| `TERM_CHAR_W` | 12 |
| `TERM_CHAR_H` | 20 |
| `TERM_PAD_X` | 8 |
| `TERM_PAD_Y` | 18 |

**引脚**：`TFT_CS` / `TFT_DC` / `TFT_RST` / `TFT_BLK`，默认值见上面的[接线表](#1-硬件与接线)。

**配色**：`C_ORANGE` / `C_DARKBG` / `C_MUTED` / `C_GREEN` 在初始化时赋值，
`C_WHITE` 和 `C_BLACK` 直接取自库常量。

---

## 安全须知

**部署到公网前请读完这一节。**

- **凭据集中在 `secrets.h`，不进版本库。** Wi-Fi、MQTT 和上报凭据都走
  `SECRET_*` 宏，该文件已被 `.gitignore` 排除，仓库里只留 `secrets.h.example` 模板。
  用压缩包或网盘分享前先确认。
- **MQTT TLS 不验证证书。** 当前用 `setInsecure()`，流量加密但不校验服务器身份，
  可被中间人攻击。
- **Worker 没有正式身份验证。** 没有显式超时、限流或 Origin 校验；
  `MCP_PATH_SECRET` 只是一种「能力型地址」——知道路径就能用。
- **Worker 不校验工具名。** 它检查 `command` 的合法性，但没有检查
  `tools/call.params.name` 是否为 `clawd_command`。
- **本地 HTTP 控制没有第二层认证**，而且状态修改使用 GET 请求。
  任何连上设备热点的人都能控制屏幕。

---

## 已知限制

- 线上 Worker、D1、EMQX Rule、MCP 路径和实际硬件状态无法仅凭仓库确认。
- 固件使用固定 MQTT Client ID；两块相同固件的板子不能同时在线，会互相顶掉。
- 动画使用阻塞式 `delay()`；执行期间 HTTP/MQTT 响应能力有限。
- 状态确认只能证明软件处理和回报，不能检测屏幕像素或供电质量。
- 固件保留了一套已停用的 ESP32 直连 Worker HTTPS 上报代码（凭据同样走 `secrets.h`）。
- 项目没有自动化测试、可复现构建脚本或持续集成；
  编译、上传和端到端验收需要人工完成。


---

## 故障排查

**排障顺序**：

```text
本地供电/热点 → 家庭 Wi-Fi → MQTT 连接与订阅 → Worker 发布
→ ESP32 执行 → 状态回报 → EMQX Rule → D1 → MCP 返回
```

| 现象 | 优先检查 |
|---|---|
| 本地 `192.168.4.1` 也打不开 | 供电、USB 线、设备是否启动、手机是否仍连着设备热点；**先不要改云端** |
| 某个充电宝下经常失联 | 低电流自动关机或输出不稳；换电脑 USB 或可靠电源 |
| 上传卡在 `Connecting...` | 按住 BOOT、点一下 RST，开始写入后松开 BOOT |
| 上传成功但没有启动 | 松开 BOOT，只点一下 RST |
| 屏幕黑屏 | 断电检查 VCC→3V3、GND→GND、BLK→GPIO3 |
| 本地返回 `ok` 但屏幕不动 | 检查字符映射、终端模式，以及 IDE 上传的是否为正式固件 |
| MQTT 状态码 `5` | MQTT 客户端认证错误；**不要把 Deployment API Key 当作设备密码** |
| MQTT 状态码 `-4` 或 `-2` | 检查家庭 Wi-Fi、DNS、MQTT 主机、端口和网络超时 |
| 本地正常、远程无命令日志 | 等待 MQTT 已订阅，再查 Worker、EMQX、topic 和 MCP 客户端 |
| 串口收到命令但屏幕不动 | 检查 `executeCommand()`、VIEW 和对应绘制/动画函数 |
| 屏幕变化但没有设备确认 | 依次检查 `publishState()` 日志、EMQX Rule、`/report`、D1 |
| EMQX Rule Success 但 D1 不更新 | 查看 Worker 日志（`/report` 写库失败现在返回 503） |
| 确认总是晚一条 | 先比较 Cloudflare 线上 Worker 与磁盘 `worker7.js`，尤其是 D1 读取实现 |
| 改背景后表情消失 | 当前表情缺独立 VIEW 或 `routeRedraw()` 分支 |
| MCP 客户端看不到新命令 | 确认 Worker 已 Deploy，并让客户端重新读取工具 schema |

## 修改后的最低验收

- 编译和上传分别成功，并记录空间占用
- 串口分别确认 Wi-Fi、MQTT 和订阅成功
- 本地网页、终端、Canvas、速度、背光和绘图无回归
- 静态表情能保持，`normal` 能恢复，改背景色后按当前 VIEW 重绘
- 远程命令带 `command#nonce`，状态回报相同 nonce
- 在线调用返回「屏幕已执行」；设备断电后返回「没等到设备确认」
- Worker `COMMANDS` 与固件远程命令一致
- 工具 schema 改变后，MCP 客户端已重新读取工具列表

---

## 项目结构与文档

```text
.
├─ clawd_mochi/
│  ├─ clawd_mochi.ino          # ESP32 固件，内含本地网页
│  └─ .theia/launch.json       # 空的 IDE 启动配置
├─ cloudflare worker/
│  └─ worker7.js               # Worker / MCP 源码（内部版本 5.0.0）
├─ AGENTS.md                   # Agent 协作边界
├─ TECHNICAL.md                # 详细代码行为、接口与旧文档审计
├─ LICENSE                     # MIT
└─ README.md                   # 本文件
```

| 文档 | 什么时候看 |
|---|---|
| README.md | 安装、使用、排障 |
| [TECHNICAL.md](TECHNICAL.md) | 需要知道代码具体怎么跑、接口细节 |
| [AGENTS.md](AGENTS.md) | 让 AI 协作修改本项目之前 |
