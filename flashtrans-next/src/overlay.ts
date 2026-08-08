// FlashTrans 截图翻译「原位覆盖」：在框选区域上方开一个同尺寸置顶窗口，
// 把译文盖回原文所在的位置；可一键切回原文。
// 翻译在这里完成，完成后把整段原文/译文回传给悬浮弹窗（供复制 / 追问 / 贴图），
// 因此不会和弹窗重复翻译一遍。
//
// 排版有两种：
//   原位（inplace）— 逐段贴回原处，全图统一字号，塞不下就让方块长进旁边的空白；
//   整块（panel） — 整个框选区重排成一张版面，适合成段的文档（逐段贴回没有意义，
//                    而且译文长度和原文对不上，硬塞必然压字）。
// auto 按文字密度自己选，用户可用工具条 / Tab 键随时切换。
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  loadSettings, saveSettings, activeProfile, activeDomainPrompt,
  resolveLangPair, llmStream, translateMessages, localTranslate, localReady, langEnglish,
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

/** 布局用的方框，单位是 CSS 像素（payload 里的坐标是截图物理像素） */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Layout = "inplace" | "panel";
type Msg = { role: string; content: string };

const MIN_SIZE = 9;
const MAX_SIZE = 34;
/** 低于这个字号就别硬撑原位了，改整块重排 */
const READABLE = 11;
/** 一次批量翻译最多带几段，太多容易让模型漏条 */
const BATCH = 24;
/** 允许多大比例的块「怎么缩都装不下」；超过就说明整块重排更合适 */
const HOPELESS_RATIO = 0.2;

let payload: OverlayPayload | null = null;
let settings: Settings | null = null;
let showingSource = false;
/** 每段的译文，未完成/失败的是空串 */
let texts: string[] = [];
let failed = 0;
let layout: Layout = "inplace";
/** 用户在这一轮手动指定过排版，就不再让 auto 覆盖它 */
let layoutPinned = false;
/** 每次打开自增：迟到的翻译结果属于上一轮时直接丢弃 */
let round = 0;

/* ───────── 取色：让译文块盖住原文且颜色不突兀 ───────── */

interface Palette {
  bg: string;
  fg: string;
}

/**
 * 取一块区域的背景色：缩到小图后按 5bit 量化取众数。
 * 文字只占少数像素，众数就是背景；比取中位亮度更稳（深色卡片上的浅色标题不会把底色带偏）。
 */
/** 取色结果按块缓存：一轮里会重排很多次，没必要每次都重新读一遍像素 */
const paletteCache = new Map<string, Palette>();

function palette(img: HTMLImageElement, x: number, y: number, w: number, h: number): Palette {
  const key = `${x}|${y}|${w}|${h}`;
  const hit = paletteCache.get(key);
  if (hit) return hit;
  const got = samplePalette(img, x, y, w, h);
  paletteCache.set(key, got);
  return got;
}

function samplePalette(img: HTMLImageElement, x: number, y: number, w: number, h: number): Palette {
  const fallback = { bg: "rgb(24,26,32)", fg: "#f5f7fa" };
  const cw = Math.max(1, Math.min(64, Math.round(w)));
  const ch = Math.max(1, Math.min(32, Math.round(h)));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.imageSmoothingEnabled = false; // 缩放时别把文字和背景糊成一片
  try {
    ctx.drawImage(img, x, y, Math.max(1, w), Math.max(1, h), 0, 0, cw, ch);
    const { data } = ctx.getImageData(0, 0, cw, ch);
    const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = hist.get(key);
      if (e) {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else {
        hist.set(key, { n: 1, r, g, b });
      }
    }
    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (const e of hist.values()) if (!best || e.n > best.n) best = e;
    if (!best) return fallback;
    const r = Math.round(best.r / best.n);
    const g = Math.round(best.g / best.n);
    const b = Math.round(best.b / best.n);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return { bg: `rgb(${r},${g},${b})`, fg: lum < 140 ? "#f5f7fa" : "#14161c" };
  } catch {
    return fallback; // 跨源等异常场景直接退回默认配色
  }
}

/* ───────── 排版：先量、再定一个全图统一的字号 ───────── */

