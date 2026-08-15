// Rust 原生 GGUF 推理（llama-cpp-2），替代旧的 Python llama-cpp-python 桥接。
// 只负责本地大模型的翻译与对话；NLLB/Opus(CT2) 仍走 Python bridge。
// token_to_bytes/Special 虽被标 deprecated，但 token_to_bytes 会按需扩容缓冲，是最稳的反分词
#![allow(deprecated)]
use std::num::NonZeroU32;
use std::sync::{Mutex, OnceLock};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;

/// 全局 backend：llama.cpp 要求每进程只初始化一次
fn backend() -> &'static LlamaBackend {
    static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();
    BACKEND.get_or_init(|| {
        let mut b = LlamaBackend::init().expect("llama backend init failed");
        b.void_logs(); // 关掉 llama.cpp 的刷屏日志
        b
    })
}

struct Loaded {
    path: String,
    model: LlamaModel,
}

/// 同时缓存的模型上限。为 2 是因为「翻译模型 + 助手模型（F4 对话 / OCR 纠错）」
/// 允许各选一个 GGUF；只留 1 个槽会让两者互相顶掉、每次调用都重新载入。
/// 常见配置（助手留空、或翻译走 NLLB）只会占 1 个槽。
const MODEL_SLOTS: usize = 2;

/// 已加载模型的 LRU 缓存（最近使用的排在最前），避免每次调用都重新载入
fn model_slot() -> &'static Mutex<Vec<Loaded>> {
    static SLOT: OnceLock<Mutex<Vec<Loaded>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Vec::new()))
}

fn strip_unc(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// 上下文长度的**天花板**，不是每次都开这么大 —— 实际大小见 [`plan_ctx`]。
/// 因为改成了按需分配，这里可以给得很宽松，短句翻译不会因此多占一个字节 ——
/// 只有真的翻长文时才会分配到这个量级（16384 token 的 KV cache 约 1.75 GB）。
fn ctx_len() -> u32 {
    std::env::var("FLASHTRANS_CTX")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|n| *n >= MIN_CTX)
        .unwrap_or(16384)
}

/// 上下文的下限。KV cache 按 n_ctx 满额预分配，但开得太小反而会让分块喂入
/// （每块 512）失去意义，1024 是个不亏的地板。
const MIN_CTX: u32 = 1024;

/// 算出这次生成实际需要多大的上下文。
///
/// KV cache 是按 n_ctx **满额预分配**的（Qwen3-1.7B 约 112 KiB/token，开到 4096
/// 就是 448 MB）。以前不管翻一个单词还是三千字都固定开到天花板，等于划词翻译
/// 也要先划走小半个 G —— 一个常驻托盘的工具付不起这个。
///
/// 必须把待生成的 `max_tokens` 也算进去：只按 prompt 长度开的话，prompt 接近上限时
/// 能通过检查，但生成到一半 KV cache 就满了，会以 "Decode Error 1: NoKvCacheSlot"
/// 这种用户看不懂的话收场。
fn plan_ctx(prompt_tokens: usize, max_tokens: usize, ceiling: u32) -> Result<u32, String> {
    let need = prompt_tokens.saturating_add(max_tokens).saturating_add(64);
    let need = u32::try_from(need).unwrap_or(u32::MAX);
    if need > ceiling {
        return Err(format!(
            "输入过长：这次需要约 {need} token 的上下文，当前上限 {ceiling}。\
             请分段翻译，或用 FLASHTRANS_CTX 环境变量调大上限。"
        ));
    }
    // 向上取到 2 的幂，避免每次长度微调都重建一个尺寸略有差异的上下文
    Ok(need.next_power_of_two().clamp(MIN_CTX, ceiling))
}

fn n_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| ((n.get() / 2).max(1)) as i32)
        .unwrap_or(4)
}

// 原先的 strip_think 在这里：一次性拿到整段输出再剥 <think>。改成流式后这活儿
// 由 ThinkFilter 边流边做（它还得处理标签被切在两个 token 里的情况），不再需要事后版本。

