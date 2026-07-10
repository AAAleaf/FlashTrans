// FlashTrans F3 区域截图框选（覆盖整个虚拟桌面，裁剪按图片自然/显示尺寸比例，DPI 无关）
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { loadSettings, type Settings } from "./shared";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let dragging = false;
let sx = 0;
let sy = 0;
let rect = { x: 0, y: 0, w: 0, h: 0 };
let ready = false;

async function pullShot() {
  const data = (await invoke("snip_data")) as string | null;
  const img = $("shot") as HTMLImageElement;
  ready = false;
  if (data) {
    // 图片加载完成后才允许框选，避免 naturalWidth 还是 0 导致裁剪比例错误
    img.onload = () => { ready = true; };
    img.src = data;
    if (img.complete && img.naturalWidth > 0) ready = true;
  }
  resetUi();
}

function resetUi() {
  dragging = false;
  $("sel").style.display = "none";
  $("dim-idle").style.display = "";
  $("hint").style.display = "";
}

async function cancel() {
  resetUi();
  await invoke("snip_hide");
}

// 显示尺寸 → 截图自然（物理）像素的换算比例；对任何 DPI/缩放都成立
function ratios() {
  const shot = $("shot") as HTMLImageElement;
  const rx = shot.clientWidth ? shot.naturalWidth / shot.clientWidth : 1;
  const ry = shot.clientHeight ? shot.naturalHeight / shot.clientHeight : 1;
  return { rx, ry };
}

function updateSel(x: number, y: number, w: number, h: number) {
  const sel = $("sel");
  sel.style.display = "block"; // 注意：CSS 里 #sel 默认 display:none，用 "" 会退回隐藏
  sel.style.left = `${x}px`;
  sel.style.top = `${y}px`;
  sel.style.width = `${w}px`;
  sel.style.height = `${h}px`;
  const { rx, ry } = ratios();
  $("size-tag").textContent = `${Math.round(w * rx)} × ${Math.round(h * ry)}`;
}

function cropDataUrl(): { url: string; wCss: number; hCss: number } {
  const shot = $("shot") as HTMLImageElement;
  const { rx, ry } = ratios();
  const cx = Math.round(rect.x * rx);
  const cy = Math.round(rect.y * ry);
  const cw = Math.max(1, Math.round(rect.w * rx));
  const ch = Math.max(1, Math.round(rect.h * ry));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(shot, cx, cy, cw, ch, 0, 0, cw, ch);
  return { url: canvas.toDataURL("image/png"), wCss: rect.w, hCss: rect.h };
}

async function confirmCrop() {
  const { url, wCss, hCss } = cropDataUrl();
  resetUi();
  await invoke("snip_hide");

  // 弹窗先展示识别中状态
  await invoke("popup_present", { width: 420, height: 118, focus: false });
  await emitTo("popup", "popup-mode", { mode: "status", text: "正在识别文字…" });

  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch {
    await emitTo("popup", "popup-mode", { mode: "ocr", error: "读取设置失败", cropB64: url, cropW: wCss, cropH: hCss });
    return;
  }

  try {
    const res = (await invoke("native_ocr", {
      req: { imageB64: url, sourceLang: settings.sourceLang },
    })) as { source?: string };
    const source = (res.source ?? "").trim();
    // 无论是否识别到文字，都把截图带过去，让弹窗能复制图 / 贴图
    if (!source) {
      await emitTo("popup", "popup-mode", {
        mode: "ocr", error: "未识别到文字（可复制或贴图这张截图）",
        cropB64: url, cropW: wCss, cropH: hCss,
      });
      return;
    }
    await emitTo("popup", "popup-mode", {
      mode: "f1", state: "text", text: source, title: "截图翻译", ocr: true,
      cropB64: url, cropW: wCss, cropH: hCss,
    });
  } catch (e) {
    await emitTo("popup", "popup-mode", {
      mode: "ocr", error: String(e), cropB64: url, cropW: wCss, cropH: hCss,
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // 主动拉取一次（覆盖首次窗口就绪早于事件的情况）
  pullShot();
  // 后续 F3 通过事件再次拉取
  listen("snip-open", () => pullShot());

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !ready) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    $("dim-idle").style.display = "none";
    $("hint").style.display = "none";
    updateSel(sx, sy, 0, 0);
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const x = Math.min(sx, e.clientX);
    const y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx);
    const h = Math.abs(e.clientY - sy);
    rect = { x, y, w, h };
    updateSel(x, y, w, h);
  });

  document.addEventListener("mouseup", async (e) => {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    if (rect.w < 6 || rect.h < 6) {
      resetUi();
      return;
    }
    await confirmCrop();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  });
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
  });
});
