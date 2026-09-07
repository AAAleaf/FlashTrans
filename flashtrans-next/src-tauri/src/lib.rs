use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

mod gguf;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
mod win32 {
    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> isize;
        pub fn SetForegroundWindow(hwnd: isize) -> i32;
        pub fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        pub fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        pub fn GetDC(hwnd: isize) -> isize;
        pub fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        pub fn GetSystemMetrics(index: i32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThreadId() -> u32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        pub fn DwmSetWindowAttribute(hwnd: isize, attr: u32, val: *const core::ffi::c_void, size: u32) -> i32;
    }

    pub fn foreground_hwnd() -> isize {
        unsafe { GetForegroundWindow() }
    }

    pub fn refocus(hwnd: isize) {
        if hwnd == 0 {
            return;
        }
        unsafe {
            let cur = GetCurrentThreadId();
            let mut pid: u32 = 0;
            let tid = GetWindowThreadProcessId(hwnd, &mut pid);
            if tid != 0 {
                AttachThreadInput(cur, tid, 1);
            }
            SetForegroundWindow(hwnd);
            if tid != 0 {
                AttachThreadInput(cur, tid, 0);
            }
        }
    }

    pub fn round_corners(hwnd: isize) {
        let pref: u32 = 2;
        unsafe {
            DwmSetWindowAttribute(hwnd, 33, &pref as *const u32 as *const _, 4);
        }
    }

    /// 关掉 DWM 给这个窗口的显示/隐藏过渡动画（DWMWA_TRANSITIONS_FORCEDISABLED）。
    /// 全屏的框选窗口收起时，系统会播一段缩放动画，看起来像"那片阴影从大缩到小"。
    /// 截图这类瞬时工具窗口不该有这种动画。
    pub fn no_transitions(hwnd: isize) {
        let on: u32 = 1;
        unsafe {
            DwmSetWindowAttribute(hwnd, 3, &on as *const u32 as *const _, 4);
        }
    }

    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateCompatibleDC(hdc: isize) -> isize;
        pub fn CreateCompatibleBitmap(hdc: isize, w: i32, h: i32) -> isize;
        pub fn SelectObject(hdc: isize, obj: isize) -> isize;
        pub fn BitBlt(dst: isize, x: i32, y: i32, w: i32, h: i32, src: isize, x1: i32, y1: i32, rop: u32) -> i32;
        pub fn GetDIBits(hdc: isize, hbm: isize, start: u32, lines: u32, bits: *mut core::ffi::c_void, bi: *mut core::ffi::c_void, usage: u32) -> i32;
        pub fn DeleteObject(obj: isize) -> i32;
        pub fn DeleteDC(hdc: isize) -> i32;
    }

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }

    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;
    const SRCCOPY: u32 = 0x00CC_0020;
    const CAPTUREBLT: u32 = 0x4000_0000;

    /// 截取整个虚拟桌面（所有显示器一张图），返回 (原点x, 原点y, 宽, 高, RGBA 像素)。
    /// GDI 直接拿设备像素，多屏/混合 DPI 由系统合成，比逐屏拼接更稳。
    /// 仅作 DXGI 的回退：远程桌面 / 安全桌面 / 独占全屏无法 Duplicate 时用它兜底。
    fn capture_virtual_screen_gdi() -> Option<(i32, i32, i32, i32, Vec<u8>)> {
        unsafe {
            let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if vw <= 0 || vh <= 0 {
                return None;
            }
            let screen = GetDC(0);
            if screen == 0 {
                return None;
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, vw, vh);
            let old = SelectObject(mem, bmp);
            let blit = BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, SRCCOPY | CAPTUREBLT);

            let mut buf = vec![0u8; (vw as usize) * (vh as usize) * 4];
            let mut bi = BitmapInfoHeader {
                size: core::mem::size_of::<BitmapInfoHeader>() as u32,
                width: vw,
                height: -vh, // 负 = 自上而下，行序正常
                planes: 1,
                bit_count: 32,
                compression: 0, // BI_RGB
                size_image: 0,
                x_ppm: 0,
                y_ppm: 0,
                clr_used: 0,
                clr_important: 0,
            };
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                vh as u32,
                buf.as_mut_ptr() as *mut _,
                &mut bi as *mut _ as *mut _,
                0, // DIB_RGB_COLORS
            );

            SelectObject(mem, old);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(0, screen);

            if blit == 0 || lines == 0 {
                return None;
            }
            // BGRX -> RGBA
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            Some((vx, vy, vw, vh, buf))
        }
    }

    /// 采样判断这张图是不是几乎全黑（GDI 抓不到硬件覆盖层时就是这样）
    fn is_mostly_black(buf: &[u8]) -> bool {
        let mut lit = 0usize;
        let mut seen = 0usize;
        // 每 64 个像素采一个就够判断了，全图逐像素扫 4K 图是白花时间
        for px in buf.chunks_exact(4).step_by(64) {
            seen += 1;
            if px[0] > 8 || px[1] > 8 || px[2] > 8 {
                lit += 1;
            }
        }
        seen > 0 && lit * 200 < seen // 亮点不到 0.5%
    }

    /// 截取整个虚拟桌面，返回 (原点x, 原点y, 宽, 高, RGBA)。
    ///
    /// GDI 优先：BitBlt 不惊动合成器，按下 F3 屏幕不会闪一下，也没有 DXGI 等一帧
    /// 「确有桌面刷新」的那最多 500ms —— 静止桌面下那 500ms 是每次都要付的。
    /// 只有 GDI 截出来几乎全黑（独占全屏游戏、视频硬件覆盖层、受保护内容）才退到
    /// DXGI Desktop Duplication，它能抓到这些内容但代价是上面那两条。
    pub fn capture_virtual_screen() -> Option<(i32, i32, i32, i32, Vec<u8>)> {
        match capture_virtual_screen_gdi() {
            Some(v) if !is_mostly_black(&v.4) => Some(v),
            Some(v) => capture_virtual_screen_dxgi().or(Some(v)),
            None => capture_virtual_screen_dxgi(),
        }
    }

    struct DxgiGrab {
        left: i32,
        top: i32,
        w: i32,
        h: i32,
        bgra: Vec<u8>, // 紧凑 BGRA，行宽 = w*4
    }

    /// DXGI Desktop Duplication 抓全部已连接输出并合成为整块虚拟桌面。
    /// “全有或全无”：任一 attached 输出旋转 / 非 BGRA8 / 抓取失败即整体放弃回退 GDI，
    /// 保证要么完整、要么干净回退，绝不残缺拼接。
    fn capture_virtual_screen_dxgi() -> Option<(i32, i32, i32, i32, Vec<u8>)> {
        use windows::core::Interface;
        use windows::Win32::Foundation::HMODULE;
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
        use windows::Win32::Graphics::Direct3D11::*;
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
        };
        use windows::Win32::Graphics::Dxgi::*;

        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut grabs: Vec<DxgiGrab> = Vec::new();

            let mut ai = 0u32;
            loop {
                let adapter = match factory.EnumAdapters1(ai) {
                    Ok(a) => a,
                    Err(_) => break, // 适配器枚举结束
                };
                ai += 1;

                // 为该适配器建 D3D11 设备（DuplicateOutput 要求设备与输出同适配器）
                let mut device: Option<ID3D11Device> = None;
                let mut context: Option<ID3D11DeviceContext> = None;
                let dev_hr = D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_FLAG(0),
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                );

                let mut oi = 0u32;
                loop {
                    let output = match adapter.EnumOutputs(oi) {
                        Ok(o) => o,
                        Err(_) => break, // 该适配器输出枚举结束
                    };
                    oi += 1;
                    let desc = match output.GetDesc() {
                        Ok(d) => d,
                        Err(_) => return None,
                    };
                    if !desc.AttachedToDesktop.as_bool() {
                        continue; // 未连桌面的输出忽略
                    }
                    // 这块屏连着桌面 —— 必须成功抓取，否则整体回退保证完整
                    if dev_hr.is_err() {
                        return None;
                    }
                    if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY
                        && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED
                    {
                        return None; // 旋转屏交给 GDI
                    }
                    let device_ref = device.as_ref()?;
                    let context_ref = context.as_ref()?;
                    let output1: IDXGIOutput1 = output.cast().ok()?;
                    let dupl = match output1.DuplicateOutput(device_ref) {
                        Ok(d) => d,
                        Err(_) => return None, // 被独占/无权限 → 回退
                    };
                    let grab = grab_output(device_ref, context_ref, &dupl, &desc);
                    let _ = dupl.ReleaseFrame();
                    match grab {
                        Some(g) => grabs.push(g),
                        None => return None,
                    }
                }
            }

            if grabs.is_empty() {
                return None;
            }
            let left = grabs.iter().map(|g| g.left).min()?;
            let top = grabs.iter().map(|g| g.top).min()?;
            let right = grabs.iter().map(|g| g.left + g.w).max()?;
            let bottom = grabs.iter().map(|g| g.top + g.h).max()?;
            let vw = right - left;
            let vh = bottom - top;
            if vw <= 0 || vh <= 0 {
                return None;
            }

            let mut buf = vec![0u8; (vw as usize) * (vh as usize) * 4];
            for px in buf.chunks_exact_mut(4) {
                px[3] = 255; // 非矩形虚拟桌面的空隙填黑不透明
            }
            for g in &grabs {
                let ox = (g.left - left) as usize;
                let oy = (g.top - top) as usize;
                let gw = g.w as usize;
                for row in 0..g.h as usize {
                    let src = &g.bgra[row * gw * 4..row * gw * 4 + gw * 4];
                    let dst_off = ((oy + row) * vw as usize + ox) * 4;
                    let dst = &mut buf[dst_off..dst_off + gw * 4];
                    for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
                        d[0] = s[2]; // 源 BGRA → 目标 RGBA
                        d[1] = s[1];
                        d[2] = s[0];
                        d[3] = 255;
                    }
                }
            }
            // 安全网：合成结果整幅纯黑（DXGI 异常/表面无效）时放弃，改用 GDI，杜绝黑屏回归。
            // 正常画面 top-left 一般即有内容，any() 会立即短路返回。
            let has_content = buf
                .chunks_exact(4)
                .any(|px| px[0] != 0 || px[1] != 0 || px[2] != 0);
            if !has_content {
                return None;
            }
            Some((left, top, vw, vh, buf))
        }
    }

    /// 抓单个输出当前帧 → 拷到 CPU 可读 staging 纹理 → 读出紧凑 BGRA。
    unsafe fn grab_output(
        device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
        context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        dupl: &windows::Win32::Graphics::Dxgi::IDXGIOutputDuplication,
        out_desc: &windows::Win32::Graphics::Dxgi::DXGI_OUTPUT_DESC,
    ) -> Option<DxgiGrab> {
        use windows::core::Interface;
        use windows::Win32::Graphics::Direct3D11::*;
        use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
        use windows::Win32::Graphics::Dxgi::{
            IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
        };

        // 只接受“确有桌面刷新”的帧：首帧 / 仅指针更新的帧（LastPresentTime==0）表面可能空白，
        // 直接用会截到黑屏（DXGI Desktop Duplication 经典坑），必须释放后重试。
        // 活动内容（视频/游戏）每帧都 present，几乎即时命中；静止桌面等到 deadline 便回退 GDI。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let mut resource: Option<IDXGIResource> = None;
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut ok = false;
        loop {
            match dupl.AcquireNextFrame(120, &mut info, &mut resource) {
                Ok(_) => {
                    if info.LastPresentTime != 0 {
                        ok = true;
                        break;
                    }
                    // 仅元数据/指针帧，表面无效：释放后重试
                    let _ = dupl.ReleaseFrame();
                    resource = None;
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {}
                Err(_) => return None,
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
        }
        if !ok {
            return None;
        }
        let resource = resource?;
        let tex: ID3D11Texture2D = resource.cast().ok()?;
        let mut td = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut td);
        if td.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return None; // 非 BGRA8（如 HDR fp16）交给 GDI
        }

        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: td.Width,
            Height: td.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: td.Format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .ok()?;
        let staging = staging?;
        context.CopyResource(&staging, &tex);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .ok()?;

        let w = td.Width as usize;
        let h = td.Height as usize;
        let pitch = mapped.RowPitch as usize;
        let mut bgra = vec![0u8; w * h * 4];
        let src = mapped.pData as *const u8;
        for y in 0..h {
            std::ptr::copy_nonoverlapping(
                src.add(y * pitch),
                bgra.as_mut_ptr().add(y * w * 4),
                w * 4,
            );
        }
        context.Unmap(&staging, 0);

        Some(DxgiGrab {
            left: out_desc.DesktopCoordinates.left,
            top: out_desc.DesktopCoordinates.top,
            w: w as i32,
            h: h as i32,
            bgra,
        })
    }
}