/// 流式输出时的 `<think>` 过滤器。
///
/// 一次性返回的场景可以直接用 [`strip_think`]，但流式是一段一段来的：`<think>` 这七个字
/// 完全可能被切在两个 token 里（甚至逐字来），拿到半截就判断会把标签漏出去给用户看。
/// 所以这里始终扣住"可能是标签前缀"的那个尾巴不发，凑够了能判定再决定发还是吞。
struct ThinkFilter {
    buf: String,
    in_think: bool,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

impl ThinkFilter {
    fn new() -> Self {
        Self { buf: String::new(), in_think: false }
    }

    /// buf 末尾有多长的一段是 `tag` 的真前缀（可能是被切断的标签开头）
    fn holdback(buf: &str, tag: &str) -> usize {
        let max = tag.len().saturating_sub(1).min(buf.len());
        for n in (1..=max).rev() {
            let start = buf.len() - n;
            if buf.is_char_boundary(start) && tag.starts_with(&buf[start..]) {
                return n;
            }
        }
        0
    }

    /// 吃进一段新文本，吐出这一刻可以安全显示给用户的部分
    fn push(&mut self, s: &str) -> String {
        self.buf.push_str(s);
        let mut out = String::new();
        loop {
            if self.in_think {
                match self.buf.find(THINK_CLOSE) {
                    Some(i) => {
                        self.buf.drain(..i + THINK_CLOSE.len());
                        self.in_think = false;
                    }
                    None => {
                        // 思考内容整段丢弃，只留可能是 </think> 开头的尾巴
                        let keep = Self::holdback(&self.buf, THINK_CLOSE);
                        let cut = self.buf.len() - keep;
                        self.buf.drain(..cut);
                        return out;
                    }
                }
            } else {
                match self.buf.find(THINK_OPEN) {
                    Some(i) => {
                        out.push_str(&self.buf[..i]);
                        self.buf.drain(..i + THINK_OPEN.len());
                        self.in_think = true;
                    }
                    None => {
                        let keep = Self::holdback(&self.buf, THINK_OPEN);
                        let cut = self.buf.len() - keep;
                        out.push_str(&self.buf[..cut]);
                        self.buf.drain(..cut);
                        return out;
                    }
                }
            }
        }
    }

