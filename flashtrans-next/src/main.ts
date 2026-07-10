// FlashTrans 仪表盘
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  loadSettings, saveSettings, activeProfile, applyTheme, applyScale, onSettingsChanged,
  LANGS_FULL, resolveTarget, llmStream, translateMessages,
  makeSearchDropdown, toast, ICONS, mountWinControls, el, comboFromEvent,
  collectModels, probeModel, localTranslate, localReady,
  type Settings, type ModelInfo, type SearchItem,
} from "./shared";

const HK_DEFAULTS: Record<string, string> = { f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5" };

// 语言下拉的可搜索项：中文名 + 英文副标 + (中文/英文/code) 检索串
const LANG_ITEMS: SearchItem[] = LANGS_FULL.map(([code, zh, en]) => ({
  value: code,
  label: zh,
  sub: en,
  search: `${zh} ${en} ${code}`.toLowerCase(),
}));

const win = getCurrentWindow();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let translating = false;
let models: ModelInfo[] = [];

function refreshBadge() {
  const badge = $("backend-badge");
  const l = settings.local;
  if (l.mode !== "api" && l.selectedModel) {
    const kind = l.mode === "qwen" ? "GGUF" : l.mode === "opus" ? "Opus-MT" : "NLLB";
    badge.textContent = `本地 · ${kind}`;
    badge.className = "badge";
    return;
  }
  const p = activeProfile(settings);
  if (p.baseUrl && p.model) {
    badge.textContent = `API · ${p.model}`;
    badge.className = "badge";
  } else {
    badge.textContent = "未配置引擎";
    badge.className = "badge blue";
  }
}

function segSet(segId: string, value: string) {
  document.querySelectorAll(`#${segId} button`).forEach((b) => {
    b.classList.toggle("on", (b as HTMLElement).dataset.v === value);
  });
}

async function main() {
  settings = await loadSettings();
  applyTheme(settings.theme);
  applyScale(settings.uiScale);

  // ── 图标注入 ──
  mountWinControls();
  $("btn-chat").innerHTML = ICONS.chat;
  $("btn-settings").innerHTML = ICONS.gear;
  $("btn-swap").innerHTML = ICONS.swap;
  $("src-copy").innerHTML = ICONS.copy;
  $("src-clear").innerHTML = ICONS.clear;
  $("dst-copy").innerHTML = ICONS.copy;
  $("sheet-close").innerHTML = ICONS.clear;
  refreshBadge();

  // ── 窗口控制 ──
  $("tb-close").addEventListener("click", () => win.hide());
  $("tb-min").addEventListener("click", () => win.minimize());
  $("tb-max").addEventListener("click", () => win.toggleMaximize());

  // ── 语言下拉 ──
  const ddSrc = makeSearchDropdown(LANG_ITEMS, settings.sourceLang, async (v) => {
    settings.sourceLang = v;
    await saveSettings(settings);
  });
  const ddTgt = makeSearchDropdown(LANG_ITEMS, settings.targetLang, async (v) => {
    settings.targetLang = v;
    await saveSettings(settings);
  });
  $("dd-src").appendChild(ddSrc.root);
  $("dd-tgt").appendChild(ddTgt.root);

  $("btn-swap").addEventListener("click", async () => {
    $("btn-swap").classList.toggle("spun");
    const s = settings.sourceLang === "auto" ? "en" : settings.sourceLang;
    const t = settings.targetLang === "auto" ? "zh" : settings.targetLang;
    settings.sourceLang = t;
    settings.targetLang = s;
    ddSrc.set(t);
    ddTgt.set(s);
    await saveSettings(settings);
  });

  // ── 原文区 ──
  const srcText = $<HTMLTextAreaElement>("src-text");
  srcText.addEventListener("input", () => {
    $("src-count").textContent = srcText.value ? `${srcText.value.length}` : "";
  });
  srcText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      translate();
    }
  });
  $("src-copy").addEventListener("click", async () => {
    if (!srcText.value) return;
    await invoke("copy_text", { text: srcText.value });
    toast("已复制原文");
  });
  $("src-clear").addEventListener("click", () => {
    srcText.value = "";
    $("src-count").textContent = "";
    showResult("");
    srcText.focus();
  });
  $("dst-copy").addEventListener("click", async () => {
    const t = $("dst-text").textContent ?? "";
    if (!t) return;
    await invoke("copy_text", { text: t });
    toast("已复制译文");
  });

  $("btn-translate").addEventListener("click", translate);

  // ── 设置面板 ──
  const sheet = $("sheet");
  const mask = $("sheet-mask");
  const openSheet = () => {
    fillSheet();
    sheet.classList.add("on");
    mask.classList.add("on");
  };
  const closeSheet = () => {
    sheet.classList.remove("on");
    mask.classList.remove("on");
  };
  $("btn-settings").addEventListener("click", openSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  mask.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
  });

  function fillSheet() {
    const p = activeProfile(settings);
    $<HTMLInputElement>("api-base").value = p.baseUrl;
    $<HTMLInputElement>("api-model").value = p.model;
    $<HTMLInputElement>("api-key").value = p.apiKey;
    segSet("seg-theme", settings.theme);
    segSet("seg-stay", String(settings.popupStaySecs));
    segSet("seg-clickout", settings.closeOnBlur ? "1" : "0");
    segSet("seg-scale", String(settings.uiScale));
    segSet("seg-ocr", settings.local.ocrEnabled ? "1" : "0");
    renderEngineSeg();
    renderHotkeys();
    refreshModels();
  }

  // ── 翻译引擎 / 本地模型 ──
  const modelList = $("model-list");

  function renderEngineSeg() {
    const isApi = settings.local.mode === "api";
    segSet("seg-engine", isApi ? "api" : "local");
    $("local-box").style.display = isApi ? "none" : "";
    renderOcrToggle();
  }

  // OCR 纠错靠往 LLM 的 prompt 里加提示实现，只有大模型（qwen）与 API 生效；
  // NLLB/Opus 走 bridge 会忽略该标志，故此时把开关置灰并说明原因。
  function renderOcrToggle() {
    const supported = settings.local.mode === "qwen" || settings.local.mode === "api";
    $("ocr-box").classList.toggle("disabled", !supported);
    $("ocr-hint").textContent = supported
      ? "截图翻译时用大模型顺手改正识别错字"
      : "当前引擎（NLLB / Opus-MT）不支持纠错，切到大模型或 API 才生效";
  }

  function renderModels() {
    modelList.innerHTML = "";
    if (!models.length) {
      modelList.appendChild(el("div", "model-empty", "未发现模型。把模型放进默认文件夹后点「刷新」，或用下面的按钮直接选择。"));
      return;
    }
    for (const m of models) {
      const selected = settings.local.selectedModel === m.path;
      const item = el("div", "model-item" + (selected ? " sel" : "") + (m.ready ? "" : " off"));
      const info = el("div", "mi-info");
      info.append(el("div", "mi-name", m.label), el("div", "mi-detail", m.detail || m.path));
      const kind = el("span", "mi-kind", m.kind === "qwen" ? "LLM" : m.kind === "opus" ? "中英" : "多语种");
      const editBtn = el("button", "mi-edit");
      editBtn.title = "自定义名称/备注";
      editBtn.innerHTML = ICONS.edit;

      // 内联编辑区
      const editBox = el("div", "mi-edit-box");
      const meta = settings.local.modelMeta?.[m.path] ?? {};
      const nameIn = el("input", "f-input") as HTMLInputElement;
      nameIn.placeholder = "自定义名称（留空用默认）";
      nameIn.value = meta.name ?? "";
      const noteIn = el("input", "f-input") as HTMLInputElement;
      noteIn.placeholder = "备注 / 介绍";
      noteIn.value = meta.note ?? "";
      const editRow = el("div", "row-end");
      const saveMetaBtn = el("button", "btn small tint", "保存");
      editRow.appendChild(saveMetaBtn);
      editBox.append(nameIn, noteIn, editRow);

      item.append(el("div", "mi-radio"), info, kind, editBtn, editBox);

      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        item.classList.toggle("editing");
      });
      [nameIn, noteIn].forEach((inp) =>
        inp.addEventListener("click", (e) => e.stopPropagation()),
      );
      saveMetaBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        settings.local.modelMeta = settings.local.modelMeta ?? {};
        settings.local.modelMeta[m.path] = { name: nameIn.value.trim(), note: noteIn.value.trim() };
        await saveSettings(settings);
        await refreshModels();
        refreshBadge();
        toast("已保存模型信息");
      });

      if (m.ready) {
        item.addEventListener("click", async () => {
          settings.local.selectedModel = m.path;
          settings.local.mode = (m.kind as Settings["local"]["mode"]) || "nllb";
          await saveSettings(settings);
          renderModels();
          renderEngineSeg();
          refreshBadge();
          toast(`已选择 ${m.label}`);
        });
      }
      modelList.appendChild(item);
    }
  }

  async function refreshModels() {
    try {
      const { root, models: found } = await collectModels(settings);
      models = found;
      const pathEl = $("models-dir-path");
      pathEl.textContent = root;
      pathEl.title = root;
      renderModels();
    } catch (e) {
      toast(`扫描模型失败：${e}`, false);
    }
  }

  async function addExtraModel(path: string) {
    const info = await probeModel(path);
    if (!info) {
      toast("这不是有效的模型（需 .gguf 文件或含 model.bin 的文件夹）", false);
      return;
    }
    settings.local.extraModels = settings.local.extraModels ?? [];
    if (!settings.local.extraModels.includes(info.path)) {
      settings.local.extraModels.push(info.path);
    }
    // 自动选中新加入的模型
    settings.local.selectedModel = info.path;
    settings.local.mode = (info.kind as Settings["local"]["mode"]) || "nllb";
    await saveSettings(settings);
    await refreshModels();
    renderEngineSeg();
    refreshBadge();
    toast(`已添加并选择 ${info.label}`);
  }

  document.querySelectorAll("#seg-engine button").forEach((b) => {
    b.addEventListener("click", async () => {
      const v = (b as HTMLElement).dataset.v;
      if (v === "api") {
        settings.local.mode = "api";
      } else {
        const sel = models.find((m) => m.path === settings.local.selectedModel);
        settings.local.mode = (sel?.kind as Settings["local"]["mode"]) || "nllb";
      }
      await saveSettings(settings);
      renderEngineSeg();
      refreshBadge();
    });
  });
  $("models-refresh").addEventListener("click", async () => {
    await refreshModels();
    toast("已刷新模型列表");
  });
  $("add-gguf").addEventListener("click", async () => {
    const picked = await openDialog({
      title: "选择 .gguf 大语言模型",
      multiple: false,
      filters: [{ name: "GGUF 模型", extensions: ["gguf"] }],
    });
    if (typeof picked === "string") await addExtraModel(picked);
  });
  $("add-folder").addEventListener("click", async () => {
    const picked = await openDialog({
      title: "选择模型文件夹（含 model.bin 的 NLLB / Opus-MT 目录）",
      directory: true,
      multiple: false,
    });
    if (typeof picked === "string") await addExtraModel(picked);
  });
  $("models-open").addEventListener("click", async () => {
    const p = $("models-dir-path").textContent || "";
    if (p) {
      try {
        await invoke("open_folder", { path: p });
      } catch (e) {
        toast(`无法打开文件夹：${e}`, false);
      }
    }
  });

  // ── 热键自定义 ──
  function renderHotkeys() {
    document.querySelectorAll<HTMLButtonElement>(".hk-btn").forEach((btn) => {
      const key = btn.dataset.hk!;
      btn.textContent = settings.hotkeys?.[key] || HK_DEFAULTS[key] || "—";
    });
  }

  let recording: { key: string; btn: HTMLButtonElement } | null = null;
  function stopRecording() {
    if (recording) recording.btn.classList.remove("recording");
    recording = null;
    renderHotkeys();
  }

  document.querySelectorAll<HTMLButtonElement>(".hk-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (recording?.btn === btn) {
        stopRecording();
        return;
      }
      stopRecording();
      recording = { key: btn.dataset.hk!, btn };
      btn.classList.add("recording");
      btn.textContent = "按下组合键…";
    });
  });

  document.addEventListener("keydown", async (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stopRecording();
      return;
    }
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    const combo = comboFromEvent(e);
    if (!combo) {
      recording.btn.textContent = "无效，需带 Ctrl/Alt/Shift…";
      return;
    }
    // 冲突检测
    const dup = Object.entries(settings.hotkeys || {}).find(
      ([k, v]) => k !== recording!.key && v === combo,
    );
    if (dup) {
      recording.btn.textContent = `与 ${dup[0].toUpperCase()} 冲突`;
      return;
    }
    settings.hotkeys = { ...(settings.hotkeys || {}), [recording.key]: combo };
    const savedKey = recording.key;
    stopRecording();
    await saveSettings(settings);
    toast(`${savedKey.toUpperCase()} 已设为 ${combo}`);
  }, true);

  $("hk-reset").addEventListener("click", async () => {
    stopRecording();
    settings.hotkeys = { ...HK_DEFAULTS };
    await saveSettings(settings);
    renderHotkeys();
    toast("热键已恢复默认");
  });

  // ── 主题 / 弹窗停留 ──
  document.querySelectorAll("#seg-theme button").forEach((b) => {
    b.addEventListener("click", async () => {
      const v = (b as HTMLElement).dataset.v as "dark" | "light";
      settings.theme = v;
      segSet("seg-theme", v);
      applyTheme(v);
      await saveSettings(settings);
    });
  });
  document.querySelectorAll("#seg-stay button").forEach((b) => {
    b.addEventListener("click", async () => {
      const v = Number((b as HTMLElement).dataset.v);
      settings.popupStaySecs = v;
      segSet("seg-stay", String(v));
      await saveSettings(settings);
      toast(v === 0 ? "弹窗将常驻，手动关闭" : `弹窗停留 ${v} 秒`);
    });
  });
  document.querySelectorAll("#seg-clickout button").forEach((b) => {
    b.addEventListener("click", async () => {
      const on = (b as HTMLElement).dataset.v === "1";
      settings.closeOnBlur = on;
      segSet("seg-clickout", on ? "1" : "0");
      await saveSettings(settings);
      toast(on ? "点击弹窗外部将自动关闭" : "已关闭点击外部关闭");
    });
  });
  document.querySelectorAll("#seg-scale button").forEach((b) => {
    b.addEventListener("click", async () => {
      const v = Number((b as HTMLElement).dataset.v);
      settings.uiScale = v;
      segSet("seg-scale", String(v));
      applyScale(v); // 立即生效
      await saveSettings(settings);
      toast(`界面缩放 ${Math.round(v * 100)}%`);
    });
  });
  document.querySelectorAll("#seg-ocr button").forEach((b) => {
    b.addEventListener("click", async () => {
      const on = (b as HTMLElement).dataset.v === "1";
      settings.local.ocrEnabled = on;
      segSet("seg-ocr", on ? "1" : "0");
      await saveSettings(settings);
      toast(on ? "截图翻译将自动纠正 OCR 错字" : "已关闭 OCR 纠错");
    });
  });

  // ── API 配置 ──
  async function collectProfile() {
    const p = activeProfile(settings);
    p.baseUrl = $<HTMLInputElement>("api-base").value.trim();
    p.model = $<HTMLInputElement>("api-model").value.trim();
    p.apiKey = $<HTMLInputElement>("api-key").value.trim();
    await saveSettings(settings);
    refreshBadge();
  }
  $("api-save").addEventListener("click", async () => {
    await collectProfile();
    toast("API 配置已保存");
  });
  $("api-test").addEventListener("click", async () => {
    await collectProfile();
    const p = activeProfile(settings);
    if (!p.baseUrl || !p.model) {
      toast("请先填写 Base URL 和 Model", false);
      return;
    }
    toast("正在测试…");
    let buf = "";
    await llmStream(p, [{ role: "user", content: "Reply with exactly: OK" }], {
      onDelta: (t) => (buf += t),
      onDone: () => toast("连接成功 ✓"),
      onError: (m) => toast(`连接失败：${m}`, false),
    }, 0);
  });

  // ── 其他窗口 ──
  $("btn-chat").addEventListener("click", async () => {
    const chat = await WebviewWindow.getByLabel("chat");
    await chat?.show();
    await chat?.setFocus();
  });

  onSettingsChanged((s) => {
    settings = s;
    applyTheme(s.theme);
    applyScale(s.uiScale);
    refreshBadge();
  });

  // 启动时预扫一次，让徽章/设置页状态就绪
  refreshModels();
}

