/**
 * 网关连通性预验证（独立脚本，不依赖 DSH 运行）：
 * 读 ~/.dsh/.credentials.yaml 的 ALIYUNBAILIAN_API_KEY，
 * 生成 1 秒 16kHz 单声道 WAV（440Hz 提示音），
 * 以 OpenAI 兼容 chat/completions + input_audio(base64 Data URL) 调 qwen3-asr-flash，
 * 打印 HTTP 状态与响应摘要。仅用于验证 链路/鉴权/格式 是否走得通。
 * 用法: node scripts/test-asr.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.ASR_BASE_URL || "";
if (!BASE_URL) {
  console.error("请先设置 ASR_BASE_URL（你的 OpenAI 兼容 ASR 网关地址）");
  process.exit(1);
}
const MODEL = "qwen3-asr-flash";
const KEY_ENV = "ALIYUNBAILIAN_API_KEY";

const credPath = join(homedir(), ".dsh", ".credentials.yaml");
const credText = readFileSync(credPath, "utf8");
const match = new RegExp(`${KEY_ENV}\\s*:\\s*"?([^"\\n,}]+)"?`).exec(credText);
if (match === null) {
  console.error(`未在 ${credPath} 找到 ${KEY_ENV}`);
  process.exit(1);
}
const apiKey = match[1].trim();
console.log(`key: ${apiKey.slice(0, 3)}***${apiKey.slice(-2)} (len ${apiKey.length})`);

// 1 秒 16k 单声道 440Hz PCM16 WAV
const rate = 16000;
const seconds = 1;
const n = rate * seconds;
const pcm = new Float32Array(n);
for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
const wav = new Uint8Array(44 + n * 2);
const view = new DataView(wav.buffer);
const writeStr = (off, str) => {
  for (let i = 0; i < str.length; i++) wav[off + i] = str.charCodeAt(i);
};
writeStr(0, "RIFF");
view.setUint32(4, 36 + n * 2, true);
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
view.setUint32(40, n * 2, true);
let off = 44;
for (let i = 0; i < n; i++, off += 2) {
  const s = Math.max(-1, Math.min(1, pcm[i]));
  view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
}
let bin = "";
const CHUNK = 0x8000;
for (let i = 0; i < wav.length; i += CHUNK) {
  bin += String.fromCharCode.apply(null, wav.subarray(i, i + CHUNK));
}
const base64 = Buffer.from(bin, "binary").toString("base64");
console.log(`wav base64 长度: ${base64.length}`);

const started = Date.now();
const response = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${base64}` } }]
      }
    ],
    stream: false,
    asr_options: { language: "zh", enable_itn: true }
  })
});
const text = await response.text();
console.log(`HTTP ${response.status} (${Date.now() - started}ms)`);
console.log(text.slice(0, 800));
