# Clawd Mochi 项目协作说明

开始工作时读取磁盘当前文件。

## 1. 按任务阅读

先读本文件，再读取本次任务涉及的当前源码：

- 修改固件、屏幕效果或本地网页：`clawd_mochi/clawd_mochi.ino`；
- 修改 Worker、Claude 命令或状态确认：`cloudflare worker/worker7.js`；
- 理解、安装、启动或日常使用：`README.md`；
- 新增表情、排障、验收、协议或安全处理：`TECHNICAL.md`。

简单修改不要求读完所有文档；涉及固件和 Worker 的任务必须同时核对两份源码。

中文文件按 UTF-8 读取。修改固件前重新读取磁盘版本，防止 Arduino IDE 中的旧内容覆盖正式文件。

## 2. 当前基线（2026-08-09）

- 硬件：ESP32-C3 Super Mini + ST7789 1.54 英寸 240×240；
- 固件：`clawd_mochi/clawd_mochi.ino`；
- Worker：`cloudflare worker/worker7.js`，源码内部版本 5.0.0；
- Claude 工具：`clawd_command`；
- 下行 topic：`clawd/mochi/cmd`；
- 状态 topic：`clawd/mochi/state`；
- Claude 命令：`blink`、`squish`、`wink`、`sleep`、`angry`、`sad`、`cute`、`surprised`、`dead`、`love`、`happy`、`normal`、`canvas`；
- `code` 和 `logo` 仅供本地使用；
- 编译设置：`ESP32C3 Dev Module`、`Huge APP (3MB No OTA/1MB SPIFFS)`；
- 最近记录：程序 1179449 bytes（38%），全局变量 39400 bytes（12%）；
- 恢复点：`backup/backup-20260809-state-report-d1-doc-sync/`（**这份 checkout 里没有，在原机器上**）。

当前版本已实现统一 `executeCommand()`、独立 VIEW、`routeRedraw()`、`command#nonce` 和 `publishState()`。新静态表情保持到其他命令覆盖。

## 3. 控制链路

```text
本地：
手机 → ESP32 HTTP → executeCommand() → 屏幕

远程：
Claude → Worker → EMQX → command#nonce → ESP32 → 屏幕
ESP32 → clawd/mochi/state → EMQX Rule → Worker /report → D1 → Claude
```

“屏幕已执行”表示 ESP32 已处理命令并回报相同 nonce，不代表液晶像素经过物理自检。没有匹配确认时必须返回“已发出，没等到设备确认”。

## 4. 修改规则

**⚠️ 保持单文件结构。** 固件代码全部留在 `clawd_mochi/clawd_mochi.ino` 一个文件里，
不要为了"整理"拆成多个 `.cpp` / `.h`。这是[原项目](https://github.com/yousifamanuel/clawd-mochi)
作者在 Contributing 里明确请求的，理由是让新手能直接打开烧录。
凭据是唯一的例外——它们必须留在 `secrets.h`，那是安全要求。

### 只改固件效果

1. 备份正式 `.ino`；
2. 最小修改；
3. 用 Huge APP 编译并记录空间；
4. 上传后检查完整成功日志；
5. 串口 115200 验证 Wi-Fi、MQTT、订阅和状态回报；
6. 命令名未变时不改 Worker、不重连 MCP。

### 新增或改名 Claude 命令

1. 先让 ESP32 支持并本地测试该命令；
2. 新增静态表情时，再增加独立 VIEW、绘制、动画、`executeCommand()`、`routeRedraw()` 和本地测试字符；
3. 编译、上传、本地验收；
4. 更新 Worker 的 `COMMANDS` 和工具描述；
5. 保留 nonce、`publishState()`、`/report` 和 D1 链路；
6. Deploy 后重新添加连接器；
7. 验证在线成功和设备断电超时。

部署 Worker 前必须先比较 Cloudflare 在线源码与磁盘 `worker7.js`，不能盲目覆盖线上可工作版本。

## 5. 当前待办

- 确认线上是否启用 `MCP_PATH_SECRET`；
- 删除或保护公开的 `/peek`；
- 让 `/report` 在 D1 写入失败时返回非 2xx；
- 状态回程稳定后轮换 REPORT_TOKEN，并删除固件中停用的直接 HTTPS 上报代码；
- 以后再考虑证书验证、限流、Origin 校验和多设备。

## 6. 安全与协作

- 不泄露 Wi-Fi、MQTT、API、REPORT_TOKEN 或 MCP 私密路径；
- 不把 EMQX Deployment API Key 当作 MQTT 客户端密码；
- 不无故重建 EMQX、D1、Worker 或连接器；
- 不为整理代码大范围重写；
- 一次只让用户执行一个清晰步骤，区分编译、上传、联网、MQTT、状态回报和 Claude 确认；
- 两块使用相同固件的板子不要同时联网，固定 Client ID 会互相顶掉；
- 本地网页也打不开时先查供电、启动和热点，不要先改云端。

## 7. 最低验收

- 正式文件和恢复点已保存；
- 编译、上传、Wi-Fi、MQTT、订阅分别通过；
- 本地网页和原有功能无回归；
- 表情能保持，`normal` 能恢复，改背景后正确重绘；
- 串口收到 `command#nonce` 并回报相同 nonce；
- Claude 在线返回“屏幕已执行”，设备断电返回“没等到设备确认”；
- Worker `COMMANDS` 与 ESP32 的 Claude 命令一致；
- schema 改变后连接器已重新读取工具列表。

> **一条贯穿全文的原则：**
> 旧文档中的部署成功、在线配置和硬件验收只能视为历史记录，不能代替重新测试。
> 协议、路由和命令等可由源码确认的内容，**以源码为最高事实来源**。