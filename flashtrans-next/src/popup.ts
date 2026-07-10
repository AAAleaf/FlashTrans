// FlashTrans 悬浮弹窗（F1 划词 / F2 打字）
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  loadSettings, activeProfile, applyTheme, applyScale, onSettingsChanged,
  resolveTarget, llmStream, translateMessages, localTranslate, localReady,
  ocrCorrectAvailable, ocrCorrectMessages, localCorrectOcr,
  type Settings,
} from "./shared";

const win = getCurrentWindow();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const POPUP_W = 420;
const RING_C = 56.55;

let settings: Settings;
let mode: "f1" | "f2" = "f1";
let f1Source = "";
let f1Final = "";
let f2Final = "";
let f2Streaming = false;
let pendingCommit = false;
let debounceTimer: number | undefined;

// “点击外部关闭”：只有获焦窗口才能感知失焦，故仅在结果展示时才抓取焦点
let resultShown = false;
let blurHideTimer: number | undefined;

function maybeGrabFocus() {
  if (settings?.closeOnBlur) {
    resultShown = true;
    invoke("popup_grab_focus").catch(() => {});
  }
}

// F3 截图带过来的裁剪图（供“复制截图 / 贴图”按钮使用）
let cropB64 = "";
let cropW = 0;
let cropH = 0;

function setCrop(b64?: string, w?: number, h?: number) {
  cropB64 = b64 || "";
  cropW = w || 0;
  cropH = h || 0;
  const has = Boolean(cropB64);
  $("f1-copyimg").style.display = has ? "" : "none";
  $("f1-pin").style.display = has ? "" : "none";
}

/* ───────── 视图切换与自适应高度 ───────── */

function show(view: "f1" | "f2" | "status") {
  $("view-f1").style.display = view === "f1" ? "" : "none";
  $("view-f2").style.display = view === "f2" ? "" : "none";
  $("view-status").style.display = view === "status" ? "" : "none";
}

function fitHeight() {
  requestAnimationFrame(() => {
    const h = Math.min(560, Math.max(96, document.getElementById("pop")!.scrollHeight + 4));
    invoke("popup_resize", { width: POPUP_W, height: h }).catch(() => {});
  });
}

function replayEntrance() {
  const pop = $("pop");
  pop.style.animation = "none";
  requestAnimationFrame(() => requestAnimationFrame(() => (pop.style.animation = "")));
}

/* ───────── 自动关闭倒计时（悬停暂停） ───────── */

let countdownTimer: number | undefined;
let remainMs = 0;
let hovering = false;

function stopCountdown() {
  window.clearInterval(countdownTimer);
  countdownTimer = undefined;
  $("ring-wrap").style.display = "none";
}

function startCountdown() {
  stopCountdown();
  const secs = settings?.popupStaySecs ?? 8;
  if (!secs || secs <= 0) return;
  remainMs = secs * 1000;
  const total = remainMs;
  $("ring-wrap").style.display = "";
  const fg = $("ring-fg") as unknown as SVGCircleElement;
  fg.style.strokeDashoffset = "0";
  countdownTimer = window.setInterval(() => {
    if (hovering) return; // 悬停暂停，继续阅读
    remainMs -= 100;
    fg.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, remainMs) / total));
    if (remainMs <= 0) {
      stopCountdown();
      win.hide();
    }
  }, 100);
}

document.addEventListener("mouseenter", () => (hovering = true));
document.addEventListener("mouseleave", () => (hovering = false));
document.addEventListener("mousemove", () => (hovering = true));

/* ───────── F1 划词 ───────── */

function f1Grabbing() {
  mode = "f1";
  $("tag").textContent = "划词翻译";
  $("status-text").textContent = "正在读取选中文本…";
  show("status");
  stopCountdown();
  replayEntrance();
  fitHeight();
}

/** OCR 原文纠错分发：本地 qwen 走 Rust 原生，API 走一次性 LLM 调用。调用前已确保后端可纠错。 */
async function correctOcr(text: string): Promise<string> {
  if (localReady(settings) && settings.local.mode === "qwen") {
    return localCorrectOcr(settings, text);
  }
  const p = activeProfile(settings);
  return await new Promise<string>((resolve, reject) => {
    llmStream(
      p,
      ocrCorrectMessages(text),
      {
        onDelta: () => {},
        onDone: (full) => resolve(full.trim()),
        onError: (m) => reject(new Error(m)),
      },
      0,
    );
  });
}

