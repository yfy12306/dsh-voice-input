# dsh-voice-input

DSH 桌面端语音输入插件：输入框右下角麦克风按钮，录音转文字后插入输入框草稿，可编辑再发送。

- 录音在浏览器侧完成（getUserMedia），经 DSH 内置 webserver 的同源路由转发到 ASR 网关
- API key 只在 host 侧解析，永不进入浏览器进程
- 识别文本先插入草稿，可手动修改后再发送

## 原理

1. **麦克风权限**：DSH 桌面端主进程默认只放行剪贴板权限，浏览器侧 getUserMedia 会直接
   NotAllowedError。本插件在主进程用 Electron 原生 API 重设每个窗口 session 的
   permission handler，放行 media（保留原剪贴板规则，后设者生效，不改 DSH 本体）。
2. **ASR 路由**：注册同源路由 `POST /voice-asr/transcribe`，接收 `{ audioBase64, mime }`，
   host 侧解析 key 后以 OpenAI 兼容 chat/completions 调 ASR 模型
   （input_audio base64 Data URL），返回 `{ text }`。路由仅接受回环来源请求。

## 安装

1. 把本仓库放到固定位置，例如 `~/.dsh/profiles/desktop/voice-input`
2. 在 `~/.dsh/profiles/desktop/package.json` 中：
   - `dependencies` 增加 `"dsh-voice-input": "link:<绝对路径，用正斜杠>"`
   - `dsh.profile.bundles` 增加 `"dsh-voice-input"`
3. 把本仓库 `cordis.patch.yml` 的内容追加进 `~/.dsh/profiles/desktop/cordis.patch.yml`
   （记得把 `baseURL` 填成你的 ASR 网关）
4. 在 profile 目录执行 `pnpm install`，重启 DSH

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `""` | OpenAI 兼容 ASR 网关地址（必填） |
| `model` | `qwen3-asr-flash` | ASR 模型名 |
| `apiKeyEnv` | `ALIYUNBAILIAN_API_KEY` | key 的环境变量名（host 侧解析） |
| `language` | `zh` | 识别语言 |
| `routePath` | `/voice-asr/transcribe` | 同源路由路径 |
| `maxBodyBytes` | 15728640 | 音频大小上限（15 MB） |

## 测试

```bash
ASR_BASE_URL=<你的网关> node scripts/test-asr.mjs
```

## License

MIT
