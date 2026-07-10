"""FlashTrans 本地桥接：CT2 翻译（NLLB / Opus-MT）+ RapidOCR 截图识别。

自包含：依赖 ctranslate2 + sentencepiece + rapidocr_onnxruntime + pillow
（见 requirements-bridge.txt），不引用 v1 的 core_engine.py。
GGUF 大模型由 Rust 原生实现，不经此桥接。
OCR：RapidOCR（中文特训的 PaddleOCR 模型）对中/英截图质量远超 Windows
原生 OCR（真实截图实测），Rust 端优先走这里、失败回退 Windows OCR。

协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（UTF-8）。
打包：scripts/build_bridge.ps1 用 PyInstaller 冻结成 flashtrans-bridge.exe，
随安装包分发后用户无需安装 Python。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

NLLB_LANG_MAP: dict[str, str] = {
    "auto": "",
    "zh": "zho_Hans",
    "zh-Hant": "zho_Hant",
    "en": "eng_Latn",
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "es": "spa_Latn",
    "it": "ita_Latn",
    "pt": "por_Latn",
    "ru": "rus_Cyrl",
    "ar": "arb_Arab",
    "hi": "hin_Deva",
    "vi": "vie_Latn",
    "th": "tha_Thai",
    "id": "ind_Latn",
    "ms": "zsm_Latn",
    "tr": "tur_Latn",
    "nl": "nld_Latn",
    "pl": "pol_Latn",
    "uk": "ukr_Cyrl",
    "sv": "swe_Latn",
    "el": "ell_Grek",
    "he": "heb_Hebr",
    "bn": "ben_Beng",
}

# FLORES-200 语言码规则：3 位小写 + 下划线 + 首字母大写的 4 位文字标签，如 zho_Hans / eng_Latn。
_FLORES_RE = re.compile(r"^[a-z]{3}_[A-Z][a-z]{3}$")


def to_nllb(code: str) -> str:
    """把前端语言码解析为 NLLB 的 FLORES 码。

    常用短码（zh/en/…）查表；前端为 FLORES-200 长尾语言直接下发 FLORES 码，
    按规则原样放行（NLLB-200 全量支持，无需逐条登记）；无法识别返回空串。
    """
    code = (code or "").strip()
    if code in NLLB_LANG_MAP:
        return NLLB_LANG_MAP[code]
    if _FLORES_RE.match(code):
        return code
    return ""


def detect_lang(text: str) -> str:
    text = text or ""
    if re.search(r"[一-鿿]", text):
        return "zh"
    if re.search(r"[぀-ヿ]", text):
        return "ja"
    if re.search(r"[가-힯]", text):
        return "ko"
    if re.search(r"[Ѐ-ӿ]", text):
        return "ru"
    if re.search(r"[؀-ۿ]", text):
        return "ar"
    if re.search(r"[฀-๿]", text):
        return "th"
    return "en"


def resolve_target(text: str, source: str, target: str) -> str:
    if target and target != "auto":
        return target
    src = source if source and source != "auto" else detect_lang(text)
    return "en" if src.startswith("zh") else "zh"


class Ct2Translator:
    """一个 CTranslate2 模型目录 + SentencePiece 分词器，带分块翻译。"""

    def __init__(self, model_dir: Path) -> None:
        import ctranslate2
        import sentencepiece as spm

        if not model_dir.is_dir():
            raise FileNotFoundError(f"模型目录不存在：{model_dir}")

        def pick(names: list[str]) -> Path | None:
            for name in names:
                p = model_dir / name
                if p.exists():
                    return p
            return None

        src_model = pick(["sentencepiece.model", "source.spm", "sentencepiece.bpe.model"])
        if src_model is None:
            raise FileNotFoundError(f"缺少 SentencePiece 文件（sentencepiece.model / source.spm）：{model_dir}")
        tgt_model = pick(["target.spm", "sentencepiece.model", "sentencepiece.bpe.model"]) or src_model

        self.sp_src = spm.SentencePieceProcessor(model_proto=src_model.read_bytes())
        self.sp_tgt = spm.SentencePieceProcessor(model_proto=tgt_model.read_bytes())
        self.translator = ctranslate2.Translator(
            str(model_dir),
            device="cpu",
            compute_type="int8",
            inter_threads=1,
            intra_threads=max(1, (os.cpu_count() or 4) // 2),
        )

    def translate(
        self,
        text: str,
        source_prefix: str = "",
        target_prefix: str = "",
    ) -> str:
        chunks = _chunk_text(text)
        token_lists: list[list[str]] = []
        token_to_chunk: list[int] = []
        out_by_chunk: list[str] = ["" for _ in chunks]

        for i, ch in enumerate(chunks):
            if ch == "\n":
                out_by_chunk[i] = "\n"
                continue
            ch = ch.strip()
            if not ch:
                continue
            tokens = self.sp_src.encode_as_pieces(ch)
            if source_prefix:
                tokens = [source_prefix, *tokens]
            if tokens and tokens[-1] != "</s>":
                tokens.append("</s>")
            if not tokens:
                continue
            token_to_chunk.append(i)
            token_lists.append(tokens)

        if token_lists:
            kwargs: dict[str, Any] = {
                "beam_size": 7,
                "repetition_penalty": 1.5,
                "no_repeat_ngram_size": 5,
                "max_decoding_length": 1024,
                "return_scores": False,
            }
            if target_prefix:
                kwargs["target_prefix"] = [[target_prefix]] * len(token_lists)
            results = self.translator.translate_batch(token_lists, **kwargs)
            drop_leading = {t for t in (source_prefix, target_prefix) if t}
            for res_idx, chunk_idx in enumerate(token_to_chunk):
                hyp: list[str] = []
                if results and res_idx < len(results) and results[res_idx].hypotheses:
                    hyp = list(results[res_idx].hypotheses[0])
                while hyp and hyp[0] in drop_leading:
                    hyp = hyp[1:]
                # NLLB 偶尔会在句中回吐语言标记（形如 __xxx__ 或 FLORES 码），一并清掉
                hyp = [t for t in hyp if not (t.startswith("__") and t.endswith("__"))]
                if not hyp:
                    continue
                out = self.sp_tgt.decode_pieces([t for t in hyp if t not in ("</s>", "<pad>")]).strip()
                out_by_chunk[chunk_idx] = _postprocess(out)

        return _merge_chunks(out_by_chunk)


def _chunk_text(text: str) -> list[str]:
    """按段落/句子切块（中文长句再按逗号切），小模型对短句质量更好。"""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    parts: list[str] = []
    for block in re.split(r"(\n+)", text):
        if not block:
            continue
        if block.startswith("\n"):
            parts.extend(["\n"] * len(block))
            continue
        for seg in re.split(r"(?<=[。！？!?；;\.…])", block):
            seg = seg.strip()
            if not seg:
                continue
            has_zh = bool(re.search(r"[一-鿿]", seg))
            comma_count = seg.count("，") + seg.count(",")
            if has_zh and (len(seg) > 80 or (comma_count >= 2 and len(seg) > 40)):
                parts.extend([s for s in re.split(r"(?<=[，,])", seg) if s.strip()])
            elif (not has_zh) and (len(seg) > 180):
                parts.extend([s for s in re.split(r"(?<=[,])", seg) if s.strip()])
            else:
                parts.append(seg)
    return parts or [text]


def _postprocess(text: str) -> str:
    """清理 SentencePiece 残留与中英标点混用。"""
    text = (text or "").replace(" ", " ").replace("▁", " ").replace("⁇", "")
    text = re.sub(r"[ \t]{2,}", " ", text)
    if re.search(r"[一-鿿]", text):
        text = text.replace(",", "，").replace("?", "？").replace("!", "！").replace(";", "；").replace(":", "：")
        text = re.sub(r"(?<!\.)\.(?!\.)", "。", text)
        text = re.sub(r"(?<=[一-鿿])\s+(?=[一-鿿])", "", text)
        text = re.sub(r"\s+([，。！？；：、])", r"\1", text)
        text = re.sub(r"([，。！？；：、])\s+", r"\1", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text.strip()


def _merge_chunks(parts_in: list[str]) -> str:
    merged_parts: list[str] = []
    for part in parts_in:
        if not part:
            continue
        if part == "\n":
            merged_parts.append("\n")
            continue
        if merged_parts and merged_parts[-1] not in ("\n", " "):
            prev_tail = merged_parts[-1][-1]
            cur_head = part[0]
            both_zh = bool(re.match(r"[一-鿿]", prev_tail)) and bool(re.match(r"[一-鿿]", cur_head))
            if prev_tail not in "，。！？；：、,.!?;:" and not both_zh:
                merged_parts.append(" ")
        merged_parts.append(part)
    merged = "".join(merged_parts)
    merged = re.sub(r"[ \t]{2,}", " ", merged)
    merged = re.sub(r"[ ]+\n", "\n", merged)
    merged = re.sub(r"\n[ ]+", "\n", merged)
    return merged.strip()


class Bridge:
    def __init__(self, backend: str, model: str) -> None:
        self.backend = (backend or "nllb").strip().lower()
        raw = (model or "").strip()
        # 防御：剥掉 Windows 扩展路径前缀（CTranslate2 无法打开 \\?\ 形式的路径）
        if raw.startswith("\\\\?\\"):
            raw = raw[4:]
        elif raw.startswith("//?/"):
            raw = raw[4:]
        self.model = Path(raw).expanduser().resolve() if raw else Path()
        self._nllb: Ct2Translator | None = None
        self._opus_en2zh: Ct2Translator | None = None
        self._opus_zh2en: Ct2Translator | None = None
        self._ocr = None

    def ensure_ocr(self):
        if self._ocr is None:
            from rapidocr_onnxruntime import RapidOCR

            self._ocr = RapidOCR()
        return self._ocr

    def ocr_image(self, payload: dict[str, Any]) -> dict[str, Any]:
        """识别一张 base64 PNG（F3 框选裁剪结果），逐行返回文本。"""
        import base64
        import io

        import numpy as np
        from PIL import Image

        b64 = str(payload.get("imageB64") or "").split(",")[-1].strip()
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
        # 小图放大有助识别；大图放大只会拖慢（det 内部会再缩放），不放
        if max(img.size) < 600:
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        arr = np.array(img)[:, :, ::-1]
        result, _ = self.ensure_ocr()(arr)
        lines = [
            str(item[1]).strip()
            for item in (result or [])
            if isinstance(item, (list, tuple)) and len(item) >= 2 and str(item[1]).strip()
        ]
        return {"source": "\n".join(lines)}

    def ensure_nllb(self) -> Ct2Translator:
        if self._nllb is None:
            self._nllb = Ct2Translator(self.model)
        return self._nllb

    def ensure_opus(self, target: str) -> Ct2Translator:
        """Opus-MT 单方向模型：model 指向一对目录中的任意一个，自动找到另一方向。"""
        name = self.model.name
        if "en-zh" in name:
            en2zh_dir, zh2en_dir = self.model, self.model.parent / name.replace("en-zh", "zh-en")
        elif "zh-en" in name:
            en2zh_dir, zh2en_dir = self.model.parent / name.replace("zh-en", "en-zh"), self.model
        else:
            en2zh_dir = zh2en_dir = self.model
        if target == "zh":
            if self._opus_en2zh is None:
                self._opus_en2zh = Ct2Translator(en2zh_dir)
            return self._opus_en2zh
        if self._opus_zh2en is None:
            self._opus_zh2en = Ct2Translator(zh2en_dir)
        return self._opus_zh2en

    def translate(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text") or "").strip()
        source = str(payload.get("sourceLang") or "auto").strip()
        target = resolve_target(text, source, str(payload.get("targetLang") or "auto").strip())
        if not text:
            return {"text": ""}

        if self.backend == "opus":
            if target not in ("zh", "en"):
                raise RuntimeError("Opus-MT 模型仅支持中英互译，请切换目标语言或换用 NLLB / GGUF 模型")
            out = self.ensure_opus(target).translate(text)
            if not out:
                raise RuntimeError("Opus-MT 翻译失败")
            return {"text": out, "targetLang": target}

        # 默认 NLLB
        src = source if source != "auto" else detect_lang(text)
        src_code = to_nllb(src) or NLLB_LANG_MAP["en"]
        tgt_code = to_nllb(target) or NLLB_LANG_MAP["zh"]
        if src_code == tgt_code:
            return {"text": text, "targetLang": target}
        out = self.ensure_nllb().translate(text, source_prefix=src_code, target_prefix=tgt_code)
        return {"text": out, "targetLang": target}


def ok(value: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, **value}


def fail(exc: BaseException) -> dict[str, Any]:
    return {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=4)}


def handle(bridge: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    op = str(payload.get("op") or "").strip()
    if op == "translate":
        return ok(bridge.translate(payload))
    if op == "ocr_image":
        return ok(bridge.ocr_image(payload))
    if op == "ping":
        return ok({"backend": bridge.backend, "model": str(bridge.model)})
    raise RuntimeError(f"Unknown bridge operation: {op}")


def serve(args: argparse.Namespace) -> int:
    # 中文 Windows 管道默认 GBK，必须强制 UTF-8，否则中文进出全部乱码
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    bridge = Bridge(args.backend, args.model)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            result = handle(bridge, payload)
        except Exception as e:
            result = fail(e)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve"])
    parser.add_argument("--backend", default="nllb")
    parser.add_argument("--model", default="")
    args = parser.parse_args()
    return serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