async function f1GotText(text: string, title = "划词翻译", ocr = false) {
  // OCR 纠错仅对大模型（GGUF/qwen）与 API 生效，NLLB/Opus 走 bridge 会忽略该标志；
  // 用户可在设置里关。ocrEnabled 缺省视为开（与默认设置一致）。
  const doOcr = ocr && settings.local.ocrEnabled !== false;
  if (!text) {
    $("tag").textContent = title;
    show("f1");
    $("f1-src").style.display = "none";
    (document.querySelector("#view-f1 .divider") as HTMLElement).style.display = "none";
    const dst = $("f1-dst");
    dst.classList.add("err");
    dst.textContent = "未能获取选中文本。可能当前页面禁止复制，或没有选中文字。\n提示：按 F2 手动输入翻译。";
    $<HTMLButtonElement>("f1-copy").disabled = true;
    $<HTMLButtonElement>("f1-copysrc").disabled = true;
    $<HTMLButtonElement>("f1-ask").disabled = true;
    maybeGrabFocus();
    startCountdown();
    fitHeight();
    return;
  }

  f1Source = text;
  f1Final = "";
  $("tag").textContent = title;
  show("f1");
  $("f1-src").style.display = "";
  (document.querySelector("#view-f1 .divider") as HTMLElement).style.display = "";
  $("f1-src").textContent = text;
  const dst = $("f1-dst");
  dst.classList.remove("err");
  dst.innerHTML = "";
  $<HTMLButtonElement>("f1-copy").disabled = true;
  $<HTMLButtonElement>("f1-copysrc").disabled = false;
  $<HTMLButtonElement>("f1-ask").disabled = true;
  stopCountdown();
  fitHeight();
  maybeGrabFocus();

  // ── OCR 原文纠错：有 LLM 后端（qwen/API）时先用上下文修正识别错字，
  //    让展示与「复制原文」都干净；纠正后翻译不必再走 in-prompt 纠错。 ──
  let transOcr = doOcr;
  if (doOcr && !ocrCorrectAvailable(settings)) {
    // 明示纠错被跳过的原因，避免“开了开关却没反应”的困惑
    $("tag").textContent = `${title} · 纠错需 GGUF/API 引擎`;
  }
  if (doOcr && ocrCorrectAvailable(settings)) {
    dst.textContent = "正在校正原文…";
    fitHeight();
    try {
      const cleaned = await correctOcr(text);
      if (cleaned) {
        text = cleaned;
        f1Source = cleaned;
        $("f1-src").textContent = cleaned;
        transOcr = false;
        $("tag").textContent = `${title} · 已纠错`;
      }
    } catch {
      // 纠错失败：退回原始文本继续翻译，不阻塞，但在标题上说明
      $("tag").textContent = `${title} · 纠错失败`;
    }
    dst.textContent = "";
    fitHeight();
  }

  // ── 本地离线模型 ──
  if (localReady(settings)) {
    const caret = document.createElement("span");
    caret.className = "stream-caret";
    dst.appendChild(caret);
    try {
      const out = await localTranslate(settings, text, transOcr);
      f1Final = out;
      dst.textContent = out || "（无翻译结果）";
      $<HTMLButtonElement>("f1-copy").disabled = !out;
      $<HTMLButtonElement>("f1-ask").disabled = !out;
    } catch (e) {
      dst.classList.add("err");
      dst.textContent = String(e);
    }
    startCountdown();
    fitHeight();
    return;
  }

  const p = activeProfile(settings);
  if (!p.baseUrl || !p.model) {
    dst.classList.add("err");
    dst.textContent = "尚未配置翻译引擎。按 F5 打开主窗口 → ⚙ 设置（选择本地模型或填写 API）。";
    startCountdown();
    fitHeight();
    return;
  }

  const caret = document.createElement("span");
  caret.className = "stream-caret";
  dst.appendChild(caret);
  const target = resolveTarget(text, settings.sourceLang, settings.targetLang);

  await llmStream(p, translateMessages(text, target, transOcr), {
    onDelta: (t) => {
      caret.insertAdjacentText("beforebegin", t);
      fitHeight();
    },
    onDone: (full) => {
      f1Final = full;
      dst.textContent = full;
      $<HTMLButtonElement>("f1-copy").disabled = false;
      $<HTMLButtonElement>("f1-ask").disabled = false;
      startCountdown();
      fitHeight();
    },
    onError: (m) => {
      dst.classList.add("err");
      dst.textContent = m;
      startCountdown();
      fitHeight();
    },
  });
}