/// Windows 原生 OCR（Windows.Media.Ocr），无需 Python / RapidOCR
#[cfg(windows)]
mod ocr {
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    /// 保证当前线程处于多线程套间（WinRT 激活 + IAsyncOperation::get 阻塞都需要）
    fn init_mta() {
        // 已初始化会返回 S_FALSE / RPC_E_CHANGED_MODE，忽略即可；不主动 uninit
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
    }

    /// 把应用的源语言代码映射成优先尝试的 OCR BCP-47 语言标签。
    /// 注意 en 也优先中文引擎：中文引擎能同时识别中英混排，而英文引擎看到中文
    /// 会输出乱码（实测灾难级）；源语言设 en 的中文用户截中文图是常态，不能炸。
    fn lang_prefs(source_lang: &str) -> Vec<&'static str> {
        match source_lang.trim() {
            "" | "auto" => vec!["zh-Hans", "en"],
            "zh" => vec!["zh-Hans", "en"],
            "zh-Hant" => vec!["zh-Hant", "zh-Hans"],
            "en" => vec!["zh-Hans", "en"],
            "ja" => vec!["ja"],
            "ko" => vec!["ko"],
            "fr" => vec!["fr"],
            "de" => vec!["de"],
            "es" => vec!["es"],
            "it" => vec!["it"],
            "pt" => vec!["pt"],
            "ru" => vec!["ru"],
            "ar" => vec!["ar"],
            "hi" => vec!["hi"],
            "vi" => vec!["vi"],
            "th" => vec!["th"],
            "tr" => vec!["tr"],
            "nl" => vec!["nl"],
            "pl" => vec!["pl"],
            "el" => vec!["el"],
            "sv" => vec!["sv"],
            _ => vec!["en"],
        }
    }

    /// 在系统已安装的 OCR 语言里挑一个最匹配源语言的
    fn pick_language(prefs: &[&str]) -> Result<Language, String> {
        let avail = OcrEngine::AvailableRecognizerLanguages().map_err(|e| e.to_string())?;
        let list: Vec<Language> = avail.into_iter().collect();
        if list.is_empty() {
            return Err(
                "系统未安装 OCR 语言包。请到 设置→时间和语言→语言和区域→对应语言→语言选项，安装“光学字符识别 (OCR)”功能"
                    .into(),
            );
        }
        let tags: Vec<String> = list
            .iter()
            .map(|l| l.LanguageTag().map(|s| s.to_string()).unwrap_or_default().to_lowercase())
            .collect();
        for p in prefs {
            let pl = p.to_lowercase();
            for (i, t) in tags.iter().enumerate() {
                if t == &pl || t.starts_with(&pl) || pl.starts_with(t.as_str()) {
                    return Ok(list[i].clone());
                }
            }
        }
        Ok(list[0].clone())
    }

    /// 估计整图背景是否偏暗（深色模式的浅字深底）。文字通常稀疏，故整图均值≈背景亮度。
    /// 抽样计算以省时。均值低于阈值即判为暗底。
    fn dark_background(img: &image::RgbaImage) -> bool {
        let (w, h) = img.dimensions();
        if w == 0 || h == 0 {
            return false;
        }
        let step = (w.max(h) / 240).max(1);
        let (mut sum, mut n) = (0u64, 0u64);
        let mut y = 0;
        while y < h {
            let mut x = 0;
            while x < w {
                let p = img.get_pixel(x, y);
                sum += (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) as u64;
                n += 1;
                x += step;
            }
            y += step;
        }
        n > 0 && sum / n < 120
    }

    /// 对比度拉伸：灰字灰底 / 半透明覆盖层这类低对比截图是漏字重灾区。
    /// 取亮度 2%~98% 分位做线性拉伸；范围已足够宽（正常黑白文本）或文字
    /// 占比过低（分位全落在背景上）时自动跳过，不影响正常截图。
    fn stretch_contrast(img: &mut image::RgbaImage) {
        let mut hist = [0u32; 256];
        for p in img.pixels() {
            let y = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) as usize;
            hist[y.min(255)] += 1;
        }
        let total: u32 = hist.iter().sum();
        if total == 0 {
            return;
        }
        let target = (total / 50).max(1); // 2%
        let (mut lo, mut hi) = (0usize, 255usize);
        let mut acc = 0u32;
        for (i, n) in hist.iter().enumerate() {
            acc += n;
            if acc >= target {
                lo = i;
                break;
            }
        }
        acc = 0;
        for (i, n) in hist.iter().enumerate().rev() {
            acc += n;
            if acc >= target {
                hi = i;
                break;
            }
        }
        if hi <= lo + 8 || hi - lo > 200 {
            return; // 退化（近纯色）或对比度本来就够
        }
        let scale = 255.0 / (hi - lo) as f32;
        let lut: Vec<u8> = (0..256)
            .map(|v| ((v as f32 - lo as f32) * scale).clamp(0.0, 255.0) as u8)
            .collect();
        for p in img.pixels_mut() {
            p[0] = lut[p[0] as usize];
            p[1] = lut[p[1] as usize];
            p[2] = lut[p[2] as usize];
        }
    }

    /// 是否 CJK 及全角标点/假名/谚文（这些字之间不该有空格）
    fn is_cjkish(c: char) -> bool {
        let u = c as u32;
        (0x3400..=0x9FFF).contains(&u)      // CJK 扩展A + 基本汉字
            || (0xF900..=0xFAFF).contains(&u) // 兼容汉字
            || (0x3040..=0x30FF).contains(&u) // 平/片假名
            || (0xAC00..=0xD7A3).contains(&u) // 谚文音节
            || (0x3000..=0x303F).contains(&u) // CJK 标点
            || (0xFF00..=0xFFEF).contains(&u) // 全角/半角形式
    }

    /// Windows OCR 会在 CJK“词”间插空格（"所 以 别"）。合并两侧都是 CJK 的空格，
    /// 保留拉丁文单词间空格（如 "API"、"BYOK key"）。
    fn collapse_cjk_spaces(s: &str) -> String {
        let chars: Vec<char> = s.chars().collect();
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == ' ' {
                let mut j = i + 1;
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                let prev = out.chars().last();
                let next = chars.get(j).copied();
                let between_cjk =
                    matches!((prev, next), (Some(p), Some(n)) if is_cjkish(p) && is_cjkish(n));
                // 两侧皆 CJK → 去空格；行首/行尾 → 去；否则保留单个空格
                if !between_cjk && prev.is_some() && next.is_some() {
                    out.push(' ');
                }
                i = j;
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    /// 预处理开关（供 A/B 测试与调优；生产走 Default）
    #[derive(Clone, Copy)]
    pub struct PreprocOpts {
        pub stretch: bool,     // 低对比截图做对比度拉伸
        pub short_scale: bool, // 放大倍率额外考虑短边（宽而矮的整行截图）
        pub invert_dark: bool, // 深色底反相为浅底深字
        pub sharpen: bool,     // 放大后 unsharpen 锐化
        pub gray: bool,        // 灰度化（去 ClearType 彩色亚像素边缘）
        pub catmull: bool,     // 用 CatmullRom 插值（否则 Lanczos3，振铃更强）
        pub max_factor: f32,   // 放大倍率上限
    }

    impl Default for PreprocOpts {
        fn default() -> Self {
            Self {
                // A/B 实测（19 张 GDI 渲染样张）：拉伸会破坏抗锯齿渐变，低对比场景反而更差
                stretch: false,
                short_scale: true,
                invert_dark: true,
                sharpen: true,
                gray: false,
                catmull: false,
                // A/B 实测：小字放大超过 ~2x 会被插值撕碎成偏旁（“三步曲”→“卉曲”），
                // 2x 恰好把常见 14px 字推进 Windows OCR 的甜点区（~28px）
                max_factor: 2.0,
            }
        }
    }

    /// 识别一张 RGBA8 图（每像素 R,G,B,A），返回逐行文本 + 行框（原图像素坐标）
    pub fn recognize_rgba(
        width: u32,
        height: u32,
        rgba: &[u8],
        source_lang: &str,
    ) -> Result<Vec<crate::OcrLine>, String> {
        recognize_with(width, height, rgba, source_lang, PreprocOpts::default())
    }

    pub fn recognize_with(
        width: u32,
        height: u32,
        rgba: &[u8],
        source_lang: &str,
        opts: PreprocOpts,
    ) -> Result<Vec<crate::OcrLine>, String> {
        if width == 0 || height == 0 || rgba.len() < (width as usize) * (height as usize) * 4 {
            return Err("截图数据无效".into());
        }
        init_mta();

        let mut base = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("截图数据无效")?;
        // 灰度化：中和 ClearType 彩色亚像素边缘（后续反相/放大都在灰度上进行更稳）
        if opts.gray {
            for px in base.pixels_mut() {
                let y = (0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32) as u8;
                px[0] = y;
                px[1] = y;
                px[2] = y;
            }
        }
        // 深色模式（浅字深底）是 Windows OCR 命中率杀手：暗底整体反相为“深字浅底”再识别
        if opts.invert_dark && dark_background(&base) {
            for px in base.pixels_mut() {
                px[0] = 255 - px[0];
                px[1] = 255 - px[1];
                px[2] = 255 - px[2];
            }
        }
        // 低对比截图先拉伸对比度，再考虑放大
        if opts.stretch {
            stretch_contrast(&mut base);
        }

        // 小图 / 小字放大后 Windows OCR 明显更准。除长边外还看短边：
        // 宽而矮的整行截图（如 2200×60）文字同样小，此前不放大是漏字来源之一
        let long = width.max(height) as f32;
        let short = width.min(height) as f32;
        let f_long = if long < 2000.0 { 2000.0 / long } else { 1.0 };
        let f_short = if opts.short_scale && short < 200.0 { 200.0 / short } else { 1.0 };
        let mut factor = f_long.max(f_short).min(opts.max_factor);
        if long * factor > 9000.0 {
            factor = 9000.0 / long; // Windows OCR 位图上限 10000px，留白前先封顶
        }
        if factor <= 1.01 {
            factor = 1.0; // 不放大时归一，行框反算才是精确的
        }
        let up = if factor > 1.01 {
            let nw = (((width as f32) * factor).round() as u32).max(1);
            let nh = (((height as f32) * factor).round() as u32).max(1);
            let filter = if opts.catmull {
                image::imageops::FilterType::CatmullRom
            } else {
                image::imageops::FilterType::Lanczos3
            };
            let scaled = image::imageops::resize(&base, nw, nh, filter);
            if opts.sharpen {
                // 放大后轻度锐化，让文字边缘更清晰，识别更稳
                image::imageops::unsharpen(&scaled, 1.2, 2)
            } else {
                scaled
            }
        } else {
            base
        };

        // 给文字四周留白（采样四角色作背景）：Windows OCR 对贴边/孤立的短文本
        // 常识别不到或漏掉开头字，加一圈 margin 能显著改善“单字/前两字丢失”
        let (uw, uh) = up.dimensions();
        let pad = ((uw.max(uh) as f32) * 0.12).round().max(36.0) as u32;
        let bgpx = {
            let c = [
                up.get_pixel(0, 0),
                up.get_pixel(uw - 1, 0),
                up.get_pixel(0, uh - 1),
                up.get_pixel(uw - 1, uh - 1),
            ];
            let mut a = [0u32; 3];
            for p in c {
                a[0] += p[0] as u32;
                a[1] += p[1] as u32;
                a[2] += p[2] as u32;
            }
            image::Rgba([(a[0] / 4) as u8, (a[1] / 4) as u8, (a[2] / 4) as u8, 255])
        };
        let mut img = image::RgbaImage::from_pixel(uw + pad * 2, uh + pad * 2, bgpx);
        image::imageops::overlay(&mut img, &up, pad as i64, pad as i64);
        let (w, h) = img.dimensions();

        // RGBA→BGRA，并把 alpha 强制为不透明：剪贴板 DIB 常无有效 alpha，
        // premultiplied 下透明像素会被当成黑色，导致 OCR 直接识别失败
        let mut bgra = img.into_raw();
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(|e| e.to_string())?;
        let bitmap =
            SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)
                .map_err(|e| e.to_string())?;

        let lang = pick_language(&lang_prefs(source_lang))?;
        let engine = OcrEngine::TryCreateFromLanguage(&lang).map_err(|e| e.to_string())?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        let lines = result.Lines().map_err(|e| e.to_string())?;
        let mut out: Vec<crate::OcrLine> = Vec::new();
        for line in lines {
            let raw = line.Text().map(|s| s.to_string()).unwrap_or_default();
            let t = collapse_cjk_spaces(&raw);
            let t = t.trim().to_string();
            if t.is_empty() {
                continue;
            }
            // 行框 = 该行所有词框的并集，再按预处理的放大倍率/留白反算回原图坐标，
            // 让「原位覆盖」能把译文贴回文字原来的位置
            let (mut l, mut t_, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            if let Ok(words) = line.Words() {
                for word in words {
                    if let Ok(rect) = word.BoundingRect() {
                        l = l.min(rect.X);
                        t_ = t_.min(rect.Y);
                        r = r.max(rect.X + rect.Width);
                        b = b.max(rect.Y + rect.Height);
                    }
                }
            }
            let bbox = if l <= r && t_ <= b {
                let p = pad as f32;
                let unmap = |v: f32| (v - p) / factor;
                Some((unmap(l), unmap(t_), (r - l) / factor, (b - t_) / factor))
            } else {
                None
            };
            let (x, y, w, h) = bbox.unwrap_or((0.0, 0.0, 0.0, 0.0));
            out.push(crate::OcrLine { text: t, x, y, w, h });
        }
        Ok(out)
    }
}

/// OCR 预处理 A/B 对比：FT_OCR_TEST_DIR 指向 PNG 目录时逐图跑 4 种预处理组合。
/// 运行：FT_OCR_TEST_DIR=... cargo test ocr_ab -- --nocapture
#[cfg(all(test, windows))]
mod ocr_ab_tests {
    use super::ocr;

    #[test]
    fn ocr_ab_matrix() {
        let dir = match std::env::var("FT_OCR_TEST_DIR") {
            Ok(d) => d,
            Err(_) => return, // 未设置则静默跳过（普通 cargo test 不受影响）
        };
        let mut paths: Vec<_> = std::fs::read_dir(&dir)
            .expect("read test dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false))
            .collect();
        paths.sort();
        let lang = std::env::var("FT_OCR_LANG").unwrap_or_else(|_| "auto".into());
        let old = ocr::PreprocOpts {
            stretch: false,
            short_scale: false,
            max_factor: 6.0,
            ..Default::default()
        };
        let variants: [(&str, ocr::PreprocOpts); 3] = [
            ("pre-today(max6)   ", old),
            ("morning(str+short)", ocr::PreprocOpts { stretch: true, short_scale: true, max_factor: 6.0, ..old }),
            ("current(max2)     ", ocr::PreprocOpts::default()),
        ];
        for p in paths {
            let img = image::open(&p).expect("open png").to_rgba8();
            let (w, h) = img.dimensions();
            let raw = img.into_raw();
            println!("── {} ({w}x{h}) lang={lang}", p.file_name().unwrap().to_string_lossy());
            for (label, opts) in variants {
                let out = ocr::recognize_with(w, h, &raw, &lang, opts)
                    .map(|lines| lines.into_iter().map(|l| l.text).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_else(|e| format!("<err: {e}>"));
                println!("  [{label}] {}", out.replace('\n', " ⏎ "));
            }
        }
    }

    /// GGUF 纠错冒烟测试：FT_QWEN_MODEL 指向 .gguf 时运行，验证纠错可用并计时
    #[test]
    fn qwen_correct_smoke() {
        let model = match std::env::var("FT_QWEN_MODEL") {
            Ok(m) => m,
            Err(_) => return,
        };
        let garbled = "可以的话在一台氵殳有 Python 环境的电脑（或斤建 Windows 用户）再验一逞 CT2，那是最严恪的开箱即用验证";
        let t0 = std::time::Instant::now();
        let out = crate::gguf::correct_ocr(&model, garbled).expect("correct_ocr failed");
        println!("correct_ocr took {:?}\n  in : {garbled}\n  out: {out}", t0.elapsed());
        assert!(!out.trim().is_empty());
    }
}

struct BridgeSession {
    key: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Drop for BridgeSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct AppState {
    target_hwnd: Mutex<isize>,
    bridge: Mutex<Option<BridgeSession>>,
    snip_full: Mutex<Option<String>>, // F3 全屏截图 data URL，供 snip overlay 拉取
    snip_origin: Mutex<(i32, i32)>,   // 该截图对应的虚拟桌面原点，用于把框选换算回屏幕坐标
    snip_round: Mutex<u64>,           // F3 轮次，作废上一轮延迟触发的兜底显示
    pin_img: Mutex<Option<String>>,   // 贴图窗口要显示的图片 data URL
    overlay: Mutex<Option<Value>>,    // 原位覆盖窗口要显示的数据（截图 + 分块）
    overlay_round: Mutex<u64>,        // 覆盖窗口轮次，作废上一轮延迟触发的兜底显示
}

fn settings_file(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn default_settings() -> Value {
    json!({
        "theme": "dark",
        "popupStaySecs": 8,
        "closeOnBlur": false,
        "uiScale": 1.0,
        "sourceLang": "auto",
        "targetLang": "zh",
        // 双向自动切换：识别到的语言正好是目标语言时，改译回源语言（中↔英一键往返）
        "autoSwap": false,
        // 截图翻译把译文原位覆盖在框选区域上（另开置顶窗口），弹窗仍照常出现
        "snipOverlay": false,
        // 覆盖层排版：auto = 文字密集的整段文档整块重排、零散文字才逐段贴回原处
        "snipOverlayLayout": "auto",
        "local": {
            "mode": "nllb",
            "modelsDir": "",
            "selectedModel": "",
            // F4 对话 / OCR 纠错专用的 GGUF；留空则沿用翻译模型（仅 GGUF 时可用）
            "assistantModel": "",
            "ocrEnabled": true,
            "extraModels": [],
            "hiddenModels": [],
            "modelMeta": {}
        },
        // 自定义 OCR：RapidOCR 格式的 ONNX 识别模型（PP-OCR det/rec），用于系统缺语言包的语种
        "ocr": {
            "selected": "",
            "profiles": []
        },
        "hotkeys": {
            "f1": "F1",
            "f2": "F2",
            "f3": "F3",
            "f4": "F4",
            "f5": "F5"
        },
        "api": {
            "selected": "default",
            "profiles": [
                { "name": "default", "baseUrl": "", "apiKey": "", "model": "" }
            ]
        },
        "prompts": {
            "selected": "",
            "presets": []
        }
    })
}

fn merge_value(base: &mut Value, saved: &Value) {
    match (base, saved) {
        (Value::Object(base_map), Value::Object(saved_map)) => {
            for (k, v) in saved_map {
                if let Some(existing) = base_map.get_mut(k) {
                    merge_value(existing, v);
                } else {
                    base_map.insert(k.clone(), v.clone());
                }
            }
        }
        (base_slot, saved_value) => *base_slot = saved_value.clone(),
    }
}

fn read_settings_value(app: &AppHandle) -> Value {
    let mut merged = default_settings();
    if let Ok(raw) = std::fs::read_to_string(settings_file(app)) {
        // 记事本 / PowerShell 存出来的 UTF-8 会带 BOM，serde 会直接解析失败，
        // 结果是"所有设置无声地退回默认值"——先剥掉再解析
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        if let Ok(saved) = serde_json::from_str::<Value>(raw) {
            merge_value(&mut merged, &saved);
        }
    }
    merged
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Value {
    read_settings_value(&app)
}

#[tauri::command]
fn settings_set(app: AppHandle, value: Value) -> Result<(), String> {
    let path = settings_file(&app);
    let raw = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", value);
    apply_hotkeys(&app);
    Ok(())
}

fn grab_selection_blocking() -> String {
    let before = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
        .unwrap_or_default();

    if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
        let _ = enigo.key(Key::Control, Direction::Press);
        std::thread::sleep(Duration::from_millis(15));
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        std::thread::sleep(Duration::from_millis(15));
        let _ = enigo.key(Key::Control, Direction::Release);
    }

    let t0 = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(30));
        let now = arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get_text().ok())
            .unwrap_or_default();
        if !now.trim().is_empty() && now != before {
            return now;
        }
        if t0.elapsed() > Duration::from_millis(900) {
            return if !now.trim().is_empty() { now } else { before };
        }
    }
}

#[tauri::command]
async fn commit_paste(app: AppHandle, state: tauri::State<'_, AppState>, text: String) -> Result<(), String> {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.hide();
    }
    let hwnd = *state.target_hwnd.lock().unwrap();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.set_text(text);
        }
        std::thread::sleep(Duration::from_millis(120));
        #[cfg(windows)]
        win32::refocus(hwnd);
        std::thread::sleep(Duration::from_millis(60));
        if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
            let _ = enigo.key(Key::Control, Direction::Press);
            std::thread::sleep(Duration::from_millis(15));
            let _ = enigo.key(Key::Unicode('v'), Direction::Click);
            std::thread::sleep(Duration::from_millis(15));
            let _ = enigo.key(Key::Control, Direction::Release);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    c.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_text() -> String {
    arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
        .unwrap_or_default()
}

#[tauri::command]
fn popup_present(app: AppHandle, width: f64, height: f64, focus: bool) -> Result<(), String> {
    let popup = app.get_webview_window("popup").ok_or("popup window missing")?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let (scale, mx, my, mw, mh) = match &monitor {
        Some(m) => (
            m.scale_factor(),
            m.position().x as f64,
            m.position().y as f64,
            m.size().width as f64,
            m.size().height as f64,
        ),
        None => (1.0, 0.0, 0.0, 1920.0, 1080.0),
    };

    let wp = width * scale;
    let hp = height * scale;
    let pad = 10.0 * scale;
    let mut x = cursor.x + 12.0 * scale;
    let mut y = cursor.y + 22.0 * scale;
    if x + wp > mx + mw - pad {
        x = mx + mw - wp - pad;
    }
    if y + hp > my + mh - pad {
        y = cursor.y - hp - 16.0 * scale;
    }
    if x < mx + pad {
        x = mx + pad;
    }
    if y < my + pad {
        y = my + pad;
    }

    let _ = popup.set_size(LogicalSize::new(width, height));
    let _ = popup.set_position(PhysicalPosition::new(x, y));
    let _ = popup.set_focusable(focus);
    let _ = popup.show();
    let _ = popup.set_always_on_top(true);
    if focus {
        let _ = popup.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn popup_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(popup) = app.get_webview_window("popup") {
        // 尺寸没变就别动窗口：弹窗是置顶 + 透明 + 亚克力的，每次 SetWindowPos
        // 都会让 DWM 重做毛玻璃合成，流式输出时高频调用会拖慢整个桌面的指针合成
        let scale = popup.scale_factor().unwrap_or(1.0);
        if let Ok(cur) = popup.outer_size() {
            let same_w = (cur.width as f64 - width * scale).abs() < 1.5;
            let same_h = (cur.height as f64 - height * scale).abs() < 1.5;
            if same_w && same_h {
                return Ok(());
            }
        }
        let _ = popup.set_size(LogicalSize::new(width, height));
        // 变高后重新夹住位置，避免长译文把底部按钮顶出屏幕（够不到“复制”）
        if let Ok(pos) = popup.outer_position() {
            let monitor = popup
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| app.primary_monitor().ok().flatten());
            if let Some(m) = monitor {
                let mpos = m.position();
                let msize = m.size();
                let wp = width * scale;
                let hp = height * scale;
                let pad = 8.0 * scale;
                let left = mpos.x as f64 + pad;
                let top = mpos.y as f64 + pad;
                let right = mpos.x as f64 + msize.width as f64 - pad;
                let bottom = mpos.y as f64 + msize.height as f64 - pad;
                let mut x = pos.x as f64;
                let mut y = pos.y as f64;
                if x + wp > right {
                    x = right - wp;
                }
                if y + hp > bottom {
                    y = bottom - hp;
                }
                if x < left {
                    x = left;
                }
                if y < top {
                    y = top;
                }
                // 位置没被夹动就别再挪一次窗口（同上：能省一次 SetWindowPos 就省）
                if (x - pos.x as f64).abs() >= 1.0 || (y - pos.y as f64).abs() >= 1.0 {
                    let _ = popup.set_position(PhysicalPosition::new(x, y));
                }
            }
        }
    }
    Ok(())
}

/// 让 popup 可获焦并聚焦（“点击外部关闭”需要：只有获焦窗口才能感知失焦）
#[tauri::command]
fn popup_grab_focus(app: AppHandle) {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.set_focusable(true);
        let _ = popup.set_focus();
    }
}