    /// 生成结束：把扣住的尾巴放出来（此时它已经不可能是标签了）
    fn flush(&mut self) -> String {
        if self.in_think {
            self.buf.clear();
            return String::new();
        }
        std::mem::take(&mut self.buf)
    }
}

/// 卸载所有已缓存的 GGUF 模型，把权重占的内存立刻还给系统。
/// 返回卸载了几个；正在生成时拿不到锁，返回 None 让调用方提示稍后再试。
pub fn unload() -> Option<usize> {
    let mut slot = model_slot().try_lock().ok()?;
    let n = slot.len();
    slot.clear();
    Some(n)
}

/// 粗估一段文本的 token 数。CJK 基本一字一 token，拉丁文约四字符一 token。
/// 只用来估预算，不需要准 —— 准的那个要等模型加载完才能分词，太晚了。
fn estimate_tokens(text: &str) -> usize {
    let units: usize = text
        .chars()
        .map(|c| if c as u32 >= 0x2E80 { 4 } else { 1 })
        .sum();
    units / 4 + 1
}

/// 翻译一次最多生成多少 token。
///
/// 以前这里是写死的 640（约 400~500 汉字）——翻译是 1:1 的任务，原文多长译文就得多长，
/// 固定上限意味着**只要原文超过四百来字，译文就一定在中途被切断**，而且不报错。
/// 上下文开得再大也救不了，因为先撞上的是这条线。
///
/// 所以按原文长度估，再留一倍余量（换语言后长度会变，中译英常涨不少）。
/// 上限 4096 是权衡后的结果。它不是内存问题而是时间问题：纯 CPU 下 1.7B 大约每秒
/// 十几个 token，4096 要等好几分钟。但**译到一半停住比等得久更糟** —— 前者用户拿到的
/// 是残缺译文且不知道残缺，后者至少能看着字往外蹦、随时可以放弃。有了流式输出之后，
/// 这个取舍明显偏向放宽。整页正文（约 800~1200 token）现在能完整译完。
fn translate_budget(text: &str) -> usize {
    (estimate_tokens(text) * 2).clamp(256, 4096)
}

fn detect_zh(text: &str) -> bool {
    text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 把语言代码解析成实际目标语言 + 可读名（供提示词）。
/// explicit_name 为前端下发的目标语言英文名（覆盖 FLORES-200 长尾语言）；非空时优先采用。
fn resolve_target(text: &str, source: &str, target: &str, explicit_name: &str) -> String {
    let target = target.trim();
    if !target.is_empty() && target != "auto" {
        let name = explicit_name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
        return lang_name(target);
    }
    let src_is_zh = source.trim().starts_with("zh") || (source.trim() == "auto" && detect_zh(text));
    lang_name(if src_is_zh { "en" } else { "zh" })
}

fn lang_name(code: &str) -> String {
    let n = match code {
        "zh" | "zh-Hans" => "Chinese (Simplified)",
        "zh-Hant" => "Chinese (Traditional)",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "ar" => "Arabic",
        "hi" => "Hindi",
        "vi" => "Vietnamese",
        "th" => "Thai",
        "tr" => "Turkish",
        "nl" => "Dutch",
        "pl" => "Polish",
        "el" => "Greek",
        "sv" => "Swedish",
        other => other,
    };
    n.to_string()
}

/// 组装 ChatML。no_think=true 时预填空的 `<think></think>` 块，
/// 这是 Qwen3 关闭思考的官方做法（对不带思考的模型也无害），保证直接出结果。
fn chatml(system: &str, user: &str, no_think: bool) -> String {
    let tail = if no_think {
        "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    } else {
        "<|im_start|>assistant\n"
    };
    format!("<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n{tail}")
}

/// 在缓存的模型上执行一次生成（持锁，天然串行，避免并发用同一模型）。
/// `on_token` 每吐出一段可显示文本就被调用一次；不需要流式的调用方传 `&mut |_| {}`。
fn run(
    model_path: &str,
    prompt: &str,
    max_tokens: usize,
    temp: f32,
    on_token: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let path = strip_unc(model_path.trim());
    if path.is_empty() {
        return Err("未指定模型路径".into());
    }
    let mut slot = model_slot().lock().map_err(|_| "模型锁中毒".to_string())?;
    match slot.iter().position(|l| l.path == path) {
        Some(i) => {
            let hit = slot.remove(i); // 命中即提到队首（LRU）
            slot.insert(0, hit);
        }
        None => {
            let params = LlamaModelParams::default().with_n_gpu_layers(0);
            let model = LlamaModel::load_from_file(backend(), &path, &params)
                .map_err(|e| format!("加载 GGUF 失败：{e}"))?;
            slot.insert(0, Loaded { path: path.clone(), model });
            slot.truncate(MODEL_SLOTS); // 超出上限的最久未用者在此释放
        }
    }
    generate(&slot[0].model, prompt, max_tokens, temp, on_token)
}

fn generate(
    model: &LlamaModel,
    prompt: &str,
    max_tokens: usize,
    temp: f32,
    on_token: &mut dyn FnMut(&str),
) -> Result<String, String> {
    // 先分词，再按这次实际需要的大小开上下文（分词只用到 model，不需要 ctx）。
    let tokens = model
        .str_to_token(prompt, AddBos::Never)
        .map_err(|e| format!("分词失败：{e}"))?;
    if tokens.is_empty() {
        return Ok(String::new());
    }
    let n_ctx = plan_ctx(tokens.len(), max_tokens, ctx_len())?;

    let threads = n_threads();
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_threads(threads)
        .with_n_threads_batch(threads);
    let mut ctx = model
        .new_context(backend(), ctx_params)
        .map_err(|e| format!("创建上下文失败：{e}"))?;

    // 分块喂入 prompt（每块 ≤512，兼容超长输入）
    let chunk = 512usize;
    let mut batch = LlamaBatch::new(chunk, 1);
    let last = tokens.len() - 1;
    let mut i = 0usize;
    while i < tokens.len() {
        let end = (i + chunk).min(tokens.len());
        batch.clear();
        for (j, tok) in tokens[i..end].iter().enumerate() {
            let pos = (i + j) as i32;
            batch
                .add(*tok, pos, &[0], (i + j) == last)
                .map_err(|e| format!("batch add 失败：{e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode 失败：{e}"))?;
        i = end;
    }

    let mut sampler = if temp <= 0.05 {
        LlamaSampler::greedy()
    } else {
        LlamaSampler::chain_simple([
            LlamaSampler::top_k(40),
            LlamaSampler::top_p(0.9, 1),
            LlamaSampler::temp(temp),
            LlamaSampler::dist(1234),
        ])
    };

    // 边生成边反分词，逐段交给 on_token。两处必须攒着不能直接发：
    // ① UTF-8 —— 一个汉字的字节常跨两个 token，半截发出去就是乱码，所以只发已成形的部分
    //    （token_to_bytes 会按需扩容，CJK 的 token 常 >8 字节，tokens_to_str 的固定小缓冲
    //    会撞 "Insufficient Buffer Space"）
    // ② <think> 标签 —— 见 ThinkFilter
    let mut pending: Vec<u8> = Vec::new();
    let mut filter = ThinkFilter::new();
    let mut out = String::new();
    let mut started = false; // 首个可见字符之前的空白不外发，否则弹窗会先闪一个空行
    // 生成的起始位置必须是整个 prompt 的长度，不是 batch 里剩下的那点。
    // prompt 是按 512 一块喂进去的，循环结束时 batch 里只剩最后一块 ——
    // 用 batch.n_tokens() 的话，700 token 的 prompt 会从 188 开始生成，
    // 新 token 被写到 prompt 已占用的位置上，因果掩码按 pos 比大小，
    // 模型生成时就只看得见开头那一小截，译文直接乱掉（超过 512 token 必现）。
    let mut n_cur = tokens.len() as i32;
    for _ in 0..max_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if model.is_eog_token(token) {
            break;
        }
        if let Ok(b) = model.token_to_bytes(token, Special::Plaintext) {
            pending.extend_from_slice(&b);
        }
        let ready = match std::str::from_utf8(&pending) {
            Ok(s) => {
                let s = s.to_string();
                pending.clear();
                s
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let s = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                s
            }
        };
        if !ready.is_empty() {
            let show = filter.push(&ready);
            if !show.is_empty() {
                out.push_str(&show);
                let piece = if started { show.as_str() } else { show.trim_start() };
                if !piece.is_empty() {
                    started = true;
                    on_token(piece);
                }
            }
        }
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| format!("batch add 失败：{e}"))?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| format!("decode 失败：{e}"))?;
    }