/** 在给定宽度和字号下，这段文字要多高 */
function measureH(text: string, wCss: number, size: number, lh = 1.25): number {
  const m = $("meas");
  m.style.lineHeight = String(lh);
  m.style.width = `${Math.max(8, wCss)}px`;
  m.style.fontSize = `${size}px`;
  m.textContent = text;
  return m.scrollHeight;
}

/** 单块能用的最大字号（二分，整数档） */
function fitSize(text: string, wCss: number, hCss: number, lh = 1.25): number {
  if (measureH(text, wCss, MIN_SIZE, lh) > hCss) return 0;
  let lo = MIN_SIZE;
  let hi = MAX_SIZE;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureH(text, wCss, mid, lh) <= hCss) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 全图统一字号。取各块能用字号的 20 分位而不是最小值：一两个 OCR 噪声小框
 * 不该把整张图的字都压小，落在分位数以下的那几块自己再缩一点。
 * 返回 0 = 装不下的块太多，原位排版已经没意义。
 */
function commonSize(ideal: number[]): number {
  const usable = ideal.filter((v) => v > 0).sort((a, b) => a - b);
  if (!usable.length) return 0;
  if (ideal.length - usable.length > ideal.length * HOPELESS_RATIO) return 0;
  return usable[Math.floor((usable.length - 1) * 0.2)];
}

/** 截图物理像素 → 覆盖层 CSS 像素的比例 */
function scaleK(p: OverlayPayload): number {
  const host = $("blocks");
  const w = host.clientWidth || window.innerWidth;
  return p.w > 0 ? w / p.w : 1;
}

/** OCR 框贴着字轮廓，四周留点余量才盖得住原文的升降部 */
function padBox(b: Block, k: number, W: number, H: number): Box {
  const pad = Math.max(1, b.h * k * 0.16);
  const x = Math.max(0, b.x * k - pad);
  const y = Math.max(0, b.y * k - pad);
  return {
    x,
    y,
    w: Math.max(6, Math.min(W - x, b.w * k + pad * 2)),
    h: Math.max(6, Math.min(H - y, b.h * k + pad * 2)),
  };
}

/**
 * 每块能往下 / 往右长到哪：撞上相邻的块或截图边缘为止。
 * 译文比原文长是常态，只缩字号会缩到看不清，先让方块吃掉旁边的空白更划算。
 */
function grow(i: number, boxes: Box[], W: number, H: number): Box {
  const b = boxes[i];
  let bottom = H;
  let right = W;
  for (let j = 0; j < boxes.length; j++) {
    if (j === i) continue;
    const o = boxes[j];
    const hOverlap = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x) > 0;
    const vOverlap = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y) > 0;
    if (hOverlap && o.y >= b.y + b.h - 1) bottom = Math.min(bottom, o.y);
    if (vOverlap && o.x >= b.x + b.w - 1) right = Math.min(right, o.x);
  }
  return { x: b.x, y: b.y, w: Math.max(b.w, right - b.x), h: Math.max(b.h, bottom - b.y) };
}

/**
 * 原位排版。字号全图统一（这是用户最直接的诉求：一张图里的译文不该大小不一），
 * 塞不下先让方块生长，仍旧塞不下就返回 false 让调用方改用整块重排 —— 绝不裁字。
 */
