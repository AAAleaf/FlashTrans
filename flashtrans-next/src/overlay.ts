// FlashTrans 截图翻译「原位覆盖」：在框选区域上方开一个同尺寸置顶窗口，
// 把每段译文盖回原文所在的位置；可一键切回原文。
// 翻译在这里逐段完成，完成后把整段原文/译文回传给悬浮弹窗（供复制 / 追问 / 贴图），
// 因此不会和弹窗重复翻译一遍。
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  loadSettings, activeProfile, activeDomainPrompt,
  resolveLangPair, llmStream, translateMessages, localTranslate, localReady,
  type Settings,
} from "./shared";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Block {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OverlayPayload {
  img: string;
  blocks: Block[];
  w: number;
  h: number;
  cssW: number;
  cssH: number;
}

let payload: OverlayPayload | null = null;
let showingSource = false;
/** 每次打开自增：迟到的翻译结果属于上一轮时直接丢弃 */
let round = 0;

/* ───────── 取色：让译文块盖住原文且颜色不突兀 ───────── */

interface Palette {
  bg: string;
  fg: string;
}

/** 取块内像素的中位亮度作背景（文字稀疏，中位数≈背景色），前景取黑/白中对比更高的 */
function palette(img: HTMLImageElement, b: Block): Palette {
  const fallback = { bg: "rgb(24,26,32)", fg: "#f5f7fa" };
  const cw = Math.max(1, Math.min(48, Math.round(b.w)));
  const ch = Math.max(1, Math.min(24, Math.round(b.h)));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  try {
    ctx.drawImage(img, b.x, b.y, Math.max(1, b.w), Math.max(1, b.h), 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const px: { l: number; r: number; g: number; b: number }[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, bl] = [data[i], data[i + 1], data[i + 2]];
      px.push({ l: 0.299 * r + 0.587 * g + 0.114 * bl, r, g, b: bl });
    }
    if (!px.length) return fallback;
    px.sort((a, c) => a.l - c.l);
    const mid = px[Math.floor(px.length / 2)];
    return {
      bg: `rgb(${mid.r},${mid.g},${mid.b})`,
      fg: mid.l < 140 ? "#f5f7fa" : "#14161c",
    };
  } catch {
    return fallback; // 跨源等异常场景直接退回默认配色
  }
}

/* ───────── 排版：把译文塞进原文的框里 ───────── */

function fitFont(el: HTMLElement, boxH: number) {
  // 从「一行刚好填满框高」起步逐级缩小，直到不溢出；下限 9px 再小就没法读了
  let size = Math.max(9, Math.min(boxH * 0.82, 40));
  el.style.fontSize = `${size}px`;
  for (let i = 0; i < 14; i++) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) break;
    size = Math.max(9, size * 0.88);
    el.style.fontSize = `${size}px`;
    if (size <= 9) break;
  }
}

function render(p: OverlayPayload) {
  const host = $("blocks");
  host.innerHTML = "";
  const img = $("shot") as HTMLImageElement;
  for (const b of p.blocks) {
    const el = document.createElement("div");
    el.className = "blk pending";
    el.style.left = `${(b.x / p.w) * 100}%`;
    el.style.top = `${(b.y / p.h) * 100}%`;
    el.style.width = `${(b.w / p.w) * 100}%`;
    el.style.height = `${(b.h / p.h) * 100}%`;
    const col = palette(img, b);
    el.style.background = col.bg;
    el.style.color = col.fg;
    el.textContent = "翻译中…";
    fitFont(el, el.clientHeight || b.h);
    host.appendChild(el);
  }
}

function setBlockText(i: number, text: string, err = false) {
  const el = $("blocks").children[i] as HTMLElement | undefined;
  if (!el) return;
  el.classList.remove("pending");
  if (err) el.classList.add("pending");
  el.textContent = text;
  fitFont(el, el.clientHeight);
}

/* ───────── 翻译 ───────── */