    let tail = filter.flush();
    if !tail.is_empty() {
        out.push_str(&tail);
        let piece = if started { tail.as_str() } else { tail.trim_start() };
        if !piece.is_empty() {
            on_token(piece);
        }
    }
    Ok(out.trim().to_string())
}

/// 本地 GGUF 翻译。ocr=true 时启用 OCR 纠错（识别文本可能有错字，先纠正再翻译）；
/// domain 非空时把用户的领域提示词（术语/风格要求）附加进 system。
pub fn translate(
    model_path: &str,
    text: &str,
    source_lang: &str,
    target_lang: &str,
    target_name: &str,
    ocr: bool,
    domain: &str,
    on_token: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let target = resolve_target(text, source_lang, target_lang, target_name);
    let mut system = format!(
        "You are a professional translator. Translate the user's text into {target}. \
         Output ONLY the translation itself — no explanations, no quotes, no notes."
    );
    if ocr {
        system.push_str(
            " The text was extracted via OCR and may contain minor recognition errors; \
             silently correct obvious errors from context before translating.",
        );
    }
    if !domain.trim().is_empty() {
        system.push_str(" Follow these additional requirements from the user (domain, terminology, style): ");
        system.push_str(domain.trim());
    }
    let prompt = chatml(&system, text, true); // 关闭思考，直接出译文
    run(model_path, &prompt, translate_budget(text), 0.1, on_token)
}

