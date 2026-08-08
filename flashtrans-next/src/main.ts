// FlashTrans 仪表盘
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  loadSettings, saveSettings, activeProfile, applyTheme, applyScale, onSettingsChanged,
  LANGS_FULL, resolveLangPair, llmStream, translateMessages,
  makeSearchDropdown, makeDropdown, toast, ICONS, mountWinControls, el, comboFromEvent,
  collectModels, probeModel, localTranslate, localReady,
  ensurePrompts, activeDomainPrompt, ensureOcr, assistantModel,
  type Settings, type ModelInfo, type SearchItem, type OcrProfile,
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
    if (e.key !== "Enter") return;
    // 输入法组词中的回车是「上屏」，不能当成翻译（中文输入必踩）
    if (e.isComposing || e.keyCode === 229) return;
    // Enter 直接翻译，Shift+Enter 换行；Ctrl/⌘+Enter 保留给习惯了旧快捷键的人
    if (e.shiftKey) return;
    e.preventDefault();
    translate();
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
    fillApiEditor();
    renderProfiles();
    renderPrompts();
    renderOcrProfiles();
    segSet("seg-theme", settings.theme);
    segSet("seg-stay", String(settings.popupStaySecs));
    segSet("seg-clickout", settings.closeOnBlur ? "1" : "0");
    segSet("seg-scale", String(settings.uiScale));
    segSet("seg-ocr", settings.local.ocrEnabled ? "1" : "0");
    segSet("seg-autoswap", settings.autoSwap ? "1" : "0");
    segSet("seg-snipoverlay", settings.snipOverlay ? "1" : "0");
    segSet("seg-snipoverlaylayout", settings.snipOverlayLayout ?? "auto");
    refreshAutostart();
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
    renderApiNote(isApi);
    renderOcrToggle();
    renderPromptNote();
    renderQuick();
  }

  // API 配置常驻在引擎开关下面：选「在线 API」时它就是翻译引擎；选「本地离线」时
  // 它不参与翻译，只在没有 .gguf 时兜底 F4 对话 / OCR 纠错。用文案说清，免得两边来回跳。
  function renderApiNote(isApi: boolean) {
    $("api-title").textContent = isApi
      ? "在线 API（当前翻译引擎 · OpenAI 兼容 · 自备 Key）"
      : "在线 API（当前不用于翻译 · 仅作对话 / 纠错兜底）";
    $("api-note").textContent = isApi
      ? "可保存多套 API（DeepSeek / Kimi / 本地 Ollama…），点击某条即切换为生效预设，主界面右下角也能快速切换；点 🗑 删除。"
      : "当前用本地模型翻译，这里填的 API 不参与翻译；但在没有 .gguf 大模型时，F4 对话与 OCR 纠错会用它兜底。";
  }

  // 领域提示词与 OCR 纠错同理：只有大模型（qwen）与 API 能遵循；NLLB/Opus 忽略。
  // 不锁编辑（允许先配好再切引擎），只动态说明当前是否生效。
  function renderPromptNote() {
    const supported = settings.local.mode === "qwen" || settings.local.mode === "api";
    $("prompt-note").textContent = supported
      ? "给翻译附加领域要求（如「医学领域，术语按规范译法」），主界面右下角可随时切换预设。"
      : "当前引擎（NLLB / Opus-MT）是专用翻译模型，无法遵循提示词；切到 .gguf 大模型或在线 API 才生效。这里仍可先编辑保存备用。";
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

  // 列表底部的「恢复显示」入口：有被移除隐藏的模型时出现，防止误删找不回
  function appendRestoreRow() {
    const hidden = settings.local.hiddenModels ?? [];
    if (!hidden.length) return;
    const row = el("div", "model-restore");
    const btn = el("button", "btn small", `恢复显示已移除的 ${hidden.length} 个模型`);
    btn.addEventListener("click", async () => {
      settings.local.hiddenModels = [];
      await saveSettings(settings);
      await refreshModels();
      renderEngineSeg();
      refreshBadge();
      toast("已恢复显示");
    });
    row.appendChild(btn);
    modelList.appendChild(row);
  }

  function renderModels() {
    modelList.innerHTML = "";
    if (!models.length) {
      modelList.appendChild(el("div", "model-empty", "未发现模型。把模型放进默认文件夹后点「刷新」，或用下面的按钮直接选择。"));
      appendRestoreRow();
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

      item.append(el("div", "mi-radio"), info, kind, editBtn);

      // 每个模型都可从列表移除，一律不动磁盘文件：
      // 手动添加的 → 从 extraModels 去掉；默认文件夹扫描的 → 记入 hiddenModels（否则刷新又扫回来）
      const rmBtn = el("button", "mi-edit");
      rmBtn.title = "从列表移除（不删除磁盘文件）";
      rmBtn.innerHTML = ICONS.trash;
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if ((settings.local.extraModels ?? []).includes(m.path)) {
          settings.local.extraModels = (settings.local.extraModels ?? []).filter((x) => x !== m.path);
        } else {
          settings.local.hiddenModels = [...(settings.local.hiddenModels ?? []), m.path];
        }
        if (settings.local.modelMeta) delete settings.local.modelMeta[m.path];
        if (settings.local.selectedModel === m.path) settings.local.selectedModel = "";
        await saveSettings(settings);
        await refreshModels();
        renderEngineSeg();
        refreshBadge();
        toast("已从列表移除（磁盘文件未删除）");
      });
      item.appendChild(rmBtn);
      item.appendChild(editBox);

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
    appendRestoreRow();
  }

  async function refreshModels() {
    try {
      const { root, models: found } = await collectModels(settings);
      models = found;
      const pathEl = $("models-dir-path");
      pathEl.textContent = root;
      pathEl.title = root;
      renderModels();
      renderAssistant(); // 助手模型下拉的候选项就是扫到的 .gguf
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
  document.querySelectorAll("#seg-autoswap button").forEach((b) => {
    b.addEventListener("click", async () => {
      const on = (b as HTMLElement).dataset.v === "1";
      settings.autoSwap = on;
      segSet("seg-autoswap", on ? "1" : "0");
      await saveSettings(settings);
      toast(on ? "已开启双向自动切换" : "已关闭双向自动切换");
    });
  });
  document.querySelectorAll("#seg-snipoverlay button").forEach((b) => {
    b.addEventListener("click", async () => {
      const on = (b as HTMLElement).dataset.v === "1";
      settings.snipOverlay = on;
      segSet("seg-snipoverlay", on ? "1" : "0");
      await saveSettings(settings);
      toast(on ? "截图翻译将把译文覆盖在原文上" : "截图翻译只用弹窗显示");
    });
  });
  document.querySelectorAll("#seg-snipoverlaylayout button").forEach((b) => {
    b.addEventListener("click", async () => {
      const v = ((b as HTMLElement).dataset.v ?? "auto") as "auto" | "inplace" | "panel";
      settings.snipOverlayLayout = v;
      segSet("seg-snipoverlaylayout", v);
      await saveSettings(settings);
      toast({ auto: "覆盖排版：按文字密度自动选", inplace: "覆盖排版：逐段贴回原处", panel: "覆盖排版：整块重排" }[v]);
    });
  });

  // ── 开机自启（真值在注册表里，不进 settings.json，避免和安装包的勾选项打架）──
  async function refreshAutostart() {
    try {
      const on = (await invoke("autostart_get")) as boolean;
      segSet("seg-autostart", on ? "1" : "0");
    } catch {
      segSet("seg-autostart", "0");
    }
  }
  document.querySelectorAll("#seg-autostart button").forEach((b) => {
    b.addEventListener("click", async () => {
      const on = (b as HTMLElement).dataset.v === "1";
      try {
        await invoke("autostart_set", { enabled: on });
        segSet("seg-autostart", on ? "1" : "0");
        toast(on ? "已设为开机启动（只进托盘，不弹窗口）" : "已取消开机启动");
      } catch (e) {
        toast(`设置开机启动失败：${e}`, false);
        await refreshAutostart();
      }
    });
  });

  // ── 对话 / 纠错模型（可与翻译模型不同的 .gguf）──
  function renderAssistant() {
    const box = $("assist-pick");
    box.innerHTML = "";
    const ggufs = models.filter((m) => m.kind === "qwen" && m.ready);
    const items: [string, string][] = [
      ["", ggufs.length ? "跟随翻译模型" : "跟随翻译模型（未发现 .gguf 模型）"],
      ...ggufs.map((m) => [m.path, m.label] as [string, string]),
    ];
    const cur = items.some(([v]) => v === (settings.local.assistantModel ?? "")) ? settings.local.assistantModel ?? "" : "";
    const dd = makeDropdown(items, cur, async (v) => {
      settings.local.assistantModel = v;
      await saveSettings(settings);
      renderAssistantNote();
      toast(v ? `对话 / 纠错用 ${items.find(([x]) => x === v)?.[1]}` : "对话 / 纠错跟随翻译模型");
    });
    box.appendChild(dd.root);
    renderAssistantNote();
  }

  function renderAssistantNote() {
    const note = $("assist-note");
    const active = assistantModel(settings);
    const dedicated = (settings.local.assistantModel ?? "").trim();
    if (dedicated) {
      note.textContent =
        "已指定专用大模型：F4 对话与 OCR 纠错走它，翻译仍走上面选中的模型。两个模型会各占一份内存。";
    } else if (active) {
      note.textContent = "当前翻译模型本身就是 .gguf 大模型，F4 对话与 OCR 纠错直接用它。";
    } else {
      note.textContent =
        "F4 对话与 OCR 纠错只有大模型（.gguf）能做。翻译用 NLLB / Opus-MT 时，在这里单独指定一个 .gguf 即可（翻译仍走上面选中的模型）；也可以改用在线 API。";
    }
  }

  // ── 自定义 OCR 模型 ──
  let ocrEditing = ""; // 保持展开编辑状态的预设名（跨重渲染）

  function ocrPickRow(label: string, hint: string, value: string, filters: { name: string; extensions: string[] }[]) {
    const row = el("div", "ocr-pick");
    const left = el("div", "mi-info");
    const path = el("div", "mi-detail", value || hint);
    path.title = value;
    left.append(el("div", "mi-name", label), path);
    const pick = el("button", "btn small", "选择…");
    let cur = value;
    pick.addEventListener("click", async (e) => {
      e.stopPropagation();
      const picked = await openDialog({ title: label, multiple: false, filters });
      if (typeof picked === "string") {
        cur = picked;
        path.textContent = picked;
      }
    });
    const clear = el("button", "btn small", "清除");
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      cur = "";
      path.textContent = hint;
    });
    row.append(left, pick, clear);
    return { row, get: () => cur };
  }

  function renderOcrProfiles() {
    const oc = ensureOcr(settings);
    const list = $("ocr-list");
    list.innerHTML = "";

    // 固定首行：默认引擎
    const plain = el("div", "model-item" + (oc.selected ? "" : " sel"));
    const plainInfo = el("div", "mi-info");
    plainInfo.append(
      el("div", "mi-name", "默认（推荐）"),
      el("div", "mi-detail", "中/英用内置 RapidOCR，其他语种用 Windows 自带 OCR"),
    );
    plain.append(el("div", "mi-radio"), plainInfo);
    plain.addEventListener("click", async () => {
      if (!ensureOcr(settings).selected) return;
      ensureOcr(settings).selected = "";
      await saveSettings(settings);
      renderOcrProfiles();
      toast("已切回默认 OCR");
    });
    list.appendChild(plain);

    for (const p of oc.profiles) {
      const item = el("div", "model-item" + (oc.selected === p.name ? " sel" : ""));
      const info = el("div", "mi-info");
      const rec = p.recPath ? p.recPath.split(/[\\/]/).pop() : "";
      info.append(
        el("div", "mi-name", p.name),
        el("div", "mi-detail", rec ? `识别模型 ${rec}` : "（未选识别模型，点 ✎ 配置）"),
      );

      const editBtn = el("button", "mi-edit");
      editBtn.title = "编辑名称 / 模型文件";
      editBtn.innerHTML = ICONS.edit;
      const rmBtn = el("button", "mi-edit");
      rmBtn.title = "删除此 OCR 模型";
      rmBtn.innerHTML = ICONS.trash;

      const editBox = el("div", "mi-edit-box");
      const nameIn = el("input", "f-input") as HTMLInputElement;
      nameIn.placeholder = "名称（如 韩语 / 俄语）";
      nameIn.value = p.name;
      // 只留两个选择：模型本体 + 字典。输入高度、是否需要字典都由后端读 ONNX 自动判断，
      // 检测模型用内置的、方向分类关掉（截图不会倒着放），不再让用户猜这些参数。
      const recRow = ocrPickRow("识别模型 (.onnx)", "必选", p.recPath, [
        { name: "ONNX 模型", extensions: ["onnx"] },
      ]);
      const keysRow = ocrPickRow("字典 (.txt)", "留空即可：会自动在模型同目录里找", p.keysPath, [
        { name: "字典", extensions: ["txt"] },
      ]);
      const editRow = el("div", "row-end");
      const saveBtn = el("button", "btn small tint", "保存");
      editRow.appendChild(saveBtn);
      editBox.append(nameIn, recRow.row, keysRow.row, editRow);
      if (ocrEditing === p.name) item.classList.add("editing");

      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const on = item.classList.toggle("editing");
        ocrEditing = on ? p.name : "";
      });
      nameIn.addEventListener("click", (e) => e.stopPropagation());
      editBox.addEventListener("click", (e) => e.stopPropagation());

      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const oc2 = ensureOcr(settings);
        const tgt = oc2.profiles.find((x) => x.name === p.name);
        if (!tgt) return;
        const newName = nameIn.value.trim() || tgt.name;
        if (oc2.profiles.some((x) => x !== tgt && x.name === newName)) {
          toast(`已有同名 OCR 模型「${newName}」`, false);
          return;
        }
        if (oc2.selected === tgt.name) oc2.selected = newName;
        tgt.name = newName;
        tgt.recPath = recRow.get();
        tgt.keysPath = keysRow.get();
        ocrEditing = "";
        await saveSettings(settings);
        renderOcrProfiles();
        toast("已保存 OCR 模型");
      });

      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const oc2 = ensureOcr(settings);
        oc2.profiles = oc2.profiles.filter((x) => x.name !== p.name);
        if (oc2.selected === p.name) oc2.selected = "";
        if (ocrEditing === p.name) ocrEditing = "";
        await saveSettings(settings);
        renderOcrProfiles();
        toast(`已删除 OCR 模型 ${p.name}`);
      });

      item.addEventListener("click", async () => {
        const oc2 = ensureOcr(settings);
        if (oc2.selected === p.name) return;
        if (!p.recPath) {
          toast("先点 ✎ 选好识别模型 (.onnx) 再启用", false);
          return;
        }
        oc2.selected = p.name;
        await saveSettings(settings);
        renderOcrProfiles();
        toast(`截图 OCR：${p.name}`);
      });

      item.append(el("div", "mi-radio"), info, editBtn, rmBtn, editBox);
      list.appendChild(item);
    }
  }

  $("ocr-add").addEventListener("click", async () => {
    const oc = ensureOcr(settings);
    let n = 1;
    while (oc.profiles.some((x) => x.name === `OCR ${n}`)) n++;
    const p: OcrProfile = { name: `OCR ${n}`, recPath: "", keysPath: "", detPath: "", clsPath: "" };
    oc.profiles.push(p);
    ocrEditing = p.name; // 新建后直接展开编辑
    await saveSettings(settings);
    renderOcrProfiles();
  });

  // ── API 多预设 ──

  /** 当前选中的预设（保证一定存在且在列表内；列表空时兜底一条空白 default） */
  function currentProfile() {
    let p = settings.api.profiles.find((x) => x.name === settings.api.selected);
    if (!p) p = settings.api.profiles[0];
    if (!p) {
      p = { name: "default", baseUrl: "", apiKey: "", model: "" };
      settings.api.profiles.push(p);
    }
    settings.api.selected = p.name;
    return p;
  }

  function fillApiEditor() {
    const p = currentProfile();
    $<HTMLInputElement>("api-name").value = p.name;
    $<HTMLInputElement>("api-base").value = p.baseUrl;
    $<HTMLInputElement>("api-model").value = p.model;
    $<HTMLInputElement>("api-key").value = p.apiKey;
  }

  function renderProfiles() {
    const list = $("profile-list");
    list.innerHTML = "";
    const cur = currentProfile();
    for (const p of settings.api.profiles) {
      const item = el("div", "model-item" + (p.name === cur.name ? " sel" : ""));
      const info = el("div", "mi-info");
      info.append(el("div", "mi-name", p.name), el("div", "mi-detail", p.model || "未填写模型"));

      const rmBtn = el("button", "mi-edit");
      rmBtn.title = "删除此预设";
      rmBtn.innerHTML = ICONS.trash;
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        settings.api.profiles = settings.api.profiles.filter((x) => x.name !== p.name);
        if (settings.api.selected === p.name) {
          settings.api.selected = settings.api.profiles[0]?.name ?? "";
        }
        currentProfile(); // 删空时兜底
        await saveSettings(settings);
        renderProfiles();
        fillApiEditor();
        refreshBadge();
        renderQuick();
        toast(`已删除预设 ${p.name}`);
      });

      item.append(el("div", "mi-radio"), info, rmBtn);
      item.addEventListener("click", async () => {
        if (settings.api.selected === p.name) return;
        settings.api.selected = p.name;
        await saveSettings(settings);
        renderProfiles();
        fillApiEditor();
        refreshBadge();
        renderQuick();
        toast(`已切换到 ${p.name}`);
      });
      list.appendChild(item);
    }
  }

  $("profile-add").addEventListener("click", async () => {
    let n = 1;
    while (settings.api.profiles.some((x) => x.name === `预设 ${n}`)) n++;
    const p = { name: `预设 ${n}`, baseUrl: "", apiKey: "", model: "" };
    settings.api.profiles.push(p);
    settings.api.selected = p.name;
    await saveSettings(settings);
    renderProfiles();
    fillApiEditor();
    refreshBadge();
    renderQuick();
    const nameIn = $<HTMLInputElement>("api-name");
    nameIn.focus();
    nameIn.select();
  });

  /** 把编辑区内容写回当前预设（含重命名与重名检查）；成功返回 true */
  async function collectProfile(): Promise<boolean> {
    const p = currentProfile();
    const name = $<HTMLInputElement>("api-name").value.trim() || p.name;
    if (settings.api.profiles.some((x) => x !== p && x.name === name)) {
      toast(`已有同名预设「${name}」`, false);
      return false;
    }
    p.name = name;
    settings.api.selected = name;
    p.baseUrl = $<HTMLInputElement>("api-base").value.trim();
    p.model = $<HTMLInputElement>("api-model").value.trim();
    p.apiKey = $<HTMLInputElement>("api-key").value.trim();
    await saveSettings(settings);
    renderProfiles();
    refreshBadge();
    renderQuick();
    return true;
  }
  $("api-save").addEventListener("click", async () => {
    if (await collectProfile()) toast("API 预设已保存");
  });
  $("api-test").addEventListener("click", async () => {
    if (!(await collectProfile())) return;
    const p = currentProfile();
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

  // ── 领域提示词预设 ──
  let promptEditing = ""; // 保持展开编辑状态的预设名（跨重渲染）

  function renderPrompts() {
    const pr = ensurePrompts(settings);
    const list = $("prompt-list");
    list.innerHTML = "";

    // 固定首行：通用翻译（无附加要求），不可编辑/删除
    const plain = el("div", "model-item" + (pr.selected ? "" : " sel"));
    const plainInfo = el("div", "mi-info");
    plainInfo.append(el("div", "mi-name", "通用翻译"), el("div", "mi-detail", "不附加领域要求"));
    plain.append(el("div", "mi-radio"), plainInfo);
    plain.addEventListener("click", async () => {
      const pr2 = ensurePrompts(settings);
      if (!pr2.selected) return;
      pr2.selected = "";
      await saveSettings(settings);
      renderPrompts();
      renderQuick();
      toast("已切换到通用翻译");
    });
    list.appendChild(plain);

    for (const p of pr.presets) {
      const item = el("div", "model-item" + (pr.selected === p.name ? " sel" : ""));
      const info = el("div", "mi-info");
      const preview = p.text.trim()
        ? (p.text.length > 42 ? p.text.slice(0, 42) + "…" : p.text)
        : "（空提示词，点 ✎ 填写要求）";
      info.append(el("div", "mi-name", p.name), el("div", "mi-detail", preview));

      const editBtn = el("button", "mi-edit");
      editBtn.title = "编辑名称 / 提示词";
      editBtn.innerHTML = ICONS.edit;
      const rmBtn = el("button", "mi-edit");
      rmBtn.title = "删除此提示词";
      rmBtn.innerHTML = ICONS.trash;

      // 内联编辑区
      const editBox = el("div", "mi-edit-box");
      const nameIn = el("input", "f-input") as HTMLInputElement;
      nameIn.placeholder = "预设名（如 医学 / 法律 / 游戏）";
      nameIn.value = p.name;
      const textIn = el("textarea", "f-input f-area") as HTMLTextAreaElement;
      textIn.placeholder = "翻译要求，如：医学领域文本，术语按规范译法，保持正式语气。";
      textIn.value = p.text;
      textIn.spellcheck = false;
      const editRow = el("div", "row-end");
      const saveBtn = el("button", "btn small tint", "保存");
      editRow.appendChild(saveBtn);
      editBox.append(nameIn, textIn, editRow);
      if (promptEditing === p.name) item.classList.add("editing");

      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const on = item.classList.toggle("editing");
        promptEditing = on ? p.name : "";
      });
      [nameIn, textIn].forEach((inp) => inp.addEventListener("click", (e) => e.stopPropagation()));

      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pr2 = ensurePrompts(settings);
        const tgt = pr2.presets.find((x) => x.name === p.name);
        if (!tgt) return;
        const newName = nameIn.value.trim() || tgt.name;
        if (pr2.presets.some((x) => x !== tgt && x.name === newName)) {
          toast(`已有同名提示词「${newName}」`, false);
          return;
        }
        if (pr2.selected === tgt.name) pr2.selected = newName;
        tgt.name = newName;
        tgt.text = textIn.value.trim();
        promptEditing = "";
        await saveSettings(settings);
        renderPrompts();
        renderQuick();
        toast("已保存提示词");
      });

      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const pr2 = ensurePrompts(settings);
        pr2.presets = pr2.presets.filter((x) => x.name !== p.name);
        if (pr2.selected === p.name) pr2.selected = "";
        if (promptEditing === p.name) promptEditing = "";
        await saveSettings(settings);
        renderPrompts();
        renderQuick();
        toast(`已删除提示词 ${p.name}`);
      });

      item.addEventListener("click", async () => {
        const pr2 = ensurePrompts(settings);
        if (pr2.selected === p.name) return;
        pr2.selected = p.name;
        await saveSettings(settings);
        renderPrompts();
        renderQuick();
        toast(`领域提示词：${p.name}`);
      });

      item.append(el("div", "mi-radio"), info, editBtn, rmBtn, editBox);
      list.appendChild(item);
    }
  }

  $("prompt-add").addEventListener("click", async () => {
    const pr = ensurePrompts(settings);
    let n = 1;
    while (pr.presets.some((x) => x.name === `领域 ${n}`)) n++;
    const p = { name: `领域 ${n}`, text: "" };
    pr.presets.push(p);
    pr.selected = p.name;
    promptEditing = p.name; // 新建后直接展开编辑
    await saveSettings(settings);
    renderPrompts();
    renderQuick();
  });

  // ── 底栏快速切换（领域提示词 / API 预设）──
  function renderQuick() {
    const box = $("qs-box");
    box.innerHTML = "";
    const pr = ensurePrompts(settings);
    const llmCapable = settings.local.mode === "qwen" || settings.local.mode === "api";

    if (llmCapable && pr.presets.length > 0) {
      const items: [string, string][] = [
        ["", "通用翻译"],
        ...pr.presets.map((p) => [p.name, p.name] as [string, string]),
      ];
      const cur = items.some(([v]) => v === pr.selected) ? pr.selected : "";
      const dd = makeDropdown(items, cur, async (v) => {
        ensurePrompts(settings).selected = v;
        await saveSettings(settings);
        toast(v ? `领域提示词：${v}` : "通用翻译（无附加要求）");
      });
      dd.root.classList.add("up");
      const wrap = el("div", "qs-item");
      wrap.append(el("span", "qs-label", "领域"), dd.root);
      box.appendChild(wrap);
    }

    if (settings.local.mode === "api" && settings.api.profiles.length > 1) {
      const items: [string, string][] = settings.api.profiles.map((p) => [p.name, p.name]);
      const dd = makeDropdown(items, settings.api.selected, async (v) => {
        settings.api.selected = v;
        await saveSettings(settings);
        refreshBadge();
        toast(`API 预设：${v}`);
      });
      dd.root.classList.add("up");
      const wrap = el("div", "qs-item");
      wrap.append(el("span", "qs-label", "预设"), dd.root);
      box.appendChild(wrap);
    }
  }

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
    renderQuick();
  });

  // 启动时预扫一次，让徽章/设置页状态就绪
  refreshModels();
  renderQuick();
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

  const { target } = resolveLangPair(settings, text);
  translating = true;
  btn.disabled = true;
  beginLoading();

  let started = false;
  const dst = $("dst-text");
  const caret = document.createElement("span");
  caret.className = "stream-caret";

  await llmStream(p, translateMessages(text, target, false, activeDomainPrompt(settings)), {
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