function renderInPlace(p: OverlayPayload, force: boolean): boolean {
  const host = $("blocks");
  const img = $("shot") as HTMLImageElement;
  const k = scaleK(p);
  const W = host.clientWidth || window.innerWidth;
  const H = host.clientHeight || window.innerHeight;

  const padded = p.blocks.map((b) => padBox(b, k, W, H));
  const boxes = padded.map((_, i) => grow(i, padded, W, H));
  // 未译完的块先用原文参与量字号，字号才不会随着译文一条条到位反复跳
  const draft = p.blocks.map((b, i) => texts[i] || b.text);
  const ideal = draft.map((t, i) => fitSize(t, boxes[i].w - 8, boxes[i].h - 3));
  const size = commonSize(ideal);
  if (!size || (!force && size < READABLE)) return false;

  host.innerHTML = "";
  p.blocks.forEach((b, i) => {
    const text = texts[i];
    if (!text) return; // 还没译好 / 译失败：留着原文露出来，别拿占位符糊住
    const box = boxes[i];
    const el = document.createElement("div");
    el.className = "blk";
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    // 落在分位数以下的少数块自己再缩；一块都装不下（ideal=0）就放它溢出，
    // 宁可稍微压到邻块也不裁掉半句话
    const fs = ideal[i] ? Math.min(size, ideal[i]) : MIN_SIZE;
    el.style.fontSize = `${fs}px`;
    if (!ideal[i]) {
      el.style.height = "auto";
      el.style.minHeight = `${box.h}px`;
    }
    const col = palette(img, b.x, b.y, b.w, b.h);
    el.style.background = col.bg;
    el.style.color = col.fg;
    el.textContent = text;
    // 单行的小块（标签、按钮、字幕）垂直居中才不显得往上飘
    if (measureH(text, box.w - 8, fs) <= fs * 1.8) el.classList.add("mid");
    host.appendChild(el);
  });
  return true;
}

/** 整块重排：一张盖住整个框选区的版面，段落之间空一行，字号统一到刚好装下 */
function renderPanel(p: OverlayPayload) {
  const host = $("blocks");
  host.innerHTML = "";
  if (!texts.some(Boolean)) return; // 一段都还没译出来，先让原图露着
  const img = $("shot") as HTMLImageElement;
  const W = host.clientWidth || window.innerWidth;
  const H = host.clientHeight || window.innerHeight;
  const body = p.blocks.map((b, i) => texts[i] || b.text).join("\n\n");

  const panel = document.createElement("div");
  panel.className = "panel";
  const col = palette(img, 0, 0, p.w, p.h);
  panel.style.background = col.bg;
  panel.style.color = col.fg;
  panel.textContent = body;
  panel.style.fontSize = `${fitSize(body, W - 20, H - 16, 1.5) || MIN_SIZE}px`;
  host.appendChild(panel);
}

/** 文字铺满大半个框选区 = 成段的文档，逐段贴回没意义，直接整块重排 */
function autoLayout(p: OverlayPayload): Layout {
  // 只有一段时原位就够了（排不下会自己降级），还能保住原来的留白
  if (p.blocks.length <= 1) return "inplace";
  const area = p.w * p.h;
  if (area <= 0) return "inplace";
  const covered = p.blocks.reduce((s, b) => s + b.w * b.h, 0);
  const wide = p.blocks.filter((b) => b.w > p.w * 0.6).length;
  return covered / area > 0.4 || (wide >= 3 && p.blocks.length >= 3) ? "panel" : "inplace";
}

function relayout() {
  if (!payload) return;
  if (layout === "inplace" && renderInPlace(payload, layoutPinned)) {
    syncBar();
    return;
  }
  layout = "panel"; // 原位排不下（哪怕用户点了原位）：整块重排至少保证字全、不压不裁
  renderPanel(payload);
  syncBar();
}

/* ───────── 翻译 ───────── */

/**
 * 批量翻译的提示词：一次把所有段落带上，模型按编号逐条译回。
 * 逐段单独请求既慢（N 次往返）又丢上下文 —— 一句话被切开后
 * 「有道」这种词会被当成人名 / 语种译错。
 */
function batchMessages(parts: string[], targetLang: string, domain: string): Msg[] {
  const langName = langEnglish(targetLang);
  let content =
    `You are a professional translator. The user's message contains ${parts.length} numbered ` +
    `segments, one per line, each beginning with a marker like [1]. Translate every segment into ` +
    `${langName}, using the other segments as context. Output exactly ${parts.length} lines, each ` +
    "beginning with the SAME marker, a space, then only the translation. Never merge, split, " +
    "reorder, drop or add segments, and never output anything else. " +
    "The text was extracted via OCR and may contain minor recognition errors; " +
    "silently correct obvious errors from context before translating.";
  if (domain.trim()) {
    content += ` Follow these additional requirements from the user (domain, terminology, style): ${domain.trim()}`;
  }
  content += " /no_think";
  const body = parts.map((t, i) => `[${i + 1}] ${t.replace(/\s*\n\s*/g, " ")}`).join("\n");
  return [
    { role: "system", content },
    { role: "user", content: body },
  ];
}