#[derive(Deserialize)]
struct LlmRequest {
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<Value>,
    temperature: Option<f64>,
}

/// 进程级共享的 HTTP client：TLS/连接池只建一次，跨请求复用 keep-alive 连接。
/// 之前每个请求 `Client::new()` 一次，首次请求永远要付一次冷 DNS+TCP+TLS 的代价。
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .user_agent("FlashTrans")
            .build()
            .expect("build reqwest client")
    })
}

/// 启动预热：对当前在用的在线 API 打一个最省的请求，把 TCP/TLS 连接和远端模型
/// 的推理槽热起来，让用户第一次按 F1/F2 划词翻译时不用等冷连接 + 冷 prefill。
/// 失败静默忽略——预热只是优化，不能因为网络差就让启动报错或卡住。
fn warmup_online_api(app: &AppHandle) {
    let s = read_settings_value(app);
    let empty = json!({});
    let local = s.get("local").unwrap_or(&empty);
    if local.get("mode").and_then(Value::as_str).unwrap_or("") == "api" {
        let api = s.get("api").unwrap_or(&empty);
        let profiles = api.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default();
        let sel = api.get("selected").and_then(Value::as_str).unwrap_or("");
        let p = profiles
            .iter()
            .find(|x| x.get("name").and_then(Value::as_str) == Some(sel))
            .or_else(|| profiles.first())
            .cloned()
            .unwrap_or_default();
        let base = p.get("baseUrl").and_then(Value::as_str).unwrap_or("").trim().trim_end_matches('/').to_string();
        let model = p.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let key = p.get("apiKey").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !base.is_empty() && !model.is_empty() && !key.is_empty() {
            let client = http_client();
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let url = if base.ends_with("/chat/completions") {
                    base.clone()
                } else {
                    format!("{base}/chat/completions")
                };
                let body = json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "ping" }],
                    "stream": false,
                    "max_tokens": 1,
                });
                let resp = client
                    .post(&url)
                    .bearer_auth(&key)
                    .json(&body)
                    .timeout(Duration::from_secs(20))
                    .send()
                    .await;
                match resp {
                    Ok(r) if r.status().is_success() => {
                        eprintln!("warmup api ok: {base} {model}");
                        let _ = app2.emit_to("popup", "llm:prewarmed", json!({}));
                    }
                    Ok(r) => eprintln!("warmup api http {}: {base} {model}", r.status().as_u16()),
                    Err(e) => eprintln!("warmup api err: {base} {model} — {e}"),
                }
            });
        }
    }
}