/// OCR 原文纠错：用上下文修正识别错字/拆字/漏字、去掉字间多余空格，输出同语言的纠正文本
/// （不翻译）。让"复制原文"也干净。
/// 小模型（1.7B 级）对纯指令会原样照抄，必须用 few-shot 示例对话演示"修复"这个动作。
pub fn correct_ocr(model_path: &str, text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let system = "你是 OCR 文本修复助手。用户发来屏幕截图的 OCR 识别结果，其中可能有：\
        被拆成偏旁的汉字、形近错字、字间多余空格、漏字。\
        结合上下文修复为通顺原文：只改错处，不改写、不翻译、不解释，保留换行，直接输出修复后的全文。";
    let ex_in = "并氵殳有变化，还是司间识别出的，最关键的是修这个伺题！亻尔看这个卉曲、这个川页序对不对。";
    let ex_out = "并没有变化，还是瞬间识别出的，最关键的是修这个问题！你看这个三步曲、这个顺序对不对。";
    // 实测备忘（qwen3-1.7b-q4）：思考模式 20s 且质量更差；无思考 + few-shot ~5s、
    // 仅小幅修复。1.7B 是纠错能力下限，好效果需 API 或 4B+ 模型。
    let no_think = "<think>\n\n</think>\n\n";
    let prompt = format!(
        "<|im_start|>system\n{system}<|im_end|>\n\
         <|im_start|>user\n{ex_in}<|im_end|>\n\
         <|im_start|>assistant\n{no_think}{ex_out}<|im_end|>\n\
         <|im_start|>user\n{text}<|im_end|>\n\
         <|im_start|>assistant\n{no_think}"
    );
    // 纠错是翻译前的一道预处理，用户看不到中间产物，不需要流式
    // 纠错是同语言改写，输出长度和输入基本一致，同样不该用固定上限
    run(model_path, &prompt, translate_budget(text), 0.1, &mut |_| {})
}