/* ───────── F3 OCR 结果 ───────── */

function showStatus(text: string) {
  $("tag").textContent = "FlashTrans";
  $("status-text").textContent = text;
  show("status");
  stopCountdown();
  replayEntrance();
  fitHeight();
}

function ocrResult(source: string, translated: string, error?: string) {
  $("tag").textContent = "OCR 翻译";
  show("f1");
  const dst = $("f1-dst");
  const srcEl = $("f1-src");
  const divider = document.querySelector("#view-f1 .divider") as HTMLElement;
  if (error) {
    srcEl.style.display = "none";
    divider.style.display = "none";
    dst.classList.add("err");
    dst.textContent = error;
    $<HTMLButtonElement>("f1-copy").disabled = true;
    $<HTMLButtonElement>("f1-copysrc").disabled = true;
    $<HTMLButtonElement>("f1-ask").disabled = true;
  } else {
    f1Source = source;
    f1Final = translated;
    srcEl.style.display = "";
    divider.style.display = "";
    srcEl.textContent = source;
    dst.classList.remove("err");
    dst.textContent = translated || "（未翻译）";
    $<HTMLButtonElement>("f1-copy").disabled = !translated;
    $<HTMLButtonElement>("f1-copysrc").disabled = !source;
    $<HTMLButtonElement>("f1-ask").disabled = !source;
  }
  maybeGrabFocus();
  startCountdown();
  fitHeight();
}

/* ───────── F2 打字 ───────── */

function f2Open() {
  mode = "f2";
  $("tag").textContent = "打字翻译";
  show("f2");
  stopCountdown();
  const input = $<HTMLTextAreaElement>("f2-input");
  input.value = "";
  f2Final = "";
  f2Streaming = false;
  pendingCommit = false;
  $("f2-live").style.display = "none";
  $("f2-dst").textContent = "";
  replayEntrance();
  fitHeight();
  setTimeout(() => input.focus(), 60);
}

async function f2Translate(commitAfter = false) {
  const input = $<HTMLTextAreaElement>("f2-input");
  const text = input.value.trim();
  if (!text) return;

  const p = activeProfile(settings);
  const dst = $("f2-dst");
  $("f2-live").style.display = "";

  if (!localReady(settings) && (!p.baseUrl || !p.model)) {
    dst.classList.add("err");
    dst.textContent = "尚未配置翻译引擎。按 F5 打开主窗口 → ⚙ 设置（选择本地模型或填写 API）。";
    fitHeight();
    return;
  }

  pendingCommit = commitAfter;
  f2Streaming = true;
  f2Final = "";
  dst.classList.remove("err");
  dst.innerHTML = "";
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  dst.appendChild(caret);
  fitHeight();

  // ── 本地离线模型 ──
  if (localReady(settings)) {
    try {
      const out = await localTranslate(settings, text);
      f2Streaming = false;
      f2Final = out;
      dst.textContent = out || "（无翻译结果）";
      fitHeight();
      if (pendingCommit && out) {
        pendingCommit = false;
        await invoke("commit_paste", { text: out });
      }
    } catch (e) {
      f2Streaming = false;
      pendingCommit = false;
      dst.classList.add("err");
      dst.textContent = String(e);
      fitHeight();
    }
    return;
  }

  const target = resolveTarget(text, settings.sourceLang, settings.targetLang);
  await llmStream(p, translateMessages(text, target), {
    onDelta: (t) => {
      caret.insertAdjacentText("beforebegin", t);
      fitHeight();
    },
    onDone: async (full) => {
      f2Streaming = false;
      f2Final = full;
      dst.textContent = full;
      fitHeight();
      if (pendingCommit && full) {
        pendingCommit = false;
        await invoke("commit_paste", { text: full });
      }
    },
    onError: (m) => {
      f2Streaming = false;
      pendingCommit = false;
      dst.classList.add("err");
      dst.textContent = m;
      fitHeight();
    },
  });
}

/* ───────── 事件绑定 ───────── */

