# FlashTrans 2

极速划词 / 截图翻译工具（Windows）。Tauri 2 + Rust 后端 + 原生 Web 前端（Vanilla TS + Vite）。

## 功能

- **F1 划词翻译** — 选中任意文字按 F1，弹窗即时显示译文
- **F2 打字翻译** — 输入即译，回车把译文粘贴回原窗口
- **F3 截图翻译** — 框选屏幕区域 → 原生 OCR → 翻译；可复制截图 / 贴图置顶
- **F4 AI 对话** — 本地 GGUF 大模型或任意 OpenAI 兼容 API
- **F5 主窗口** — 双栏翻译台 + 全部设置（热键均可自定义）

## 翻译引擎（三选一，可共存）

| 引擎 | 形态 | 说明 |
| --- | --- | --- |
| GGUF 大模型 | 单个 `.gguf` 文件 | Rust 原生推理（llama.cpp），翻译 + 对话 |
| NLLB-200 / Opus-MT | CTranslate2 目录 | 随包 `flashtrans-bridge` 驱动，200 语种 / 中英极速 |
| 在线 API | BYOK | 任意 OpenAI 兼容接口（DeepSeek、Kimi、硅基流动等） |

模型不随仓库 / 安装包分发，从发布渠道下载后在设置里选择即可。

## 隐私

- 本地模型翻译全程离线，文本不出本机
- API 模式仅向你自己填写的服务商接口发送待翻译文本；Key 仅存于本机
  `%APPDATA%\com.chai1220.flashtrans\settings.json`，不上传
- 无遥测、无统计、无自动联网行为（联网仅发生在你配置并使用 API 时）

## 开发

```bash
cd flashtrans-next
npm install
npm run tauri dev
```

构建依赖：

- Node.js、Rust（MSVC 工具链）
- llama-cpp-2 需要 CMake + libclang（`LIBCLANG_PATH` 指向 libclang 所在目录）
- CT2 桥接（可选，开发 NLLB/Opus 时）：仓库根建 `.venv`，
  `pip install -r requirements-bridge.txt`

## 发布打包

```powershell
npm run tauri build                      # ① 应用本体 → src-tauri/target/release/FlashTrans.exe
powershell scripts/build_bridge.ps1      # ② CT2 桥接 → installer/bridge-dist/（PyInstaller）
iscc installer/FlashTrans.iss            # ③ 安装包 → installer/Output/
```

> 面向分发的构建请以 AVX2 为基线（避免在无 AVX-512 的机器上非法指令崩溃）。
