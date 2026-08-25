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
    .prepare('SELECT v FROM state WHERE k = ?')
    .bind(ROW_KEY)
    .first();
  if (!row || !row.v) return null;
  try { return JSON.parse(row.v); } catch { return { _raw: row.v }; }
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
        // 写失败也返回 200，避免 EMQX 反复重试；错误会在下次诊断里显现
        return new Response('db error: ' + String(e).slice(0, 200), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    }

    // ── ② 调试用：直接看 D1 里存的是什么 ────────────────
    if (request.method === 'GET' && url.pathname === '/peek') {
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
          name: 'clawd_command',
          description: '控制桌面小螃蟹Clawd Mochi。指令:blink(眨眼)、squish(眯眼><)、wink(单眼眨眼)、sleep(睡觉zzz)、angry(生气)、sad(难过)、cute(呆萌圆眼)、surprised(惊讶张嘴)、dead(翻白眼X)、love(爱心眼)、happy(开心^^)、normal(普通眼睛)、canvas(画板)。返回结果会区分「屏幕已执行」和「已发出但设备未确认」。',
          inputSchema: { type: 'object', properties: {
            command: { type: 'string', enum: COMMANDS }
          }, required: ['command'] }
        }]}});
      }

      if (body.method === 'tools/call') {
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