/* ───────── 翻译 ───────── */

function showResult(text: string, isErr = false) {
  const dst = $("dst-text");
  dst.textContent = text;
  dst.classList.toggle("err", isErr);
  $("dst-empty").style.display = text ? "none" : "";
  $("dst-skeleton").style.display = "none";
}

function beginLoading() {
  const dst = $("dst-text");
  dst.textContent = "";
  dst.classList.remove("err");
  $("dst-empty").style.display = "none";
  $("dst-skeleton").style.display = "";
}

async function translate() {
  if (translating) return;
  const text = $<HTMLTextAreaElement>("src-text").value.trim();
  if (!text) return;

  const btn = $<HTMLButtonElement>("btn-translate");

  // ── 本地离线模型 ──
  if (localReady(settings)) {
    translating = true;
    btn.disabled = true;
    beginLoading();
    try {
      const out = await localTranslate(settings, text);
      showResult(out || "（无翻译结果）");
    } catch (e) {
      showResult(String(e), true);
    }
    translating = false;
    btn.disabled = false;
    return;
  }

  // ── 在线 API ──
  const p = activeProfile(settings);
  if (!p.baseUrl || !p.model) {
    showResult(
      "尚未配置翻译引擎。\n\n点击右上角 ⚙ 设置：\n· 本地离线 — 选择 models 文件夹里的 NLLB / Opus-MT / GGUF 模型\n· 在线 API — 填写 OpenAI 兼容接口（DeepSeek、Kimi、硅基流动等）",
      true,
    );
    return;
  }

  const target = resolveTarget(text, settings.sourceLang, settings.targetLang);
  translating = true;
  btn.disabled = true;
  beginLoading();

  let started = false;
  const dst = $("dst-text");
  const caret = document.createElement("span");
  caret.className = "stream-caret";

  await llmStream(p, translateMessages(text, target), {
    onDelta: (t) => {
      if (!started) {
        started = true;
        $("dst-skeleton").style.display = "none";
        dst.appendChild(caret);
      }
      const tok = document.createElement("span");
      tok.className = "tok";
      tok.textContent = t;
      dst.insertBefore(tok, caret);
    },
    onDone: (full) => {
      showResult(full);
      translating = false;
      btn.disabled = false;
    },
    onError: (m) => {
      showResult(m, true);
      translating = false;
      btn.disabled = false;
    },
  });
}

window.addEventListener("DOMContentLoaded", main);