/** 按编号拆回逐段译文；有编号没对上就返回 null，交给逐段翻译兜底 */
function parseBatch(out: string, n: number): string[] | null {
  const res = new Array<string>(n).fill("");
  const seen = new Array<boolean>(n).fill(false);
  let cur = -1;
  for (const raw of out.split(/\r?\n/)) {
    const m = raw.match(/^\s*\[(\d+)\][.:、]?\s*/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < n) {
        cur = idx;
        seen[idx] = true;
        res[idx] = raw.slice(m[0].length).trim();
        continue;
      }
    }
    // 模型偶尔会把长句折行，续行并回上一段
    if (cur >= 0 && raw.trim()) res[cur] += (res[cur] ? " " : "") + raw.trim();
  }
  return seen.every(Boolean) ? res : null;
}

function llmOnce(s: Settings, messages: Msg[]): Promise<string> {
  const p = activeProfile(s);
  return new Promise<string>((resolve, reject) => {
    llmStream(
      p,
      messages,
      { onDelta: () => {}, onDone: (full) => resolve(full.trim()), onError: (m) => reject(new Error(m)) },
      0.2,
    );
  });
}

/** 逐段翻译（本地 NLLB / Opus 只能这样，批量协议它们看不懂） */
async function translateOneByOne(s: Settings, p: OverlayPayload, mine: number) {
  for (let i = 0; i < p.blocks.length; i++) {
    try {
      const out = localReady(s)
        ? await localTranslate(s, p.blocks[i].text, true)
        : await llmOnce(
            s,
            translateMessages(
              p.blocks[i].text,
              resolveLangPair(s, p.blocks[i].text).target,
              true,
              activeDomainPrompt(s),
            ),
          );
      if (mine !== round) return;
      texts[i] = out.trim();
      if (!texts[i]) failed++;
    } catch {
      if (mine !== round) return;
      failed++;
    }
    relayout();
  }
}

async function runTranslation(p: OverlayPayload, mine: number) {
  let s: Settings;
  try {
    s = await loadSettings();
  } catch {
    return;
  }
  settings = s;
  // 注意：这里不能调 applyScale —— 覆盖层必须和底下的截图 1:1 对齐，
  // 一旦跟随界面缩放，译文块就会整体错位。
  if (!layoutPinned) {
    const pref = s.snipOverlayLayout ?? "auto";
    layout = pref === "auto" ? autoLayout(p) : pref;
    layoutPinned = pref !== "auto";
  }
  relayout();

  // 没有可用引擎就立刻说清楚，否则弹窗会一直停在「正在翻译…」
  const api = activeProfile(s);
  if (!localReady(s) && (!api.baseUrl || !api.model)) {
    const msg = "尚未配置翻译引擎。按 F5 打开主窗口 → ⚙ 设置（选择本地模型或填写 API）。";
    setTip(msg, true);
    await emitTo("popup", "popup-mode", {
      mode: "ocr", error: msg, cropB64: p.img, cropW: p.cssW, cropH: p.cssH,
    });
    return;
  }

  if (localReady(s)) {
    await translateOneByOne(s, p, mine);
  } else {
    // 整段方向统一判定：逐段判会让同一张图里一半译成中文、一半译回英文
    const all = p.blocks.map((b) => b.text).join("\n");
    const { target } = resolveLangPair(s, all);
    const domain = activeDomainPrompt(s);
    for (let from = 0; from < p.blocks.length; from += BATCH) {
      const slice = p.blocks.slice(from, from + BATCH).map((b) => b.text);
      let parsed: string[] | null = null;
      try {
        parsed = parseBatch(await llmOnce(s, batchMessages(slice, target, domain)), slice.length);
      } catch {
        parsed = null;
      }
      if (mine !== round) return;
      if (!parsed) {
        // 模型没按编号回，退回逐段翻译（慢，但至少不会串行错位）
        await translateOneByOne(s, p, mine);
        if (mine !== round) return;
        break;
      }
      parsed.forEach((t, i) => (texts[from + i] = t));
      relayout();
    }
  }
  if (mine !== round) return;

  if (failed) setTip(`${failed} 段未能翻译，已保留原文`, true);
  else setTip("");
  // 回传给悬浮弹窗：那边负责复制原文/译文、追问、贴图
  await emitTo("popup", "popup-mode", {
    mode: "ocr",
    source: p.blocks.map((b) => b.text).join("\n"),
    translated: p.blocks.map((b, i) => texts[i] || b.text).join("\n"),
    cropB64: p.img,
    cropW: p.cssW,
    cropH: p.cssH,
  });
}