async function translateBlock(settings: Settings, text: string): Promise<string> {
  if (localReady(settings)) return localTranslate(settings, text, true);

  const p = activeProfile(settings);
  if (!p.baseUrl || !p.model) throw new Error("尚未配置翻译引擎");
  const { target } = resolveLangPair(settings, text);
  return await new Promise<string>((resolve, reject) => {
    llmStream(
      p,
      translateMessages(text, target, true, activeDomainPrompt(settings)),
      { onDelta: () => {}, onDone: (full) => resolve(full.trim()), onError: (m) => reject(new Error(m)) },
      0.2,
    );
  });
}

async function runTranslation(p: OverlayPayload, mine: number) {
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch {
    return;
  }
  // 注意：这里不能调 applyScale —— 覆盖层必须和底下的截图 1:1 对齐，
  // 一旦跟随界面缩放，译文块就会整体错位。

  // 没有可用引擎就立刻说清楚，否则弹窗会一直停在「正在翻译…」
  const api = activeProfile(settings);
  if (!localReady(settings) && (!api.baseUrl || !api.model)) {
    const msg = "尚未配置翻译引擎。按 F5 打开主窗口 → ⚙ 设置（选择本地模型或填写 API）。";
    p.blocks.forEach((_, i) => setBlockText(i, msg, true));
    await emitTo("popup", "popup-mode", {
      mode: "ocr", error: msg, cropB64: p.img, cropW: p.cssW, cropH: p.cssH,
    });
    return;
  }

  const outs: string[] = [];
  for (let i = 0; i < p.blocks.length; i++) {
    const src = p.blocks[i].text;
    try {
      const out = (await translateBlock(settings, src)).trim();
      if (mine !== round) return; // 已经开了新一轮，丢弃
      outs.push(out || src);
      setBlockText(i, out || src);
    } catch (e) {
      if (mine !== round) return;
      outs.push(src);
      setBlockText(i, String(e), true);
    }
  }
  if (mine !== round) return;

  // 回传给悬浮弹窗：那边负责复制原文/译文、追问、贴图
  await emitTo("popup", "popup-mode", {
    mode: "ocr",
    source: p.blocks.map((b) => b.text).join("\n"),
    translated: outs.join("\n"),
    cropB64: p.img,
    cropW: p.cssW,
    cropH: p.cssH,
  });
}

/* ───────── 生命周期 ───────── */

function setToggle(sourceMode: boolean) {
  showingSource = sourceMode;
  $("blocks").classList.toggle("hidden", sourceMode);
  const tiny = document.body.classList.contains("tiny");
  $("btn-toggle").textContent = sourceMode ? (tiny ? "译" : "显示译文") : tiny ? "原" : "显示原文";
  $("btn-close").textContent = tiny ? "✕" : "关闭";
}

/** 截图很小时把工具条缩成图标贴右下角，否则按钮会把整块译文盖住 */
function applyTinyLayout() {
  const tiny = window.innerWidth < 260 || window.innerHeight < 76;
  document.body.classList.toggle("tiny", tiny);
}

async function pull() {
  const data = (await invoke("overlay_data")) as OverlayPayload | null;
  if (!data) return;
  payload = data;
  round++;
  const mine = round;
  applyTinyLayout();
  setToggle(false);

  const img = $("shot") as HTMLImageElement;
  await new Promise<void>((resolve) => {
    // 底图必须先解码完，palette() 才能从它取色
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = data.img;
    if (img.complete && img.naturalWidth > 0) resolve();
  });
  if (mine !== round) return;

  render(data);
  runTranslation(data, mine);
}

async function close() {
  round++; // 让进行中的翻译结果作废
  await invoke("overlay_close");
}

window.addEventListener("DOMContentLoaded", () => {
  pull();
  listen("overlay-open", () => pull());
  window.addEventListener("resize", applyTinyLayout);

  $("btn-close").addEventListener("click", close);
  $("btn-toggle").addEventListener("click", () => setToggle(!showingSource));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === " " && payload) {
      e.preventDefault();
      setToggle(!showingSource); // 空格快速对照原文
    }
  });
});
