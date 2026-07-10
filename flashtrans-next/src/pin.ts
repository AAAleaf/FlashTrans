// FlashTrans 贴图置顶窗口
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const win = getCurrentWindow();

// 当前窗口物理尺寸，滚轮缩放时按比例整体放大/缩小，保持长宽比
let curW = 0;
let curH = 0;

async function syncSize() {
  const s = await win.innerSize();
  curW = s.width;
  curH = s.height;
}

async function pull() {
  const data = (await invoke("pin_data")) as string | null;
  if (data) ($("pin-img") as HTMLImageElement).src = data;
  await syncSize();
}

window.addEventListener("DOMContentLoaded", () => {
  pull();
  listen("pin-open", () => pull());

  // 滚轮缩放贴图（上滚放大、下滚缩小），保持长宽比
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!curW || !curH) return;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ratio = curH / curW;
      curW = Math.max(80, Math.min(4000, Math.round(curW * f)));
      curH = Math.max(60, Math.round(curW * ratio));
      win.setSize(new PhysicalSize(curW, curH));
    },
    { passive: false },
  );

  $("pin-copy").addEventListener("click", async () => {
    const src = ($("pin-img") as HTMLImageElement).src;
    if (src) await invoke("copy_image", { b64: src });
  });
  $("pin-x").addEventListener("click", () => invoke("pin_close"));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") invoke("pin_close");
  });
  document.addEventListener("dblclick", () => invoke("pin_close"));
});