/* ───────── 生命周期 ───────── */

/** warn = 出错提示，不参与「露一下就淡出」的动画 */
function setTip(msg: string, warn = false) {
  const tip = $("tip");
  tip.style.display = msg ? "" : "none";
  tip.classList.toggle("warn", warn);
  if (msg) tip.textContent = msg;
}

function syncBar() {
  const tiny = document.body.classList.contains("tiny");
  $("btn-layout").textContent = layout === "panel" ? (tiny ? "位" : "原位覆盖") : tiny ? "块" : "整块重排";
  $("btn-toggle").textContent = showingSource ? (tiny ? "译" : "显示译文") : tiny ? "原" : "显示原文";
  $("btn-close").textContent = tiny ? "✕" : "关闭";
}

function setToggle(sourceMode: boolean) {
  showingSource = sourceMode;
  $("blocks").classList.toggle("hidden", sourceMode);
  syncBar();
}

async function switchLayout() {
  layout = layout === "panel" ? "inplace" : "panel";
  layoutPinned = true;
  relayout();
  if (!settings) return;
  settings.snipOverlayLayout = layout;
  try {
    await saveSettings(settings);
  } catch {
    // 存不下就只对本次生效，不打断阅读
  }
}

/** 截图很小时把工具条缩成图标贴右下角，否则按钮会把整块译文盖住 */
function applyTinyLayout() {
  const tiny = window.innerWidth < 300 || window.innerHeight < 76;
  document.body.classList.toggle("tiny", tiny);
}

async function pull() {
  const data = (await invoke("overlay_data")) as OverlayPayload | null;
  if (!data) return;
  payload = data;
  round++;
  const mine = round;
  texts = new Array(data.blocks.length).fill("");
  failed = 0;
  layoutPinned = false;
  paletteCache.clear();
  applyTinyLayout();
  setToggle(false);
  setTip("空格 对照原文 · Tab 换排版 · Esc 关闭");

  const img = $("shot") as HTMLImageElement;
  img.src = data.img;
  // 底图必须先解码完：palette() 要从它取色，窗口也要等它就位再亮（见 close 里的说明）
  await Promise.race([
    img.decode().catch(() => {}),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  if (mine !== round) return;

  await invoke("overlay_ready");
  runTranslation(data, mine);
}

/**
 * 清空画面内容。必须在窗口还看得见的时候做，清空才会被真正画进图层。
 * 窗口隐藏期间 WebView 不合成，图层里会一直存着上一轮的画面，
 * 下次显示时先亮那一帧旧的（而且是按旧尺寸拉伸的），看起来就是"从大变小闪一下"。
 */
function clearVisual() {
  round++; // 顺带让进行中的翻译结果作废
  ($("shot") as HTMLImageElement).removeAttribute("src");
  $("blocks").innerHTML = "";
}

async function close() {
  clearVisual();
  await invoke("overlay_close");
}

window.addEventListener("DOMContentLoaded", () => {
  pull();
  listen("overlay-open", () => pull());
  // F3 会直接把这个置顶窗口收起来（免得被截进新截图），走不到 close()，
  // 所以那边先发这个事件让我们把画面清干净
  listen("overlay-clear", () => clearVisual());
  window.addEventListener("resize", () => {
    applyTinyLayout();
    relayout();
  });

  $("btn-close").addEventListener("click", close);
  $("btn-toggle").addEventListener("click", () => setToggle(!showingSource));
  $("btn-layout").addEventListener("click", switchLayout);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Tab") {
      e.preventDefault();
      switchLayout();
    } else if (e.key === " " && payload) {
      e.preventDefault();
      setToggle(!showingSource); // 空格快速对照原文
    }
  });
});
