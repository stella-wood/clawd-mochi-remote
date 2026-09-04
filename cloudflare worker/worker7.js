// Clawd Mochi MCP Server v5 — 2026-08-08
//
// 相对 v4 的唯一改动：状态存储从 KV 换成 D1。
//
// 为什么换：KV 是边缘缓存，读到"key不存在"时会把这个结果缓存最长 60 秒。
//           我们的用法是"写完立刻读"，正好是 KV 最不擅长的。
//           D1 是 SQLite，强一致，写完立刻读得到。
//
// 链路（没变）：
//   去：Claude → Worker → EMQX → ESP32
//   回：ESP32 → clawd/mochi/state → EMQX规则 → Worker(/report) → D1
//
// 需要的绑定：
//   D1 Database   变量名 DB      （表 state，见文档）
//   Secret        REPORT_TOKEN
//   Secret        MCP_PATH_SECRET（可选）
//   已有          EMQX_HOST / EMQX_API_KEY / EMQX_SECRET_KEY
//
// KV 绑定留着不用管，代码里已经不碰它了。

const CMD_TOPIC = 'clawd/mochi/cmd';
const ROW_KEY   = 'last_state';

const COMMANDS = [
  'blink', 'squish', 'wink', 'sleep', 'angry', 'sad', 'cute',
  'surprised', 'dead', 'love', 'happy', 'normal', 'canvas'
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function publishMQTT(env, topic, message) {
  const resp = await fetch(`https://${env.EMQX_HOST}:8443/api/v5/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${env.EMQX_API_KEY}:${env.EMQX_SECRET_KEY}`)
    },
    body: JSON.stringify({ topic, payload: message, qos: 1, retain: false })
  });
  return { ok: resp.ok, status: resp.status };
}

async function readState(env) {
  const row = await env.DB
    .prepare('SELECT v, at FROM state WHERE k = ?')
    .bind(ROW_KEY)
    .first();
  if (!row || !row.v) return null;
  let parsed;
  try { parsed = JSON.parse(row.v); } catch { parsed = { _raw: row.v }; }
  // _at 用下划线开头，跟设备自己上报的字段区分开，避免哪天设备也叫 at 就撞了
  return { ...parsed, _at: row.at };
}

// 固件里 view 是 0–12 的数字（见 clawd_mochi.ino 的 #define VIEW_*），
// 直接把数字回给 Claude 没法读，这里翻成人话。
// ⚠️ 这张表必须和固件的 VIEW_* 一一对应，改固件的时候记得回来对一遍。
//    注意 3 在固件里叫 VIEW_DRAW，对外的命令名却是 canvas，
//    两边名字不一样是历史原因，不要"顺手"改齐。
const VIEW_NAMES = {
  0: 'normal(普通眼睛)',  1: 'squish(眯眼)',    2: 'code(终端)',
  3: 'canvas(画板)',      4: 'wink(单眼眨)',    5: 'sleep(睡觉)',
  6: 'angry(生气)',       7: 'sad(难过)',       8: 'cute(呆萌)',
  9: 'dead(翻白眼)',     10: 'love(爱心眼)',   11: 'surprised(惊讶)',
 12: 'happy(开心)'
};

// body.id 在 fetch 作用域里，这里当参数收，免得依赖闭包
function textResult(id, text) {
  return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
}

