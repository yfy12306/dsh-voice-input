/**
 * DSH 插件：语音输入（host 半）。
 *
 * 两件事：
 * 1) 麦克风权限：桌面端主进程把权限白名单写死为只放行 clipboard-sanitized-write，
 *    浏览器侧 getUserMedia 会直接 NotAllowedError。这里在主进程用 Electron 原生
 *    API 对每个窗口的 session 重设 permission handler，放行 media（并保留原剪贴板
 *    规则）。后设者生效，不修改 DSH 本体代码。
 * 2) ASR 路由：在内置 webserver 上注册同源具名路由 POST /voice-asr/transcribe，
 *    接收 { audioBase64, mime }，在 host 侧经 ctx.credentials 解析提供商 key，
 *    转发 OpenAI 兼容 chat/completions（qwen3-asr-flash，input_audio base64 Data URL），
 *    返回 { text }。key 永不进入浏览器；路由仅接受回环来源请求。
 */
import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);

const name = "voice-input";
const inject = ["webServer"];

const DEFAULTS = {
  baseURL: "",
  model: "qwen3-asr-flash",
  apiKeyEnv: "ALIYUNBAILIAN_API_KEY",
  language: "zh",
  routePath: "/voice-asr/transcribe",
  maxBodyBytes: 15 * 1024 * 1024
};

function isLoopbackAddr(addr) {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr === undefined
  );
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };

  // ---------- 1) 麦克风权限（主进程 session handler 重设） ----------
  let electron = null;
  try {
    electron = nativeRequire("electron");
  } catch (error) {
    console.warn("[voice-input] electron API 不可用，跳过麦克风权限放开：", error);
  }

  const patched = new WeakSet();
  const allow = (permission, _requestingUrl, isMainFrame) => {
    if (permission === "media" || permission === "audioCapture" || permission === "videoCapture") return true;
    // 保留桌面端原有规则：仅主框架剪贴板写入
    return permission === "clipboard-sanitized-write" && isMainFrame === true;
  };
  const patchSession = (session) => {
    if (session === null || session === undefined || patched.has(session)) return;
    patched.add(session);
    try {
      session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
        allow(permission, details?.requestingUrl ?? requestingOrigin, details?.isMainFrame)
      );
      session.setPermissionRequestHandler((_wc, permission, callback, details) => {
        callback(allow(permission, details?.requestingUrl, details?.isMainFrame));
      });
    } catch (error) {
      console.warn("[voice-input] session 权限重设失败：", error);
    }
  };
  const patchWindow = (win) => {
    try {
      patchSession(win?.webContents?.session);
    } catch {
      /* 窗口已销毁等，忽略 */
    }
  };

  let stopPermissionWatch = null;
  if (electron !== null && electron.app !== undefined && electron.BrowserWindow !== undefined) {
    const sweep = () => {
      for (const win of electron.BrowserWindow.getAllWindows()) patchWindow(win);
    };
    sweep();
    try {
      patchSession(electron.session?.defaultSession);
    } catch {
      /* 忽略 */
    }
    const onCreate = (win) => {
      // secureWindow 在构造同步流里设过 handler，这里同步+微任务后各补一次确保后设者生效
      patchWindow(win);
      setTimeout(() => patchWindow(win), 0);
    };
    electron.app.on("browser-window-created", onCreate);
    stopPermissionWatch = () => {
      electron.app.off("browser-window-created", onCreate);
    };
  }

  // ---------- 2) ASR 同源路由 ----------
  const transcribe = async (req, res) => {
    if (!isLoopbackAddr(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: "loopback only" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, cfg.maxBodyBytes);
    } catch (error) {
      sendJson(res, 413, { error: String(error?.message ?? error) });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid json body" });
      return;
    }
    const audioBase64 = typeof payload.audioBase64 === "string" ? payload.audioBase64 : "";
    const mime =
      typeof payload.mime === "string" && /^audio\/[a-z0-9.+-]+$/i.test(payload.mime)
        ? payload.mime
        : "audio/webm";
    if (audioBase64 === "") {
      sendJson(res, 400, { error: "audioBase64 required" });
      return;
    }

    let key;
    try {
      const credentials = ctx.credentials ?? (ctx[Symbol.for("cordis.inject")]?.credentials);
      if (!credentials) throw new Error("credentials service unavailable");
      const record = await credentials.resolve(cfg.apiKeyEnv);
      key = record?.value;
    } catch (error) {
      console.warn("[voice-input] 凭据解析失败：", error);
      key = undefined;
    }
    if (key === undefined || key === "") {
      sendJson(res, 500, { error: `credential ${cfg.apiKeyEnv} not configured` });
      return;
    }

    const messages = [];
    if (typeof payload.context === "string" && payload.context !== "") {
      messages.push({ role: "system", content: payload.context });
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: { data: `data:${mime};base64,${audioBase64}` }
        }
      ]
    });

    let upstream;
    try {
      upstream = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: false,
          asr_options: { language: cfg.language, enable_itn: true }
        })
      });
    } catch (error) {
      sendJson(res, 502, { error: `asr upstream unreachable: ${String(error?.message ?? error)}` });
      return;
    }
    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, 502, { error: `asr upstream ${upstream.status}`, detail: upstreamText.slice(0, 500) });
      return;
    }
    let json;
    try {
      json = JSON.parse(upstreamText);
    } catch {
      sendJson(res, 502, { error: "asr upstream returned non-json", detail: upstreamText.slice(0, 300) });
      return;
    }
    const message = json?.choices?.[0]?.message;
    const text = typeof message?.content === "string" ? message.content : "";
    const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
    const info = annotations.find((item) => item !== null && typeof item === "object" && item.type === "audio_info") ?? null;
    sendJson(res, 200, {
      text,
      language: info?.language ?? null,
      emotion: info?.emotion ?? null
    });
  };

  ctx.effect(
    function* () {
      if (stopPermissionWatch !== null) yield stopPermissionWatch;
      yield ctx.webServer.register({
        kind: "exact",
        path: cfg.routePath,
        handler: transcribe
      });
    },
    "voice-input: asr route + microphone permission"
  );
}

export { apply, inject, name };
