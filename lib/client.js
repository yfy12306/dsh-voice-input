/**
 * 浏览器侧：输入框右下角的语音输入按钮（slot: conversation.input.right）。
 * - 点一次开始录音（MediaRecorder，优先 webm/opus），再点一次停止并识别
 * - 音频 base64 经同源路由 POST /voice-asr/transcribe 交给 host 半转发 qwen3-asr-flash
 * - 识别文本写入当前会话输入框草稿（官方 input facade setDraft；失败退 DOM execCommand）
 * - 录音中按钮红点脉动；识别中转圈；错误以 title 提示 + console.warn
 * - 颜色全部使用主题 CSS 变量（适配 moon-flavor 等主题）
 */
window.__ModuleLoader__.load({
  id: "voice-input",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    // ---------- 样式（主题变量） ----------
    if (typeof document !== "undefined") {
      var tagId = "voice-input/style";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
        var styleTag = document.createElement("style");
        styleTag.setAttribute("data-plugin-css", tagId);
        styleTag.setAttribute("data-plugin", "voice-input");
        styleTag.textContent = [
          ".dsh-voice-btn {",
          "  display: inline-flex; align-items: center; justify-content: center;",
          "  width: 28px; height: 28px; margin: 0 2px; padding: 0;",
          "  border: none; border-radius: 8px; background: transparent;",
          "  color: var(--dsw-alias-label-secondary, #9a9aa2);",
          "  cursor: pointer; transition: background 120ms ease, color 120ms ease;",
          "  flex: none;",
          "}",
          ".dsh-voice-btn:hover { background: var(--dsw-alias-fill-quaternary, rgba(120,120,130,0.12)); color: var(--dsw-alias-label-primary, currentColor); }",
          ".dsh-voice-btn:disabled { opacity: 0.6; cursor: progress; }",
          ".dsh-voice-btn svg { display: block; }",
          ".dsh-voice-btn-rec { color: #e5484d !important; }",
          ".dsh-voice-dot {",
          "  width: 10px; height: 10px; border-radius: 50%; background: #e5484d;",
          "  animation: dsh-voice-pulse 1.1s ease-in-out infinite;",
          "}",
          "@keyframes dsh-voice-pulse {",
          "  0%, 100% { transform: scale(1); opacity: 1; }",
          "  50% { transform: scale(0.72); opacity: 0.55; }",
          "}",
          ".dsh-voice-btn-busy { color: var(--dsw-alias-label-tertiary, #77777f); }",
          ".dsh-voice-spinner {",
          "  width: 12px; height: 12px; border-radius: 50%;",
          "  border: 2px solid var(--dsw-alias-border-l2, rgba(120,120,130,0.35));",
          "  border-top-color: var(--dsw-alias-label-secondary, #9a9aa2);",
          "  animation: dsh-voice-spin 0.8s linear infinite;",
          "}",
          "@keyframes dsh-voice-spin { to { transform: rotate(360deg); } }"
        ].join("\n");
        document.head.appendChild(styleTag);
      }
    }

    // ---------- 参数 ----------
    var ROUTE = "/voice-asr/transcribe";
    var MAX_SECONDS = 60;
    var MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", ""];

    // ---------- 工具 ----------
    function bytesToBase64(bytes) {
      var bin = "";
      var CHUNK = 0x8000;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    }

    function blobToBase64(blob) {
      return blob.arrayBuffer().then(function (buf) {
        return bytesToBase64(new Uint8Array(buf));
      });
    }

    /** PCM(float32, 单声道) → WAV(16bit) 字节 */
    function encodeWav(pcm, rate) {
      var bytes = new Uint8Array(44 + pcm.length * 2);
      var view = new DataView(bytes.buffer);
      function writeStr(off, str) {
        for (var i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i);
      }
      writeStr(0, "RIFF");
      view.setUint32(4, 36 + pcm.length * 2, true);
      writeStr(8, "WAVE");
      writeStr(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, "data");
      view.setUint32(40, pcm.length * 2, true);
      var off = 44;
      for (var i = 0; i < pcm.length; i++, off += 2) {
        var s = Math.max(-1, Math.min(1, pcm[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return bytes;
    }

    /** 网关拒收录音格式时的兜底：解码 → 16k 单声道重采样 → WAV base64 */
    function blobToWavBase64(blob) {
      var AC = window.AudioContext || window.webkitAudioContext;
      return blob.arrayBuffer().then(function (buf) {
        var ac = new AC();
        return ac.decodeAudioData(buf).then(function (decoded) {
          var rate = 16000;
          var frames = Math.max(1, Math.ceil(decoded.duration * rate));
          var offline = new window.OfflineAudioContext(1, frames, rate);
          var src = offline.createBufferSource();
          src.buffer = decoded;
          src.connect(offline.destination);
          src.start(0);
          return offline.startRendering().then(function (rendered) {
            try { ac.close(); } catch (e) { /* 忽略 */ }
            return { base64: bytesToBase64(encodeWav(rendered.getChannelData(0), rate)), mime: "audio/wav" };
          });
        });
      });
    }

    /** 识别文本写入会话输入框草稿：优先官方 input facade，失败退 DOM */
    function insertDraft(ctx, sessionId, text) {
      try {
        var conv = null;
        if (typeof ctx.get === "function") {
          try { conv = ctx.get("conversation"); } catch (e) { conv = null; }
        }
        if ((conv === null || conv === undefined) && ctx.sessions && typeof ctx.sessions.scope === "function") {
          var scope = ctx.sessions.scope(sessionId);
          if (scope && typeof scope.get === "function") conv = scope.get("conversation");
        }
        var shell =
          conv && conv.input && typeof conv.input.shell === "function"
            ? conv.input.shell(sessionId)
            : null;
        if (shell && typeof shell.setDraft === "function") {
          var cur = shell.snapshot && typeof shell.snapshot.draft === "string" ? shell.snapshot.draft : "";
          shell.setDraft(cur === "" ? text : cur + text);
          return true;
        }
      } catch (error) {
        console.warn("[voice-input] input facade 写草稿失败，退 DOM：", error);
      }
      try {
        var editors = document.querySelectorAll('[contenteditable="true"]');
        var editor = editors.length > 0 ? editors[editors.length - 1] : null;
        if (editor === null) return false;
        editor.focus();
        var sel = window.getSelection();
        if (sel !== null) {
          var range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return document.execCommand("insertText", false, text);
      } catch (error2) {
        console.warn("[voice-input] DOM 写草稿也失败：", error2);
        return false;
      }
    }

    function MicIcon() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: "16", height: "16", fill: "currentColor", "aria-hidden": "true" },
        h("path", { d: "M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" }),
        h("path", { d: "M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" })
      );
    }

    function makeMicButton(ctx) {
      return function MicButton(props) {
        var sessionId = props.voiceSessionId;
        var statePair = React.useState("idle");
        var state = statePair[0];
        var setState = statePair[1];
        var errorPair = React.useState("");
        var error = errorPair[0];
        var setError = errorPair[1];
        var recRef = React.useRef(null);
        var streamRef = React.useRef(null);
        var timerRef = React.useRef(null);
        var errorTimerRef = React.useRef(null);

        function stopTracks() {
          try {
            if (streamRef.current !== null) {
              streamRef.current.getTracks().forEach(function (track) { track.stop(); });
            }
          } catch (e) { /* 忽略 */ }
          streamRef.current = null;
        }

        React.useEffect(function () {
          return function () {
            stopTracks();
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
          };
        }, []);

        function fail(message) {
          console.warn("[voice-input]", message);
          setError(message);
          setState("idle");
          if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(function () { setError(""); }, 5000);
        }

        function callAsr(base64, mime) {
          return fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ audioBase64: base64, mime: mime })
          }).then(function (response) {
            return response.json().catch(function () { return { error: "HTTP " + response.status }; }).then(function (json) {
              if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
              return typeof json.text === "string" ? json.text : "";
            });
          });
        }

        function finish(blob, mime) {
          setState("busy");
          blobToBase64(blob)
            .then(function (base64) {
              return callAsr(base64, mime).catch(function (upstreamError) {
                if (mime !== "audio/wav") {
                  console.warn("[voice-input] 原格式被拒，转 WAV 重试：", upstreamError);
                  return blobToWavBase64(blob).then(function (wav) {
                    return callAsr(wav.base64, wav.mime);
                  });
                }
                throw upstreamError;
              });
            })
            .then(function (text) {
              setState("idle");
              if (text === "") {
                fail("未识别到语音，请靠近麦克风重试");
                return;
              }
              if (insertDraft(ctx, sessionId, text) !== true) {
                fail("识别成功但写入输入框失败：" + text.slice(0, 40));
              }
            })
            .catch(function (error) {
              setState("idle");
              fail("识别失败：" + (error && error.message ? error.message : String(error)));
            });
        }

        function start() {
          if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
            fail("当前环境不支持录音（mediaDevices 不可用）");
            return;
          }
          if (typeof window.MediaRecorder !== "function") {
            fail("当前环境不支持 MediaRecorder");
            return;
          }
          setError("");
          setState("recording");
          navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then(function (stream) {
              streamRef.current = stream;
              var mime = "";
              for (var i = 0; i < MIME_CANDIDATES.length; i++) {
                var candidate = MIME_CANDIDATES[i];
                if (candidate === "" || MediaRecorder.isTypeSupported(candidate)) {
                  mime = candidate;
                  break;
                }
              }
              var recorder = new MediaRecorder(stream, mime === "" ? undefined : { mimeType: mime });
              var chunks = [];
              recorder.ondataavailable = function (event) {
                if (event.data && event.data.size > 0) chunks.push(event.data);
              };
              recorder.onstop = function () {
                if (timerRef.current !== null) clearTimeout(timerRef.current);
                timerRef.current = null;
                stopTracks();
                var type = recorder.mimeType || mime || "audio/webm";
                finish(new Blob(chunks, { type: type }), type.split(";")[0]);
              };
              recRef.current = recorder;
              recorder.start();
              timerRef.current = setTimeout(function () {
                if (recRef.current !== null && recRef.current.state !== "inactive") recRef.current.stop();
              }, MAX_SECONDS * 1000);
            })
            .catch(function (error) {
              fail("麦克风不可用：" + (error && error.name ? error.name : String(error)));
            });
        }

        function onClick() {
          if (state === "recording") {
            if (recRef.current !== null && recRef.current.state !== "inactive") recRef.current.stop();
          } else if (state === "idle") {
            start();
          }
        }

        var className =
          "dsh-voice-btn" +
          (state === "recording" ? " dsh-voice-btn-rec" : "") +
          (state === "busy" ? " dsh-voice-btn-busy" : "");
        var title =
          error !== ""
            ? error
            : state === "recording"
              ? "录音中…再点一次停止并识别（最长 " + MAX_SECONDS + " 秒）"
              : state === "busy"
                ? "识别中…"
                : "语音输入：点击开始录音";
        var icon =
          state === "recording"
            ? h("span", { className: "dsh-voice-dot" })
            : state === "busy"
              ? h("span", { className: "dsh-voice-spinner" })
              : MicIcon();
        return h(
          "button",
          {
            type: "button",
            className: className,
            title: title,
            "aria-label": "语音输入",
            disabled: state === "busy",
            onClick: onClick
          },
          icon
        );
      };
    }

    function apply(ctx) {
      var disposers = [];
      disposers.push(
        ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register(
            {
              name: "conversation.input.right",
              locale: "conversation",
              inject: function (sessionId) {
                return { voiceSessionId: sessionId };
              }
            },
            makeMicButton(ctx)
          );
        })
      );
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try {
            if (typeof disposers[i] === "function") disposers[i]();
          } catch (error) {
            console.warn("[voice-input] disposer 失败：", error);
          }
        }
      };
    }

    var inject = ["slots", "sessions"];
    exports.apply = apply;
    exports.inject = inject;
    exports.name = "voice-input";
    return module.exports;
  }
});