function fmtUptime(ms) {
  if (typeof ms !== 'number') return '未知';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${s % 60}秒`;
}

// live=true 表示这是探针刚刚问回来的；false 表示只是数据库里躺着的旧记录。
// 这两件事必须在文案上分得清 —— 设备断电三天，数据库照样能查到三天前那条。
function formatState(st, live) {
  const view = VIEW_NAMES[st.view] ?? `未知(${st.view})`;
  const head = live ? '🦀 在线' : '📄 最后记录';
  let out = `${head}\n当前画面：${view}\n设备已开机：${fmtUptime(st.up)}\n最后执行的命令：${st.cmd || '未知'}`;
  if (!live && st._at) {
    const ago = Math.floor((Date.now() - st._at) / 1000);
    out += `\n这条记录写于 ${ago} 秒前`;
  }
  return out;
}

async function waitForDevice(env, nonce, tries = 12, gap = 250) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    await sleep(gap);
    try {
      const st = await readState(env);
      if (st) {
        last = st;
        if (st.nonce === nonce) return { state: st, diag: '' };
      }
    } catch (e) {
      return { state: null, diag: `读D1异常 · ${String(e).slice(0, 200)}` };
    }
  }
  return {
    state: null,
    diag: last
      ? `D1里最后一条是 ${JSON.stringify(last).slice(0, 150)}（nonce不匹配）`
      : 'D1表里是空的 — /report 没被调到，或写入失败'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── ① 设备上报入口（EMQX 规则 POST 到这里）─────────
    if (request.method === 'POST' && url.pathname === '/report') {
      const token = request.headers.get('X-Report-Token') || '';
      if (!env.REPORT_TOKEN || token !== env.REPORT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }

      const raw = await request.text();
      try {
        await env.DB
          .prepare(`INSERT INTO state (k, v, at) VALUES (?, ?, ?)
                    ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at`)
          .bind(ROW_KEY, raw, Date.now())
          .run();
      } catch (e) {
        // ⚠️ 写失败必须返回非 2xx。
        //    以前这里返回 200，理由写的是"避免 EMQX 反复重试"——代价是失败被咽掉：
        //    EMQX 以为写成功了，D1 里其实什么都没有，而 MCP 那头只会说
        //    "没等到设备确认"，分不出是数据库挂了还是设备真没回。
        //    坏了不吭声，比坏了更糟。
        //    EMQX 会因此重试，这正是我们要的：一台表情屏的 QPS 极低，打不爆任何东西。
        return new Response('db error: ' + String(e).slice(0, 200), { status: 503 });
      }
      return new Response('ok', { status: 200 });
    }

    // ── ② 调试用：直接看 D1 里存的是什么 ────────────────
    //    ⚠️ 要带 X-Report-Token（跟 /report 同一个凭据）。
    //       以前这里是全公开的：知道地址就能读到设备状态。
    if (request.method === 'GET' && url.pathname === '/peek') {
      const token = request.headers.get('X-Report-Token') || '';
      if (!env.REPORT_TOKEN || token !== env.REPORT_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const st = await readState(env);
        return json({ state: st });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ── ③ MCP ─────────────────────────────────────────
    const secret  = env.MCP_PATH_SECRET || '';
    const mcpPath = secret ? `/mcp/${secret}` : '/mcp';

    if (request.method === 'POST' && url.pathname === mcpPath) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
      }

      if (body.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: body.id, result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'clawd-mochi', version: '5.0.0' }
        }});
      }

      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }

      if (body.method === 'tools/list') {
        return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{
          name: 'clawd_status',
          description: '查看桌面小螃蟹 Clawd Mochi 的当前状态。默认会发一条不改变屏幕显示的探针来确认设备此刻是否在线；probe=false 时只读最后一次记录，不打扰设备。',
          inputSchema: { type: 'object', properties: {
            probe: { type: 'boolean', description: '是否主动探测设备是否在线。默认 true。' }
          } }
        }, {
          name: 'clawd_say',
          description: '在 Clawd Mochi 的屏幕上显示一句话。目前只支持 ASCII 字符（英文、数字、标点），中文暂不支持，会被自动丢弃。屏幕一行 15 个字符，超出自动折行，超过 8 行自动上滚。',
          inputSchema: { type: 'object', properties: {
            text: { type: 'string', description: '要显示的文字，ASCII only，建议不超过 100 个字符' }
          }, required: ['text'] }
        }, {
          name: 'clawd_command',
          description: '控制桌面小螃蟹Clawd Mochi。指令:blink(眨眼)、squish(眯眼><)、wink(单眼眨眼)、sleep(睡觉zzz)、angry(生气)、sad(难过)、cute(呆萌圆眼)、surprised(惊讶张嘴)、dead(翻白眼X)、love(爱心眼)、happy(开心^^)、normal(普通眼睛)、canvas(画板)。返回结果会区分「屏幕已执行」和「已发出但设备未确认」。',
          inputSchema: { type: 'object', properties: {
            command: { type: 'string', enum: COMMANDS }
          }, required: ['command'] }
        }]}});
      }

      if (body.method === 'tools/call') {
        // ⚠️ 以前这里假定只有一个工具，直接就去取 arguments.command。
        //    加了第二个工具之后必须先按 name 分派，否则调 status 会掉进
        //    command 的校验里报"不支持的 command"。
        //    新工具在前面各自 return，下面 clawd_command 的原有逻辑一行未动。
        const toolName = body.params?.name || '';

        if (toolName === 'clawd_status') {
          const probe = body.params?.arguments?.probe !== false;   // 默认 true

          if (!probe) {
            const st = await readState(env);
            return textResult(body.id, st ? formatState(st, false) : '数据库里没有任何记录。');
          }

          // 探针的意义：D1 里存的是"最后一次执行命令时"写的，不是"现在"。
          // 设备断电三天，去查数据库照样能查到三天前那条，看起来一切正常。
          // 所以要主动发一条 ping —— 它不动屏幕，但会照常触发 publishState，
          // 把此刻真实的 view 和 millis() 带回来。
          const nonce = Math.random().toString(36).slice(2, 10);
          const pub = await publishMQTT(env, CMD_TOPIC, `ping#${nonce}`);
          if (!pub.ok) {
            return textResult(body.id, `❌ 探针发不出去（EMQX HTTP ${pub.status}）。这说明问题在云端到 broker 这一段，不是设备。`);
          }

          const { state, diag } = await waitForDevice(env, nonce);
          if (state) return textResult(body.id, formatState(state, true));

          const last = await readState(env);
          let text = '⚠️ 探针发出去了，3 秒内没等到回应。设备可能断电、掉线，或者 MQTT 连接断了。\n';
          text += last
            ? `\n数据库里最后一条记录：${formatState(last, false)}`
            : '\n数据库里没有任何记录 —— /report 从来没被调到过，或者写入一直在失败。';
          text += `\n[诊断] ${diag}`;
          return textResult(body.id, text);
        }

        if (toolName === 'clawd_say') {
          const text = String(body.params?.arguments?.text || '');

          // ⚠️ 过滤必须在这里做，不能指望固件丢弃。
          //    termAddChar 只收 32..126，UTF-8 的中文是多字节，逐字节喂进去
          //    只是被逐个丢掉，不会崩 —— 但那是一次沉默的失败：
          //    调用方看到"发出去了"，屏幕上什么都没有，没人知道为什么。
          //    在入口挡住，并且明确说丢了多少个，才是一条能读懂的反馈。
          const filtered = text.replace(/[^\x20-\x7E\n]/g, '');
          const dropped  = [...text].length - [...filtered].length;

          if (!filtered) {
            return textResult(body.id, '⚠️ 过滤之后没有内容了。目前只支持 ASCII，中文还没做。');
          }
          if (filtered.length > 200) {
            return textResult(body.id, '⚠️ 太长了（超过 200 字符）。屏幕一共只能显示 15×8 = 120 个字符。');
          }

          const nonce = Math.random().toString(36).slice(2, 10);
          const pub = await publishMQTT(env, CMD_TOPIC, `text#${nonce}#${filtered}`);
          if (!pub.ok) {
            return textResult(body.id, `❌ 发布失败（EMQX HTTP ${pub.status}）`);
          }

          const { state, diag } = await waitForDevice(env, nonce);
          if (state && state.ok === 1) {
            let t = `🦀 屏幕上已经显示：「${filtered}」`;
            if (dropped > 0) t += `\n（有 ${dropped} 个非 ASCII 字符被丢掉了）`;
            return textResult(body.id, t);
          }
          return textResult(body.id, `⚠️ 已发出，没等到设备确认。\n[诊断] ${diag}`);
        }

        const command = body.params?.arguments?.command || '';

        if (!COMMANDS.includes(command)) {
          return json({ jsonrpc: '2.0', id: body.id,
            error: { code: -32602, message: '不支持的 command' } }, 400);
        }

        const nonce = Math.random().toString(36).slice(2, 10);

        const pub = await publishMQTT(env, CMD_TOPIC, `${command}#${nonce}`);
        if (!pub.ok) {
          return json({ jsonrpc: '2.0', id: body.id, result: { content: [{
            type: 'text', text: `❌ 发布失败（EMQX HTTP ${pub.status}）`
          }]}});
        }

        const { state, diag } = await waitForDevice(env, nonce);

        let text;
        if (state && state.ok === 1) {
          text = `🦀 屏幕已执行「${command}」（view=${state.view}，设备已确认）`;
        } else if (state && state.ok === 0) {
          text = `⚠️ 设备收到了「${command}」但不认识这个命令。`;
        } else {
          text = `⚠️ 「${command}」已发出，没等到设备确认。\n[诊断] ${diag}`;
        }

        return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] }});
      }

      return json({ jsonrpc: '2.0', id: body.id ?? null,
        error: { code: -32601, message: 'Method not found' } }, 404);
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return new Response('Not found', { status: 404 });
    }

    return new Response('🦀 Clawd Mochi MCP Server v5 running.', { status: 200 });
  }
};
