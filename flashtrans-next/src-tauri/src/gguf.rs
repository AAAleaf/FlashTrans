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
use llama_cpp_2::token::LlamaToken;

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

/// 缓存当前已加载的模型（按路径），避免每次调用都重新载入
fn model_slot() -> &'static Mutex<Option<Loaded>> {
    static SLOT: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn strip_unc(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

fn ctx_len() -> u32 {
    std::env::var("FLASHTRANS_CTX")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|n| *n >= 1024)
        .unwrap_or(4096)
}

fn n_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| ((n.get() / 2).max(1)) as i32)
        .unwrap_or(4)
}

pub fn strip_think(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        match rest.find("<think>") {
            Some(start) => {
                out.push_str(&rest[..start]);
                match rest[start..].find("</think>") {
                    Some(end) => rest = &rest[start + end + "</think>".len()..],
                    None => {
                        rest = "";
                        break;
                    }
                }
            }
            None => break,
        }
    }
    out.push_str(rest);
    out.trim().to_string()
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

/// 在缓存的模型上执行一次生成（持锁，天然串行，避免并发用同一模型）
fn run(model_path: &str, prompt: &str, max_tokens: usize, temp: f32) -> Result<String, String> {
    let path = strip_unc(model_path.trim());
    if path.is_empty() {
        return Err("未指定模型路径".into());
    }
    let mut slot = model_slot().lock().map_err(|_| "模型锁中毒".to_string())?;
    let need_load = slot.as_ref().map(|l| l.path != path).unwrap_or(true);
    if need_load {
        let params = LlamaModelParams::default().with_n_gpu_layers(0);
        let model = LlamaModel::load_from_file(backend(), &path, &params)
            .map_err(|e| format!("加载 GGUF 失败：{e}"))?;
        *slot = Some(Loaded { path: path.clone(), model });
    }
    let model = &slot.as_ref().unwrap().model;
    generate(model, prompt, max_tokens, temp)
}

fn generate(model: &LlamaModel, prompt: &str, max_tokens: usize, temp: f32) -> Result<String, String> {
    let n_ctx = ctx_len();
    let threads = n_threads();
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_threads(threads)
        .with_n_threads_batch(threads);
    let mut ctx = model
        .new_context(backend(), ctx_params)
        .map_err(|e| format!("创建上下文失败：{e}"))?;

    let tokens = model
        .str_to_token(prompt, AddBos::Never)
        .map_err(|e| format!("分词失败：{e}"))?;
    if tokens.is_empty() {
        return Ok(String::new());
    }
    if tokens.len() as u32 >= n_ctx {
        return Err("输入过长，超过模型上下文长度（可用 FLASHTRANS_CTX 调大）".into());
    }

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

    let mut gen: Vec<LlamaToken> = Vec::new();
    let mut n_cur = batch.n_tokens();
    for _ in 0..max_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if model.is_eog_token(token) {
            break;
        }
        gen.push(token);
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| format!("batch add 失败：{e}"))?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| format!("decode 失败：{e}"))?;
    }

    // 逐 token 反分词：token_to_bytes 在 8 字节不够时按需扩容（CJK 的 token 常 >8 字节），
    // 避免 tokens_to_str 固定小缓冲导致的 “Insufficient Buffer Space”
    let mut bytes: Vec<u8> = Vec::with_capacity(gen.len() * 4);
    for tok in &gen {
        if let Ok(b) = model.token_to_bytes(*tok, Special::Plaintext) {
            bytes.extend_from_slice(&b);
        }
    }
    let out = String::from_utf8_lossy(&bytes).to_string();
    Ok(strip_think(&out))
}

/// 本地 GGUF 翻译。ocr=true 时启用 OCR 纠错（识别文本可能有错字，先纠正再翻译）
pub fn translate(
    model_path: &str,
    text: &str,
    source_lang: &str,
    target_lang: &str,
    target_name: &str,
    ocr: bool,
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
    let prompt = chatml(&system, text, true); // 关闭思考，直接出译文
    run(model_path, &prompt, 640, 0.1)
}

/// OCR 原文纠错：用上下文修正识别错字/拆字/漏字、去掉字间多余空格，输出同语言的纠正文本
/// （不翻译）。让"复制原文"也干净。
pub fn correct_ocr(model_path: &str, text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let system = "You are an OCR post-corrector. The user's text was extracted from a screenshot \
         and may contain recognition errors: wrong or split characters, missing characters, and \
         spurious spaces between characters. Fix obvious errors using context and remove the \
         spurious spaces. Keep the SAME language — do NOT translate. Preserve line breaks. \
         Output ONLY the corrected text, nothing else.";
    let prompt = chatml(system, text, true); // 关闭思考，直接出结果
    run(model_path, &prompt, 640, 0.1)
}

/// 本地 GGUF 对话（F4），可带划词/截图上下文
pub fn chat(
    model_path: &str,
    question: &str,
    ctx_title: &str,
    ctx_source: &str,
    ctx_translated: &str,
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
    let prompt = chatml(&system, question, false); // 对话允许思考（剥 think 后返回）
    run(model_path, &prompt, 768, 0.3)
}