#[tauri::command]
async fn llm_stream(window: tauri::WebviewWindow, req_id: u64, req: LlmRequest) -> Result<(), String> {
    let base = req.base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        let _ = window.emit("llm:error", json!({ "id": req_id, "message": "未配置 API，请在设置中填写 Base URL / Key / Model" }));
        return Ok(());
    }
    // 容错：用户把完整 endpoint 填进 Base URL 时不再重复拼接
    let url = if base.ends_with("/chat/completions") {
        base.clone()
    } else {
        format!("{}/chat/completions", base)
    };
    let body = json!({
        "model": req.model,
        "messages": req.messages,
        "stream": true,
        "temperature": req.temperature.unwrap_or(0.2),
        // 在线 API 统一关闭思考/reasoning：DeepSeek 等兼容接口用该参数，
        // 若后端不支持会忽略，不影响请求。避免先出思考内容拖慢翻译/对话。
        "enable_thinking": false,
    });

    let client = http_client();
    let resp = client
        .post(&url)
        .bearer_auth(req.api_key.trim())
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = window.emit("llm:error", json!({ "id": req_id, "message": format!("请求失败：{e}") }));
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let brief: String = text.chars().take(300).collect();
        let _ = window.emit("llm:error", json!({ "id": req_id, "message": format!("API 错误 {code}：{brief}") }));
        return Ok(());
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = window.emit("llm:error", json!({ "id": req_id, "message": format!("流中断：{e}") }));
                return Ok(());
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let payload = line[5..].trim();
            if payload == "[DONE]" {
                let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<Value>(payload) {
                let delta = &v["choices"][0]["delta"];
                // 优先取正文 content；若本轮只有 reasoning_content（思考过程），
                // 一律丢弃，不把它当译文吐给前端，避免拖慢显示又产出垃圾。
                if let Some(text) = delta["content"].as_str() {
                    if !text.is_empty() {
                        full.push_str(text);
                        let _ = window.emit("llm:delta", json!({ "id": req_id, "text": text }));
                    }
                }
            }
        }
    }
    let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
    Ok(())
}

#[derive(Serialize)]
struct ModelInfo {
    id: String,
    kind: String,
    label: String,
    path: String,
    ready: bool,
    detail: String,
}

#[derive(Serialize)]
struct ModelStatus {
    models_root: String,
    models: Vec<ModelInfo>,
}

/// canonicalize 会产生 `\\?\` 扩展路径前缀，CTranslate2 等 C++ 库无法打开，必须剥掉
fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(x) => PathBuf::from(x),
        None => p,
    }
}

fn normalize_path(path: &Path) -> String {
    let mut s = path.to_string_lossy().to_string();
    if let Some(x) = s.strip_prefix(r"\\?\") {
        s = x.to_string();
    }
    s.replace('\\', "/")
}

fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn auto_models_root() -> PathBuf {
    let cwd = current_dir();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| cwd.clone());
    let candidates = [
        exe_dir.join("models"),
        exe_dir.join("_internal").join("models"),
        cwd.join("models"),
        cwd.join("..").join("models"),
        cwd.join("..").join("..").join("models"),
    ];
    for p in candidates {
        if p.exists() {
            return strip_unc(p.canonicalize().unwrap_or(p.clone()));
        }
    }
    cwd.join("models")
}

fn resolve_models_root(input: Option<String>) -> PathBuf {
    let raw = input.unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        auto_models_root()
    } else {
        PathBuf::from(trimmed)
    }
}

/// 识别一个路径是不是可用的模型（CT2 目录或 .gguf 文件）
fn classify_model(p: &Path) -> Option<ModelInfo> {
    if p.is_dir() && p.join("model.bin").exists() {
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("NLLB").to_string();
        let lower = name.to_lowercase();
        let ready = p.join("source.spm").exists()
            || p.join("sentencepiece.model").exists()
            || p.join("sentencepiece.bpe.model").exists();
        // Opus-MT 是单方向中英模型，不能按 NLLB 的语言前缀方式调用
        let (kind, label, detail) = if lower.contains("opus-mt") {
            (
                "opus",
                if lower.contains("en-zh") { "Opus-MT 英→中（含反向配对）" } else { "Opus-MT 中→英（含反向配对）" },
                "轻量中英互译，速度最快",
            )
        } else if lower.contains("3.3b") {
            ("nllb", "NLLB-200 3.3B int8", "离线多语言翻译（200 语种，质量较高）")
        } else if lower.contains("1.3b") {
            ("nllb", "NLLB-200 1.3B int8", "离线多语言翻译（200 语种，速度较快）")
        } else {
            ("nllb", "CTranslate2 翻译模型", "离线翻译模型")
        };
        return Some(ModelInfo {
            id: normalize_path(p),
            kind: kind.into(),
            label: label.into(),
            path: normalize_path(p),
            ready,
            detail: if ready { detail.into() } else { "缺少 SentencePiece 文件".to_string() },
        });
    }
    if p.is_file()
        && p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("gguf")).unwrap_or(false)
    {
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("GGUF").to_string();
        return Some(ModelInfo {
            id: normalize_path(p),
            kind: "qwen".into(),
            label: name,
            path: normalize_path(p),
            ready: true,
            detail: "本地大语言模型，可翻译也可 F4 对话".into(),
        });
    }
    None
}

#[tauri::command]
fn models_scan(models_dir: Option<String>) -> ModelStatus {
    let root = resolve_models_root(models_dir);
    let mut models = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if let Some(info) = classify_model(&entry.path()) {
                models.push(info);
            }
        }
    }
    models.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.label.cmp(&b.label)));
    ModelStatus {
        models_root: normalize_path(&root),
        models,
    }
}

#[tauri::command]
fn model_probe(path: String) -> Option<ModelInfo> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return None;
    }
    classify_model(&strip_unc(p))
}

fn bridge_script_path() -> Result<PathBuf, String> {
    let cwd = current_dir();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| cwd.clone());
    let candidates = [
        cwd.join("backend_bridge.py"),
        cwd.join("..").join("backend_bridge.py"),
        cwd.join("..").join("..").join("flashtrans-next").join("backend_bridge.py"),
        exe_dir.join("backend_bridge.py"),
        exe_dir.join("..").join("backend_bridge.py"),
    ];
    for p in candidates {
        if p.exists() {
            return Ok(strip_unc(p.canonicalize().unwrap_or(p.clone())));
        }
    }
    Err("找不到本地翻译引擎：请重装 FlashTrans，或将 NLLB/Opus 模型换成 .gguf 模型".into())
}

/// 组装 bridge 启动命令。优先用随安装包分发的独立 flashtrans-bridge.exe
/// （PyInstaller 冻结，用户无需 Python）；开发环境回退到仓库里的 python + 脚本。
fn bridge_base_command() -> Result<Command, String> {
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let candidates = [
            exe_dir.join("bridge").join("flashtrans-bridge.exe"),
            exe_dir.join("flashtrans-bridge.exe"),
        ];
        for p in candidates {
            if p.exists() {
                return Ok(Command::new(p));
            }
        }
    }
    let script = bridge_script_path()?;
    let mut cmd = Command::new(python_exe());
    cmd.arg(script);
    Ok(cmd)
}