async function main() {
  settings = await loadSettings();
  applyTheme(settings.theme);
  applyScale(settings.uiScale);
  onSettingsChanged((s) => {
    settings = s;
    applyTheme(s.theme);
    applyScale(s.uiScale);
  });

  // 失焦即关（仅在“点击外部关闭”开启且正展示结果时）
  win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      window.clearTimeout(blurHideTimer);
      return;
    }
    if (!settings?.closeOnBlur || !resultShown) return;
    // 稍作防抖：避免重新触发 F1 时 set_focusable(false) 引起的瞬时失焦误关
    window.clearTimeout(blurHideTimer);
    blurHideTimer = window.setTimeout(() => {
      if (resultShown) {
        resultShown = false;
        stopCountdown();
        win.hide();
      }
    }, 150);
  });

  await listen("popup-mode", (e) => {
    const p = e.payload as {
      mode: string; state?: string; text?: string; title?: string;
      source?: string; translated?: string; error?: string;
      cropB64?: string; cropW?: number; cropH?: number; ocr?: boolean;
    };
    // 新一轮弹窗：清掉上一轮的失焦关闭状态
    resultShown = false;
    window.clearTimeout(blurHideTimer);
    if (p.mode === "f1") {
      if (p.state === "grabbing") { setCrop(); f1Grabbing(); }
      else if (p.state === "text") {
        setCrop(p.cropB64, p.cropW, p.cropH);
        f1GotText((p.text ?? "").trim(), p.title || "划词翻译", p.ocr === true);
      }
    } else if (p.mode === "f2") {
      setCrop();
      f2Open();
    } else if (p.mode === "status") {
      showStatus(p.text ?? "处理中…");
    } else if (p.mode === "ocr") {
      setCrop(p.cropB64, p.cropW, p.cropH);
      ocrResult(p.source ?? "", p.translated ?? "", p.error);
    }
  });

  $("btn-close").addEventListener("click", () => {
    stopCountdown();
    win.hide();
  });

  $("f1-copy").addEventListener("click", async () => {
    if (!f1Final) return;
    await invoke("copy_text", { text: f1Final });
    const b = $("f1-copy");
    const old = b.textContent;
    b.textContent = "已复制 ✓";
    setTimeout(() => (b.textContent = old), 1200);
  });

  $("f1-copysrc").addEventListener("click", async () => {
    if (!f1Source) return;
    await invoke("copy_text", { text: f1Source });
    const b = $("f1-copysrc");
    const old = b.textContent;
    b.textContent = "已复制 ✓";
    setTimeout(() => (b.textContent = old), 1200);
  });

  $("f1-ask").addEventListener("click", async () => {
    const chat = await WebviewWindow.getByLabel("chat");
    await chat?.show();
    await chat?.setFocus();
    await emitTo("chat", "chat-open", {
      clipboard: "",
      context: { source: f1Source, translated: f1Final },
    });
    stopCountdown();
    await win.hide();
  });

  $("f1-copyimg").addEventListener("click", async () => {
    if (!cropB64) return;
    await invoke("copy_image", { b64: cropB64 });
    const b = $("f1-copyimg");
    const old = b.textContent;
    b.textContent = "已复制 ✓";
    setTimeout(() => (b.textContent = old), 1200);
  });

  $("f1-pin").addEventListener("click", async () => {
    if (!cropB64) return;
    stopCountdown();
    await win.hide();
    await invoke("pin_show", { b64: cropB64, width: cropW || 320, height: cropH || 240 });
  });

  const input = $<HTMLTextAreaElement>("f2-input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(120, input.scrollHeight) + "px";
    fitHeight();
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => f2Translate(false), 450);
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.clearTimeout(debounceTimer);
      const text = input.value.trim();
      if (!text) return;
      if (!f2Streaming && f2Final) {
        await invoke("commit_paste", { text: f2Final });
      } else {
        f2Translate(true);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopCountdown();
      const text = input.value.trim();
      if (mode === "f2" && text) {
        await invoke("commit_paste", { text });
      } else {
        await win.hide();
      }
    }
  });

  // 全局 Esc（F1 结果态窗口未聚焦时收不到，但 F2 聚焦时兜底）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mode === "f1") {
      stopCountdown();
      win.hide();
    }
  });
}

window.addEventListener("DOMContentLoaded", main);