/// 本地 GGUF 对话（F4），可带划词/截图上下文
pub fn chat(
    model_path: &str,
    question: &str,
    ctx_title: &str,
    ctx_source: &str,
    ctx_translated: &str,
    on_token: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Ok(String::new());
    }
    let mut system = String::from(
        "You are a helpful assistant. Answer in Chinese unless the user explicitly requests another language.",
    );
    let mut ctx_lines: Vec<String> = Vec::new();
    if !ctx_title.trim().is_empty() {
        ctx_lines.push(format!("[Context] {}", ctx_title.trim()));
    }
    if !ctx_source.trim().is_empty() {
        ctx_lines.push(format!("[Source] {}", ctx_source.trim()));
    }
    if !ctx_translated.trim().is_empty() {
        ctx_lines.push(format!("[Translation] {}", ctx_translated.trim()));
    }
    if !ctx_lines.is_empty() {
        system.push_str("\n\n");
        system.push_str(&ctx_lines.join("\n"));
    }
    let prompt = chatml(&system, question, false); // 对话允许思考（ThinkFilter 会边流边剥）
    // 对话的输出长度和提问长度没有关系（"解释一下 XX" 五个字能问出一大段），
    // 所以这里不按输入估，给一个固定的、够写完一段完整回答的额度。
    // 之前 768 偏紧，回答经常被切在半句上；有了流式，等待的体感代价也小了。
    run(model_path, &prompt, 1536, 0.3, on_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把一串分片喂进去，返回一路吐出来的可见文本（模拟流式）
    fn stream(pieces: &[&str]) -> String {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        for p in pieces {
            out.push_str(&f.push(p));
        }
        out.push_str(&f.flush());
        out
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        assert_eq!(stream(&["你好", "，世界"]), "你好，世界");
    }

    #[test]
    fn think_block_is_removed() {
        assert_eq!(stream(&["<think>盘算一下</think>答案是 42"]), "答案是 42");
    }

    /// 关键用例：<think> 这七个字完全可能被切在两个 token 里，
    /// 拿到半截就判断会把标签漏出去给用户看见
    #[test]
    fn tag_split_across_chunks_is_still_caught() {
        assert_eq!(stream(&["<thi", "nk>秘密", "</thi", "nk>正文"]), "正文");
    }

    #[test]
    fn tag_split_one_char_at_a_time_is_still_caught() {
        let pieces: Vec<&str> = vec!["<", "t", "h", "i", "n", "k", ">", "秘密", "</think>", "正文"];
        assert_eq!(stream(&pieces), "正文");
    }

    /// 尖括号不是标签开头时不能被吞掉
    #[test]
    fn lone_angle_bracket_is_not_swallowed() {
        assert_eq!(stream(&["a < b", " and c"]), "a < b and c");
        assert_eq!(stream(&["<thinking>"]), "<thinking>");
    }

    /// 生成被 max_tokens 截断在思考中途：宁可什么都不显示，也不能把思考过程当译文吐出来
    #[test]
    fn unterminated_think_yields_nothing() {
        assert_eq!(stream(&["<think>想到一半就没了"]), "");
    }

    /// 划词那种短句用最小额度就够，不必按长文的规格生成
    #[test]
    fn short_text_gets_the_floor_budget() {
        assert_eq!(translate_budget("hello"), 256);
    }

    /// 关键用例：原文越长，允许生成的译文就得越长。
    /// 以前写死 640，四百来字以上的原文译文必被截断且不报错。
    #[test]
    fn budget_grows_with_the_source_text() {
        let one_page: String = "这是一段需要翻译的中文正文。".repeat(60); // 约 840 字
        let budget = translate_budget(&one_page);
        assert!(budget > 640, "长文预算 {budget} 应该超过旧的固定值 640");
        assert!(budget >= estimate_tokens(&one_page), "预算至少要够把原文译完");
    }

    /// 但不能无限涨：纯 CPU 每秒十几个 token，4096 已经要等好几分钟
    #[test]
    fn budget_is_capped_so_users_are_not_left_waiting_forever() {
        assert_eq!(translate_budget(&"字".repeat(100_000)), 4096);
    }

    /// 用户实际报的场景：整页正文要能一次译完，不能中途停住。
    /// 一页约 800~1200 token，这里连上下文一起验一遍，确保不会撞上限。
    #[test]
    fn a_full_page_translates_end_to_end() {
        let page: String = "这是正文里的一句话，用来凑出整页的长度。".repeat(60); // 约 1200 字
        let budget = translate_budget(&page);
        let src = estimate_tokens(&page);
        assert!(budget >= src, "预算 {budget} 必须够把 {src} token 的原文译完");
        assert!(plan_ctx(src + 120, budget, ctx_len()).is_ok(), "整页不该撞上下文上限");
    }

    /// 短句不该按天花板开上下文：KV cache 是满额预分配的，翻一个词也划走小半个 G
    #[test]
    fn short_prompt_gets_a_small_context() {
        assert_eq!(plan_ctx(40, 640, 8192).unwrap(), MIN_CTX);
    }

    #[test]
    fn long_prompt_grows_the_context_up_to_the_ceiling() {
        assert_eq!(plan_ctx(3000, 640, 8192).unwrap(), 4096);
        assert_eq!(plan_ctx(5000, 640, 8192).unwrap(), 8192);
    }

    /// 待生成的 max_tokens 必须算进预算，否则生成到一半 KV cache 满，
    /// 用户看到的是 "Decode Error 1: NoKvCacheSlot" 这种看不懂的话
    #[test]
    fn budget_accounts_for_tokens_still_to_be_generated() {
        // prompt 本身没超 4096，但加上要生成的 640 就超了 —— 必须提前拒绝
        assert!(plan_ctx(3800, 640, 4096).is_err());
        assert!(plan_ctx(3000, 640, 4096).is_ok());
    }
}