fn python_exe() -> String {
    if let Ok(p) = std::env::var("FLASHTRANS_PYTHON") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    let cwd = current_dir();
    let candidates = [
        cwd.join("..").join("..").join(".venv").join("Scripts").join("python.exe"),
        cwd.join("..").join(".venv").join("Scripts").join("python.exe"),
        cwd.join(".venv").join("Scripts").join("python.exe"),
    ];
    for p in candidates {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "python".into()
}

fn start_bridge(backend: &str, model: &str) -> Result<BridgeSession, String> {
    let mut cmd = bridge_base_command()?;
    cmd.arg("serve")
        .arg("--backend")
        .arg(backend)
        .arg("--model")
        .arg(model)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动本地模型桥接失败：{e}"))?;
    let stdin = child.stdin.take().ok_or("无法打开 bridge stdin")?;
    let stdout = child.stdout.take().ok_or("无法打开 bridge stdout")?;
    Ok(BridgeSession {
        key: format!("{backend}|{model}"),
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn session_io(session: &mut BridgeSession, payload: &Value) -> Result<Value, String> {
    let line = serde_json::to_string(payload).map_err(|e| e.to_string())? + "\n";
    session.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())?;

    let mut out = String::new();
    session.stdout.read_line(&mut out).map_err(|e| e.to_string())?;
    if out.trim().is_empty() {
        return Err("本地模型 bridge 没有返回结果".into());
    }
    let v: Value = serde_json::from_str(out.trim()).map_err(|e| e.to_string())?;
    if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(v)
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("本地模型执行失败").to_string())
    }
}

fn bridge_request(state: &AppState, backend: &str, model: &str, mut payload: Value) -> Result<Value, String> {
    let key = format!("{backend}|{model}");
    let mut guard = state.bridge.lock().unwrap();
    let restart = guard.as_ref().map(|s| s.key != key).unwrap_or(true);
    if restart {
        *guard = Some(start_bridge(backend, model)?);
    }
    let session = guard.as_mut().ok_or("本地模型 bridge 未启动")?;
    if !payload.is_object() {
        payload = json!({});
    }
    let res = session_io(session, &payload);
    if res.is_err() && matches!(res, Err(ref e) if e.contains("没有返回结果")) {
        *guard = None; // 进程大概率已死，下次请求重启
    }
    res
}

/// OCR 走 bridge：复用当前已有的 bridge 会话（不打断翻译模型），没有则起一个
/// 轻量会话（backend=nllb, model 空 —— OCR 与翻译模型无关）。
/// `custom` 非空时指定 RapidOCR 的自定义 ONNX 模型（det/rec/keys/cls），用于系统缺语言包的语种。
fn bridge_ocr(state: &AppState, image_b64: &str, custom: &Value) -> Result<Vec<OcrLine>, String> {
    let mut payload = json!({ "op": "ocr_image", "imageB64": image_b64 });
    if let (Some(obj), Some(src)) = (payload.as_object_mut(), custom.as_object()) {
        for (k, v) in src {
            obj.insert(k.clone(), v.clone());
        }
    }
    let mut guard = state.bridge.lock().unwrap();
    if guard.is_none() {
        *guard = Some(start_bridge("nllb", "")?);
    }
    let session = guard.as_mut().ok_or("bridge 未启动")?;
    let res = session_io(session, &payload);
    if res.is_err() && matches!(res, Err(ref e) if e.contains("没有返回结果")) {
        *guard = None;
    }
    res.map(|v| {
        v.get("lines")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|it| {
                        let text = it.get("text").and_then(Value::as_str)?.trim().to_string();
                        if text.is_empty() {
                            return None;
                        }
                        let num = |k: &str| it.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
                        Some(OcrLine { text, x: num("x"), y: num("y"), w: num("w"), h: num("h") })
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// 是否 CJK（换行合并时 CJK 相接不加空格）
fn is_cjk_char(c: char) -> bool {
    let u = c as u32;
    (0x3400..=0x9FFF).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0x3040..=0x30FF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0x3000..=0x303F).contains(&u)
        || (0xFF00..=0xFFEF).contains(&u)
}

/// OCR 单行结果：文本 + 行框（原图像素坐标，w=0 表示引擎没给出坐标）
#[derive(Serialize, Clone)]
pub struct OcrLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// 一个自然段：合并后的文本 + 该段所有行框的并集，供「原位覆盖」定位译文
#[derive(Serialize, Clone)]
struct OcrBlock {
    text: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

fn ends_sentence(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '：' | ':')
}

/// 把一行接到段落文本后面：CJK 相接不加空格，其余加空格
fn append_line(out: &mut String, line: &str) {
    if out.is_empty() {
        out.push_str(line);
        return;
    }
    let prev = out.chars().last().unwrap_or(' ');
    let next = line.chars().next().unwrap_or(' ');
    if !(is_cjk_char(prev) || is_cjk_char(next)) {
        out.push(' ');
    }
    out.push_str(line);
}

/// 两个区间的重叠长度（负重叠记 0）
fn span_overlap(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// 把一个框并进另一个框（并集）
fn union_box(x: &mut f32, y: &mut f32, w: &mut f32, h: &mut f32, o: &OcrLine) {
    let right = (*x + *w).max(o.x + o.w);
    let bottom = (*y + *h).max(o.y + o.h);
    *x = x.min(o.x);
    *y = y.min(o.y);
    *w = right - *x;
    *h = bottom - *y;
}

/// OCR 检测框 → 视觉行。RapidOCR 常把同一行切成好几个框（标点、空格、字距处断开），
/// 不先并回一行，后面每个碎框都会被当成独立段落各翻一次。
/// 纵向重叠过半 = 同一行；行内按 x 排序，横向空隙超过约 3.5 个字高视作分栏，就地拆开。
fn merge_rows(mut items: Vec<OcrLine>) -> Vec<OcrLine> {
    items.sort_by(|a, b| {
        let (ca, cb) = (a.y + a.h / 2.0, b.y + b.h / 2.0);
        ca.partial_cmp(&cb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut rows: Vec<Vec<OcrLine>> = Vec::new();
    for it in items {
        let same = match rows.last() {
            Some(row) => {
                let y0 = row.iter().map(|l| l.y).fold(f32::INFINITY, f32::min);
                let y1 = row.iter().map(|l| l.y + l.h).fold(f32::NEG_INFINITY, f32::max);
                span_overlap(it.y, it.y + it.h, y0, y1) > it.h.min(y1 - y0) * 0.5
            }
            None => false,
        };
        if same {
            rows.last_mut().unwrap().push(it);
        } else {
            rows.push(vec![it]);
        }
    }

    let mut out: Vec<OcrLine> = Vec::new();
    for mut row in rows {
        row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut cur: Option<OcrLine> = None;
        for it in row {
            let joinable = cur
                .as_ref()
                .map(|c| it.x - (c.x + c.w) <= c.h.max(it.h) * 3.5)
                .unwrap_or(false);
            if joinable {
                let c = cur.as_mut().unwrap();
                append_line(&mut c.text, it.text.trim());
                union_box(&mut c.x, &mut c.y, &mut c.w, &mut c.h, &it);
            } else {
                out.extend(cur.take());
                cur = Some(OcrLine { text: it.text.trim().to_string(), ..it });
            }
        }
        out.extend(cur);
    }
    out
}

/// 中位数（会重排输入，调用方传副本）
fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

/// 视觉行 → 自然段。一行接在某段后面，要同时满足：行距和这张图的常规行距一致、
/// 字号没变、与该段横向重叠、左边界没有大幅错开。同时匹配「所有已开的段」而不只是最后一段，
/// 分栏排版才不会被交错的行拆散。
///
/// 行距按「上沿到上沿」量，不按「上一行底边到这一行上沿」：OCR 框是贴着字轮廓的，
/// 一行里有没有 g/y 这种降部就能让框高差出两三成，用底边算行距会被这点抖动带偏 ——
/// 正文被拦腰切成两段就是这么来的。阈值也不再用固定的行高倍数，而是跟这张图自己的
/// 中位行距比，松排版、紧排版都成立。
///
/// 另外刻意不看句末标点：一段里本来就可以有好几句，按句号断段会把整段切成碎片，
/// 逐段翻译时丢掉上下文（"有道" 被当成 "Yiddish" 就是这么来的）。
fn rows_to_blocks(rows: Vec<OcrLine>) -> Vec<OcrBlock> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut heights: Vec<f32> = rows.iter().map(|r| r.h).filter(|h| *h > 0.0).collect();
    let med_h = median(&mut heights).max(1.0);
    let mut pitches: Vec<f32> = rows
        .windows(2)
        .map(|w| w[1].y - w[0].y)
        .filter(|p| *p > med_h * 0.35)
        .collect();
    let pitch_n = pitches.len();
    let med_pitch = median(&mut pitches);
    // 样本够多才信这张图自己的中位行距；只有一两行时退回按行高判
    let max_pitch = if pitch_n >= 3 && med_pitch > 0.0 { med_pitch * 1.35 } else { med_h * 2.0 };

    let mut blocks: Vec<OcrBlock> = Vec::new();
    // 每段最后一行的 (上沿, 行高, 左边界)，用于判断下一行是否接着它
    let mut tails: Vec<(f32, f32, f32)> = Vec::new();

    for r in rows {
        let mut best: Option<(usize, f32)> = None;
        for (i, b) in blocks.iter().enumerate() {
            let (last_y, last_h, left) = tails[i];
            let pitch = r.y - last_y;
            if pitch <= med_h * 0.35 || pitch > max_pitch {
                continue; // 不是紧接着的下一行：同排的另一栏，或隔了一整段
            }
            if (r.h - last_h).abs() > r.h.max(last_h) * 0.4 {
                continue; // 字号明显换了：标题、引文、脚注，不是同一段的续行
            }
            let line_h = last_h.max(r.h).max(1.0);
            if span_overlap(r.x, r.x + r.w, b.x, b.x + b.w) < r.w.min(b.w) * 0.35 {
                continue; // 横向不重叠 = 另一栏
            }
            if (r.x - left).abs() > line_h * 2.5 {
                continue; // 左边界大幅错开：居中标题、独立条目
            }
            if best.map(|(_, s)| pitch < s).unwrap_or(true) {
                best = Some((i, pitch));
            }
        }
        match best {
            Some((i, _)) => {
                let b = &mut blocks[i];
                append_line(&mut b.text, &r.text);
                union_box(&mut b.x, &mut b.y, &mut b.w, &mut b.h, &r);
                tails[i] = (r.y, r.h, r.x);
            }
            None => {
                tails.push((r.y, r.h, r.x));
                blocks.push(OcrBlock { text: r.text, x: r.x, y: r.y, w: r.w, h: r.h });
            }
        }
    }
    blocks
}

/// 引擎只给了文本没给坐标时的退路：上一行以句末标点收尾才断段
fn group_by_punct(lines: Vec<OcrLine>) -> Vec<OcrBlock> {
    let mut blocks: Vec<OcrBlock> = Vec::new();
    let mut prev_ends = true;
    for line in lines {
        let text = line.text.trim().to_string();
        if prev_ends || blocks.is_empty() {
            blocks.push(OcrBlock { text: text.clone(), x: line.x, y: line.y, w: line.w, h: line.h });
        } else if let Some(b) = blocks.last_mut() {
            append_line(&mut b.text, &text);
        }
        prev_ends = text.chars().last().map(ends_sentence).unwrap_or(false);
    }
    blocks
}

/// OCR 结果 → 自然段落。段是翻译和原位覆盖的最小单位：切得太碎既丢上下文，
/// 排版上也会散成一堆互相压住的小方块。
fn group_ocr_blocks(lines: Vec<OcrLine>) -> Vec<OcrBlock> {
    let items: Vec<OcrLine> = lines.into_iter().filter(|l| !l.text.trim().is_empty()).collect();
    if items.is_empty() {
        return Vec::new();
    }
    if !items.iter().any(|l| l.w > 0.0 && l.h > 0.0) {
        return group_by_punct(items);
    }
    rows_to_blocks(merge_rows(items))
}

/// 段落文本还原成给翻译引擎/弹窗看的整段原文（段间保留换行）
fn blocks_to_text(blocks: &[OcrBlock]) -> String {
    blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
}

#[derive(Deserialize)]
struct LocalTranslateRequest {
    backend: String,
    model: String,
    text: String,
    #[serde(rename = "sourceLang")]
    source_lang: String,
    #[serde(rename = "targetLang")]
    target_lang: String,
    #[serde(rename = "targetName", default)]
    target_name: String,
    #[serde(default)]
    ocr: bool,
    /// 领域提示词（用户自定义翻译要求），仅 GGUF 大模型使用；NLLB/Opus 桥接忽略
    #[serde(rename = "domainPrompt", default)]
    domain_prompt: String,
}

#[tauri::command]
async fn local_translate(app: AppHandle, req: LocalTranslateRequest) -> Result<Value, String> {
    let backend = req.backend;
    let model = req.model;
    // 本地 GGUF：走 Rust 原生 llama-cpp-2，不再经 Python
    if backend == "qwen" {
        let (m, text, src, tgt, name, ocr, domain) = (
            model, req.text, req.source_lang, req.target_lang, req.target_name, req.ocr,
            req.domain_prompt,
        );
        return tauri::async_runtime::spawn_blocking(move || {
            gguf::translate(&m, &text, &src, &tgt, &name, ocr, &domain, &mut |_| {})
                .map(|t| json!({ "text": t }))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let payload = json!({
        "op": "translate",
        "text": req.text,
        "sourceLang": req.source_lang,
        "targetLang": req.target_lang
    });
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        bridge_request(state.inner(), &backend, &model, payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 流式版本的本地翻译。事件名与 [`llm_stream`] 完全一致（`llm:delta` / `llm:done` /
/// `llm:error` + req_id），前端因此不必为"本地/在线"各写一套接收逻辑。
///
/// 只有 GGUF 大模型是逐 token 生成的；NLLB / Opus 是整句一次出结果的翻译模型，
/// 没有中间态可流，这里退回一次性调用再补一个 done 事件，对前端保持同一套协议。
#[tauri::command]
async fn local_translate_stream(
    app: AppHandle,
    window: tauri::WebviewWindow,
    req_id: u64,
    req: LocalTranslateRequest,
) -> Result<(), String> {
    if req.backend != "qwen" {
        match local_translate(app, req).await {
            Ok(v) => {
                let full = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
            }
            Err(e) => {
                let _ = window.emit("llm:error", json!({ "id": req_id, "message": e }));
            }
        }
        return Ok(());
    }

    let (m, text, src, tgt, name, ocr, domain) = (
        req.model, req.text, req.source_lang, req.target_lang, req.target_name, req.ocr,
        req.domain_prompt,
    );
    let w = window.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        gguf::translate(&m, &text, &src, &tgt, &name, ocr, &domain, &mut |piece| {
            let _ = w.emit("llm:delta", json!({ "id": req_id, "text": piece }));
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    match out {
        Ok(full) => {
            let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
        }
        Err(e) => {
            let _ = window.emit("llm:error", json!({ "id": req_id, "message": e }));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct LocalChatRequest {
    backend: String,
    model: String,
    question: String,
    #[serde(rename = "contextTitle")]
    context_title: String,
    #[serde(rename = "contextSource")]
    context_source: String,
    #[serde(rename = "contextTranslated")]
    context_translated: String,
}

#[tauri::command]
async fn local_chat(app: AppHandle, req: LocalChatRequest) -> Result<Value, String> {
    let backend = req.backend;
    let model = req.model;
    // 本地 GGUF：走 Rust 原生 llama-cpp-2，不再经 Python
    if backend == "qwen" {
        let (m, q, t, s, tr) = (
            model,
            req.question,
            req.context_title,
            req.context_source,
            req.context_translated,
        );
        return tauri::async_runtime::spawn_blocking(move || {
            gguf::chat(&m, &q, &t, &s, &tr, &mut |_| {}).map(|out| json!({ "text": out }))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let payload = json!({
        "op": "chat",
        "question": req.question,
        "contextTitle": req.context_title,
        "contextSource": req.context_source,
        "contextTranslated": req.context_translated
    });
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        bridge_request(state.inner(), &backend, &model, payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 流式版本的本地对话（F4）。协议同 [`local_translate_stream`]。
/// 对话是本地模型里输出最长的一档（上限 768 token），流式对体感的改善也最大。
#[tauri::command]
async fn local_chat_stream(
    app: AppHandle,
    window: tauri::WebviewWindow,
    req_id: u64,
    req: LocalChatRequest,
) -> Result<(), String> {
    if req.backend != "qwen" {
        match local_chat(app, req).await {
            Ok(v) => {
                let full = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
            }
            Err(e) => {
                let _ = window.emit("llm:error", json!({ "id": req_id, "message": e }));
            }
        }
        return Ok(());
    }

    let (m, q, t, s, tr) = (
        req.model,
        req.question,
        req.context_title,
        req.context_source,
        req.context_translated,
    );
    let w = window.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        gguf::chat(&m, &q, &t, &s, &tr, &mut |piece| {
            let _ = w.emit("llm:delta", json!({ "id": req_id, "text": piece }));
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    match out {
        Ok(full) => {
            let _ = window.emit("llm:done", json!({ "id": req_id, "full": full }));
        }
        Err(e) => {
            let _ = window.emit("llm:error", json!({ "id": req_id, "message": e }));
        }
    }
    Ok(())
}

/// 释放本地模型占的内存。两条路径分别处理：
/// - GGUF 权重缓存在本进程的 LRU 里，清空即 Drop，1 GB 级的内存立刻还给系统
/// - NLLB / Opus / OCR 跑在独立的 Python 子进程里，丢掉会话即触发 `BridgeSession::Drop`
///   里的 kill，整个进程的内存一次性释放（3 GB 级的 NLLB-3.3B 主要在这边）
///
/// 两者下次被用到时都会自动重新加载：GGUF 见 `gguf::run` 的 slot miss 分支，
/// bridge 见 `bridge_request` 里 guard 为 None 时的重启逻辑。
#[tauri::command]
fn local_unload(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let gguf = gguf::unload();
    let bridge = match state.bridge.try_lock() {
        Ok(mut g) => Some(g.take().is_some()),
        Err(_) => None,
    };
    // 拿不到锁 = 正在生成中。这时候硬等会把界面卡住，不如直接让用户等它结束
    if gguf.is_none() || bridge.is_none() {
        return Err("本地模型正在使用中，等这次翻译 / 对话结束后再试".into());
    }
    Ok(json!({ "gguf": gguf.unwrap_or(0), "bridge": bridge.unwrap_or(false) }))
}

#[derive(Deserialize)]
struct LocalCorrectRequest {
    backend: String,
    model: String,
    text: String,
}

/// OCR 原文纠错：仅本地 GGUF(qwen) 原生支持；非 LLM 后端原样返回（前端不会对其调用）。
#[tauri::command]
async fn local_correct(req: LocalCorrectRequest) -> Result<Value, String> {
    if req.backend == "qwen" {
        let (m, text) = (req.model, req.text);
        return tauri::async_runtime::spawn_blocking(move || {
            gguf::correct_ocr(&m, &text).map(|t| json!({ "text": t }))
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(json!({ "text": req.text }))
}


fn remember_foreground(app: &AppHandle) {
    #[cfg(windows)]
    {
        let hwnd = win32::foreground_hwnd();
        let state = app.state::<AppState>();
        *state.target_hwnd.lock().unwrap() = hwnd;
    }
}

fn on_f1(app: &AppHandle) {
    remember_foreground(app);
    let _ = app.emit_to("popup", "popup-mode", json!({ "mode": "f1", "state": "grabbing" }));
    let _ = popup_present(app.clone(), 420.0, 150.0, false);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let text = grab_selection_blocking();
        let _ = app2.emit_to("popup", "popup-mode", json!({ "mode": "f1", "state": "text", "text": text.trim() }));
    });
}

fn on_f2(app: &AppHandle) {
    remember_foreground(app);
    let _ = app.emit_to("popup", "popup-mode", json!({ "mode": "f2" }));
    let _ = popup_present(app.clone(), 420.0, 168.0, true);
}

/// 把 RGBA 像素编码成 PNG 的 data URL（供 snip overlay / 复制截图 / 贴图置顶复用）
fn encode_png_data_url(w: u32, h: u32, rgba: &[u8]) -> String {
    use base64::Engine as _;
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    if w == 0 || h == 0 || rgba.len() < (w as usize) * (h as usize) * 4 {
        return String::new();
    }
    let mut buf: Vec<u8> = Vec::new();
    // 这张图只在内存里转一手（webview 底图 / 剪贴板 / 贴图），不落盘，
    // 用默认压缩率编一张 4K 全屏要好几百毫秒 —— 那正是按下 F3 后卡住的那一下。
    let enc = PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter);
    if enc
        .write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
        .is_err()
    {
        return String::new();
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    format!("data:image/png;base64,{b64}")
}

fn ocr_popup_error(app: &AppHandle, msg: String) {
    let _ = popup_present(app.clone(), 420.0, 118.0, false);
    let _ = app.emit_to("popup", "popup-mode", json!({ "mode": "ocr", "error": msg }));
}

/// F3：截取整个虚拟桌面（所有屏一张图）→ 打开覆盖全屏的自定义框选 overlay。
/// 框选、裁剪、OCR 都在自定义窗口内完成，无系统截图工具的声音 / 落盘 / 弹窗。
fn on_f3(app: &AppHandle) {
    // 上一轮的原位覆盖窗口是置顶的，不先收起来会被一起截进新截图里
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) {
            // 先让它把画面清空并画出来，再隐藏。直接 hide 的话图层里会留着这一轮的
            // 画面，下次显示时闪一帧旧内容（见 overlay.ts 的 clearVisual）
            let _ = app.emit_to("overlay", "overlay-clear", json!({}));
            std::thread::sleep(Duration::from_millis(60));
            let _ = w.hide();
            std::thread::sleep(Duration::from_millis(90)); // 等桌面重绘，否则截到残影
        }
    }
    // 这一轮的编号：Esc 取消（snip_hide）会推进它，让下面的兜底显示作废
    let my_round = {
        let state = app.state::<AppState>();
        let mut r = state.snip_round.lock().unwrap();
        *r += 1;
        *r
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let cap = win32::capture_virtual_screen();
        #[cfg(not(windows))]
        let cap: Option<(i32, i32, i32, i32, Vec<u8>)> = None;

        let (vx, vy, vw, vh, rgba) = match cap {
            Some(v) => v,
            None => {
                ocr_popup_error(&app2, "截屏失败".into());
                return;
            }
        };

        let data_url = encode_png_data_url(vw as u32, vh as u32, &rgba);
        if data_url.is_empty() {
            ocr_popup_error(&app2, "截屏编码失败".into());
            return;
        }
        {
            let state = app2.state::<AppState>();
            *state.snip_full.lock().unwrap() = Some(data_url);
            // 记住虚拟桌面原点：框选坐标是相对这张全屏图的，加上原点才是真实屏幕坐标
            *state.snip_origin.lock().unwrap() = (vx, vy);
        }

        if let Some(snip) = app2.get_webview_window("snip") {
            // 位置尺寸先摆好，但先不显示：等 snip.ts 把新截图解码完再调 snip_show 亮出来。
            // 先显示的话会有一两帧露着上一轮的旧截图（或半透明的实时桌面），
            // 用户看到的就是"屏幕突兀地跳一下"。
            let _ = snip.set_position(PhysicalPosition::new(vx, vy));
            let _ = snip.set_size(tauri::PhysicalSize::new(vw as u32, vh as u32));
            // 主动信号：snip.ts 收到后调 snip_data 拉取全屏图（避免 emit 早于 webview 就绪）
            let _ = app2.emit_to("snip", "snip-open", json!({}));
        }

        // 兜底：webview 万一还没就绪收不到事件，1.5s 后也把窗口亮出来，
        // 否则这次 F3 会像完全没反应。期间用户按了 Esc（snip_hide 会推进轮次）就作废。
        let app3 = app2.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let state = app3.state::<AppState>();
            if *state.snip_round.lock().unwrap() != my_round {
                return;
            }
            if let Some(w) = app3.get_webview_window("snip") {
                if !w.is_visible().unwrap_or(false) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    });
}

/// 新截图在 snip 窗口里解码完成后才亮出来，避免闪出上一轮的旧图
#[tauri::command]
fn snip_show(app: AppHandle) {
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

/// snip overlay 主动拉取当前的全屏截图（data URL）
#[tauri::command]
fn snip_data(state: tauri::State<'_, AppState>) -> Option<String> {
    state.snip_full.lock().unwrap().clone()
}

/// 隐藏 snip overlay（取消或完成时）
#[tauri::command]
fn snip_hide(app: AppHandle) {
    // 推进轮次：这一轮已经收场，别再被延迟的兜底显示唤醒
    *app.state::<AppState>().snip_round.lock().unwrap() += 1;
    if let Some(w) = app.get_webview_window("snip") {
        let _ = w.hide();
    }
}

#[derive(Deserialize)]
struct NativeOcrRequest {
    #[serde(rename = "imageB64")]
    image_b64: String,
    #[serde(rename = "sourceLang")]
    source_lang: String,
    /// 自定义 OCR 模型（RapidOCR 格式的 ONNX）：{ detPath, recPath, keysPath, clsPath }。
    /// 非空时强制走 bridge 的 RapidOCR，用它来识别系统没装语言包的语种（韩语/俄语…）。
    #[serde(default)]
    custom: Value,
}

/// 自定义 OCR 配置是否填了至少一个模型路径
fn custom_ocr_active(v: &Value) -> bool {
    ["recPath", "detPath"]
        .iter()
        .any(|k| v.get(k).and_then(Value::as_str).map(|s| !s.trim().is_empty()).unwrap_or(false))
}

/// 截图 OCR：选了自定义 OCR 模型就走它；否则中/英优先走 bridge 的 RapidOCR
/// （中文特训模型，质量远超系统 OCR），bridge 不可用或其他语种回退 Windows 原生 OCR。
/// 返回整段原文 + 逐段文字框（供「原位覆盖」把译文贴回原处）。
#[tauri::command]
async fn native_ocr(app: AppHandle, req: NativeOcrRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let custom = custom_ocr_active(&req.custom);
        // RapidOCR 的默认模型只覆盖中英；日韩俄等语种没配自定义模型时仍用系统对应语言引擎
        let rapid_ok = custom || matches!(req.source_lang.trim(), "" | "auto" | "zh" | "zh-Hant" | "en");
        let mut custom_err = String::new();
        if rapid_ok {
            let state = app.state::<AppState>();
            match bridge_ocr(state.inner(), &req.image_b64, &req.custom) {
                Ok(lines) if !lines.is_empty() => {
                    let blocks = group_ocr_blocks(lines);
                    return Ok(json!({ "source": blocks_to_text(&blocks), "blocks": blocks }));
                }
                Ok(_) => {}
                // 自定义模型出错要说清楚，否则会静默回退到系统 OCR 让人以为"设置没生效"
                Err(e) => custom_err = e,
            }
            if custom && !custom_err.is_empty() {
                return Err(format!("自定义 OCR 模型识别失败：{custom_err}"));
            }
        }
        use base64::Engine as _;
        let raw = req.image_b64.split(',').last().unwrap_or("");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|e| e.to_string())?;
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?.to_rgba8();
        let (w, h) = img.dimensions();
        #[cfg(windows)]
        let lines = ocr::recognize_rgba(w, h, &img.into_raw(), &req.source_lang)?;
        #[cfg(not(windows))]
        let lines: Vec<OcrLine> = {
            let _ = (w, h);
            Vec::new()
        };
        let blocks = group_ocr_blocks(lines);
        Ok(json!({ "source": blocks_to_text(&blocks), "blocks": blocks }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把一张 PNG（base64，可含 data: 前缀）复制到剪贴板
#[tauri::command]
fn copy_image(b64: String) -> Result<(), String> {
    use base64::Engine as _;
    let raw = b64.split(",").last().unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::from(img.into_raw()),
    })
    .map_err(|e| e.to_string())
}

/// 贴图置顶：把截取的图片钉在屏幕上（可拖动的置顶小窗）
#[tauri::command]
fn pin_show(app: AppHandle, b64: String, width: f64, height: f64) -> Result<(), String> {
    *app.state::<AppState>().pin_img.lock().unwrap() = Some(b64);
    let pin = app.get_webview_window("pin").ok_or("pin window missing")?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let w = width.max(80.0).min(1600.0);
    let h = height.max(60.0).min(1200.0);
    let _ = pin.set_size(LogicalSize::new(w, h));
    let _ = pin.set_position(PhysicalPosition::new(cursor.x + 12.0, cursor.y + 12.0));
    let _ = pin.show();
    let _ = pin.set_always_on_top(true);
    let _ = pin.set_focus();
    let _ = app.emit_to("pin", "pin-open", json!({}));
    Ok(())
}

#[tauri::command]
fn pin_data(state: tauri::State<'_, AppState>) -> Option<String> {
    state.pin_img.lock().unwrap().clone()
}

#[tauri::command]
fn pin_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("pin") {
        let _ = w.hide();
    }
}

#[derive(Deserialize)]
struct OverlayRequest {
    /// 框选区域的截图（data URL），作为覆盖层底图
    img: String,
    /// 段落框 + 原文（坐标是相对截图的物理像素），译文由 overlay 窗口自己算
    blocks: Value,
    /// 框选区域相对虚拟桌面截图的物理像素位置
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    /// 框选区域的逻辑（CSS）尺寸，转交弹窗用于「贴图置顶」
    #[serde(rename = "cssW", default)]
    css_w: f64,
    #[serde(rename = "cssH", default)]
    css_h: f64,
}

/// 原位覆盖：在框选区域正上方开一个同尺寸的置顶窗口，把译文盖在原文位置上。
/// 用物理像素定位/定尺，避免高 DPI 下逻辑像素换算导致的错位。
#[tauri::command]
fn overlay_show(app: AppHandle, req: OverlayRequest) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (vx, vy) = *state.snip_origin.lock().unwrap();
    *state.overlay.lock().unwrap() = Some(json!({
        "img": req.img, "blocks": req.blocks, "w": req.w, "h": req.h,
        "cssW": req.css_w, "cssH": req.css_h,
    }));
    let win = app.get_webview_window("overlay").ok_or("overlay window missing")?;
    // 和 snip 同理：先摆好位置尺寸但不显示，等 overlay.ts 把新底图解码完再调
    // overlay_ready。抢先显示会亮一帧上一次翻译留在图层里的旧图（旧尺寸的旧内容），
    // 看起来就是一下"从大变小"。
    let _ = win.set_size(tauri::PhysicalSize::new(req.w.max(40), req.h.max(30)));
    let _ = win.set_position(PhysicalPosition::new(vx + req.x, vy + req.y));
    let _ = app.emit_to("overlay", "overlay-open", json!({}));

    // 兜底：webview 没就绪收不到事件时也得把窗口亮出来
    let my_round = {
        let mut r = state.overlay_round.lock().unwrap();
        *r += 1;
        *r
    };
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let state = app2.state::<AppState>();
        if *state.overlay_round.lock().unwrap() != my_round {
            return;
        }
        if let Some(w) = app2.get_webview_window("overlay") {
            if !w.is_visible().unwrap_or(false) {
                let _ = w.show();
                let _ = w.set_always_on_top(true);
            }
        }
    });
    Ok(())
}

/// 新底图解码完后才亮出覆盖窗口，避免闪出上一轮的旧内容
#[tauri::command]
fn overlay_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn overlay_data(state: tauri::State<'_, AppState>) -> Option<Value> {
    state.overlay.lock().unwrap().clone()
}

#[tauri::command]
fn overlay_close(app: AppHandle) {
    // 推进轮次：这一轮已收场，别再被延迟的兜底显示唤醒
    *app.state::<AppState>().overlay_round.lock().unwrap() += 1;
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
}

/// 在系统文件管理器中打开文件夹（绕过 opener 插件的路径 scope 限制）
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = path.replace('/', "\\");
    #[cfg(windows)]
    {
        Command::new("explorer").arg(&p).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = p;
        Err("unsupported platform".into())
    }
}

/* ───────── 检查更新 ─────────
 *
 * 刻意做成纯手动：FlashTrans 主打本地离线，启动和后台都不发任何网络请求，
 * 只有用户在「关于」里点「检查更新」才走下面这一次 GET。请求里不带任何
 * 个人信息、设备标识或翻译内容 —— 就是拉一个静态 JSON 比版本号。
 *
 * 用仓库里的静态文件而不是 GitHub API：后者未认证时限 60 次/小时/IP，
 * 共享出口 IP 的用户（校园网、公司网）会莫名其妙地失败。
 */
const UPDATE_MANIFEST: &str =
    "https://raw.githubusercontent.com/chai1220/FlashTrans/master/version.json";
const RELEASES_PAGE: &str = "https://github.com/chai1220/FlashTrans/releases";

#[derive(Serialize)]
struct UpdateInfo {
    current: String,
    latest: String,
    /// 远端版本是否确实比当前新（不是「不相等」——用户装了预发布版时不该被劝退回旧版）
    newer: bool,
    notes: String,
    url: String,
}

/// 按数字分段比较版本号。不能用字符串比较：那样 "2.10.0" < "2.3.0"。
fn version_gt(a: &str, b: &str) -> bool {
    fn parts(s: &str) -> Vec<u32> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .map(|seg| {
                seg.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<u32>()
                    .unwrap_or(0)
            })
            .collect()
    }
    let (x, y) = (parts(a), parts(b));
    for i in 0..x.len().max(y.len()) {
        let (l, r) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if l != r {
            return l > r;
        }
    }
    false
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let resp = http_client()
        .get(UPDATE_MANIFEST)
        .header("User-Agent", "FlashTrans")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "连接失败，请检查网络后重试".to_string())?;

    if !resp.status().is_success() {
        return Err(format!("检查更新失败（HTTP {}）", resp.status().as_u16()));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| "更新信息格式异常".to_string())?;

    let latest = v.get("version").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if latest.is_empty() {
        return Err("更新信息里没有版本号".into());
    }
    Ok(UpdateInfo {
        newer: version_gt(&latest, &current),
        current,
        latest,
        notes: v.get("notes").and_then(Value::as_str).unwrap_or("").to_string(),
        url: v
            .get("url")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(RELEASES_PAGE)
            .to_string(),
    })
}

/// 用系统默认浏览器打开链接。走 Rust 侧的 opener，前端因此不必申请 opener 的 URL 权限。
#[tauri::command]
fn open_url(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let target = url.unwrap_or_default();
    let target = target.trim();
    let target = if target.is_empty() { RELEASES_PAGE } else { target };
    // 只放行 http(s)，避免把 file:// 之类的东西交给系统去执行
    if !target.starts_with("https://") && !target.starts_with("http://") {
        return Err("不支持的链接".into());
    }
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| e.to_string())
}

fn on_f4(app: &AppHandle) {
    let clip = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok())
        .unwrap_or_default();
    if let Some(chat) = app.get_webview_window("chat") {
        let _ = chat.show();
        let _ = chat.set_focus();
        let _ = app.emit_to("chat", "chat-open", json!({ "clipboard": clip.trim() }));
    }
}

fn on_f5(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) && main.is_focused().unwrap_or(false) {
            let _ = main.hide();
        } else {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }
}

/// 按设置里的组合键注册全局热键（设置保存时重新注册）。
///
/// 不能用 `unregister_all()` 打头：它在主线程上调用时会失败，而失败后插件内部的
/// 已注册表并没有清空，紧接着的 register 就会被判成 "already registered" 而全部落空
/// ——表现是保存一次设置之后 F1~F5 全部失灵。改成只动真正变化了的那几个键。
fn apply_hotkeys(app: &AppHandle) {
    static APPLIED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    let gs = app.global_shortcut();
    let s = read_settings_value(app);
    let empty = json!({});
    let hk = s.get("hotkeys").unwrap_or(&empty);

    let wanted: Vec<String> = [("f1", "F1"), ("f2", "F2"), ("f3", "F3"), ("f4", "F4"), ("f5", "F5")]
        .iter()
        .map(|(name, def)| hk.get(name).and_then(Value::as_str).unwrap_or(def).trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let mut applied = APPLIED.lock().unwrap();
    for old in applied.iter() {
        if !wanted.contains(old) {
            let _ = gs.unregister(old.as_str());
        }
    }
    for combo in &wanted {
        if gs.is_registered(combo.as_str()) {
            continue;
        }
        if let Err(e) = gs.register(combo.as_str()) {
            // 常见原因：另一个 FlashTrans 实例或别的软件已经占住了这个组合键
            eprintln!("hotkey {combo} register failed: {e}");
        }
    }
    *applied = wanted;
}

fn dispatch_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let s = read_settings_value(app);
    let empty = json!({});
    let hk = s.get("hotkeys").unwrap_or(&empty);
    let parse = |name: &str, def: &str| -> Option<Shortcut> {
        hk.get(name).and_then(Value::as_str).unwrap_or(def).parse::<Shortcut>().ok()
    };
    if Some(*shortcut) == parse("f1", "F1") {
        on_f1(app);
    } else if Some(*shortcut) == parse("f2", "F2") {
        on_f2(app);
    } else if Some(*shortcut) == parse("f3", "F3") {
        on_f3(app);
    } else if Some(*shortcut) == parse("f4", "F4") {
        on_f4(app);
    } else if Some(*shortcut) == parse("f5", "F5") {
        on_f5(app);
    }
}

/// 是否以「静默启动」方式拉起（开机自启走这条路：只驻留托盘，不弹主窗口）
fn silent_launch(args: &[String]) -> bool {
    args.iter().any(|a| a == "--silent" || a == "--tray")
}

/// 把主窗口叫到前台（托盘、第二次启动、F5 共用）
fn present_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// 开机自启：直接读写 HKCU\...\Run。自己写而不是用现成插件，是因为要保证
/// exe 路径带引号（安装目录含空格时不加引号会启动失败/被劫持），
/// 且值名和命令行要与安装包写的那条完全一致，避免留下两条重复启动项。
#[cfg(windows)]
mod autostart {
    use std::path::PathBuf;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// 任务管理器「启动」页的开关状态；用户在那里禁用过就必须清掉，否则 Run 项形同虚设
    const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const VALUE_NAME: &str = "FlashTrans";

    fn command_line() -> Result<String, String> {
        let exe: PathBuf = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(format!("\"{}\" --silent", exe.display()))
    }

    /// 任务管理器里是否被禁用（首字节含 bit1 = disabled）
    fn disabled_by_task_manager() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(APPROVED_KEY, KEY_READ)
            .ok()
            .and_then(|k| k.get_raw_value(VALUE_NAME).ok())
            .map(|v| v.bytes.first().map(|b| b & 1 != 0).unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn is_enabled() -> bool {
        let present = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_KEY, KEY_READ)
            .ok()
            .and_then(|k| k.get_value::<String, _>(VALUE_NAME).ok())
            .is_some();
        present && !disabled_by_task_manager()
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let (key, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
            key.set_value(VALUE_NAME, &command_line()?).map_err(|e| e.to_string())?;
            // 清掉任务管理器的禁用标记，否则开关是开的但开机仍然不启动
            if let Ok(approved) = hkcu.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
                let _ = approved.delete_value(VALUE_NAME);
            }
        } else if let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
            match key.delete_value(VALUE_NAME) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }
}

#[tauri::command]
fn autostart_get() -> bool {
    #[cfg(windows)]
    return autostart::is_enabled();
    #[cfg(not(windows))]
    false
}

#[tauri::command]
fn autostart_set(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    return autostart::set(enabled);
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("当前平台不支持开机自启".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：重复启动时把已有窗口叫出来，而不是再开一个
        // （多开的进程注册不上全局热键，只会变成用不了的僵尸窗口）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !silent_launch(&argv) {
                present_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            target_hwnd: Mutex::new(0),
            bridge: Mutex::new(None),
            snip_full: Mutex::new(None),
            snip_origin: Mutex::new((0, 0)),
            snip_round: Mutex::new(0),
            pin_img: Mutex::new(None),
            overlay: Mutex::new(None),
            overlay_round: Mutex::new(0),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    dispatch_hotkey(app, shortcut);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            commit_paste,
            copy_text,
            clipboard_text,
            popup_present,
            popup_resize,
            popup_grab_focus,
            llm_stream,
            models_scan,
            model_probe,
            local_translate,
            local_translate_stream,
            local_chat,
            local_chat_stream,
            local_correct,
            local_unload,
            app_version,
            check_update,
            open_url,
            snip_data,
            snip_show,
            snip_hide,
            native_ocr,
            copy_image,
            pin_show,
            pin_data,
            pin_close,
            overlay_show,
            overlay_ready,
            overlay_data,
            overlay_close,
            autostart_get,
            autostart_set,
            open_folder
        ])
        .setup(|app| {
            apply_hotkeys(app.handle());

            // 启动即预热在线 API：提前把连接 + 远端模型推理槽热起来，
            // 避免用户第一次划词翻译时等冷连接 / 冷 prefill（首字慢）。
            // 本地引擎模式或未配置 API 时内部自动跳过；静默启动也做，
            // 因为托盘常驻正是划词翻译的主要入口。
            if std::env::var("FLASHTRANS_NO_WARMUP").map(|v| v == "1").unwrap_or(false) {
                eprintln!("warmup disabled via FLASHTRANS_NO_WARMUP");
            } else {
                warmup_online_api(app.handle());
            }

            // 主窗口在配置里是 visible:false（避免开机自启时闪一下），
            // 非静默启动时在这里显示出来
            if !silent_launch(&std::env::args().collect::<Vec<_>>()) {
                present_main(app.handle());
            }

            #[cfg(windows)]
            for label in ["main", "popup", "chat", "pin", "overlay"] {
                if let Some(w) = app.get_webview_window(label) {
                    if let Ok(h) = w.hwnd() {
                        win32::round_corners(h.0 as isize);
                    }
                }
            }

            // 这几个是按一下就出、松手就走的瞬时窗口，系统的显示/隐藏缩放动画
            // 在它们身上只会变成一闪一缩的干扰
            #[cfg(windows)]
            for label in ["snip", "overlay", "popup"] {
                if let Some(w) = app.get_webview_window(label) {
                    if let Ok(h) = w.hwnd() {
                        win32::no_transitions(h.0 as isize);
                    }
                }
            }

            let show_item = MenuItemBuilder::with_id("show", "打开仪表盘").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出 FlashTrans").build(app)?;
            let menu = MenuBuilder::new(app).item(&show_item).separator().item(&quit_item).build()?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("FlashTrans - F1 划词 · F2 打字 · F3 OCR · F4 对话 · F5 仪表盘")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => present_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        present_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" || window.label() == "chat" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// OCR 分段是原位覆盖排版和翻译质量的地基，切错了后面全歪，用几个真实版式钉住它。
#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f32, y: f32, w: f32, h: f32) -> OcrLine {
        OcrLine { text: text.into(), x, y, w, h }
    }

    /// 字符串比较会让 2.10.0 小于 2.3.0 —— 那样用户会被永远卡在旧版上收不到更新
    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert!(version_gt("2.10.0", "2.3.0"));
        assert!(!version_gt("2.3.0", "2.10.0"));
    }

    #[test]
    fn version_compare_handles_prefix_and_short_forms() {
        assert!(version_gt("v2.4.0", "2.3.0")); // 远端写了 v 前缀
        assert!(version_gt("2.4", "2.3.9")); // 段数不齐时缺的位当 0
        assert!(!version_gt("2.3.0", "2.3.0")); // 同版本不该提示更新
        assert!(!version_gt("2.3.0", "2.4.0-beta.1")); // 预发布版用户不该被劝退回旧版
    }


    /// RapidOCR 常把同一视觉行切成几个检测框，必须先并回一行再谈分段
    #[test]
    fn same_row_boxes_merge_into_one_block() {
        let blocks = group_ocr_blocks(vec![
            line("功能很全面了，", 10.0, 100.0, 120.0, 20.0),
            line("我现在在用有道翻译，", 140.0, 101.0, 180.0, 20.0),
            line("功能都没你这么多。", 10.0, 126.0, 170.0, 20.0),
        ]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "功能很全面了，我现在在用有道翻译，功能都没你这么多。");
    }

    /// 一段里本来就能有好几句：句号不该断段，否则逐段翻译时丢上下文
    #[test]
    fn sentence_end_does_not_split_a_contiguous_paragraph() {
        let blocks = group_ocr_blocks(vec![
            line("这是第一句。", 10.0, 100.0, 300.0, 20.0),
            line("这是同一段的第二句。", 10.0, 126.0, 280.0, 20.0),
        ]);
        assert_eq!(blocks.len(), 1);
    }

    /// 行距明显变大 = 换段
    #[test]
    fn blank_line_splits_paragraphs() {
        let blocks = group_ocr_blocks(vec![
            line("第一段的正文", 10.0, 100.0, 300.0, 20.0),
            line("第二段的正文", 10.0, 170.0, 300.0, 20.0),
        ]);
        assert_eq!(blocks.len(), 2);
    }

    /// 分栏：横向不重叠的行不能并进同一段，且要按「先左栏后右栏」的顺序出现
    #[test]
    fn columns_stay_separate_and_in_reading_order() {
        let blocks = group_ocr_blocks(vec![
            line("left one", 10.0, 100.0, 180.0, 20.0),
            line("right one", 400.0, 100.0, 180.0, 20.0),
            line("left two", 10.0, 126.0, 180.0, 20.0),
            line("right two", 400.0, 126.0, 180.0, 20.0),
        ]);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "left one left two");
        assert_eq!(blocks[1].text, "right one right two");
    }

    /// 正文行的框高会随有没有 g/y 降部抖动，不能因此把一段拦腰切开。
    /// （实测回归：一段 6 行的英文正文被切成 3 行 + 3 行两段）
    #[test]
    fn jittery_box_heights_do_not_split_a_paragraph() {
        // 行距固定 26，框高在 17/20 之间抖
        let hs = [20.0, 17.0, 20.0, 17.0, 20.0, 18.0];
        let rows: Vec<OcrLine> = hs
            .iter()
            .enumerate()
            .map(|(i, h)| line("body line", 10.0, 100.0 + i as f32 * 26.0, 300.0, *h))
            .collect();
        assert_eq!(group_ocr_blocks(rows).len(), 1);
    }

    /// 标题字号比正文大，不能被并进正文第一段
    /// （实测回归：标题 + 正文首行并成一块后，NLLB 只译出标题，正文首句整句丢失）
    #[test]
    fn larger_heading_does_not_absorb_body_text() {
        let blocks = group_ocr_blocks(vec![
            line("The Quiet Hour", 10.0, 100.0, 160.0, 30.0),
            line("There is a particular kind of silence", 10.0, 148.0, 300.0, 19.0),
            line("that descends upon a city at dawn", 10.0, 174.0, 300.0, 19.0),
        ]);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "The Quiet Hour");
    }

    /// 引擎没给坐标时退回按句末标点分段
    #[test]
    fn without_boxes_falls_back_to_punctuation() {
        let blocks = group_ocr_blocks(vec![
            line("第一句结束。", 0.0, 0.0, 0.0, 0.0),
            line("第二段第一行", 0.0, 0.0, 0.0, 0.0),
            line("第二段第二行", 0.0, 0.0, 0.0, 0.0),
        ]);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].text, "第二段第一行第二段第二行");
    }
}
