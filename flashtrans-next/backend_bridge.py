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

            # 模型对某一块吐了空（小模型碰到长从句偶尔会这样）就保留原文。
            # 宁可让用户看到一句没译的英文，也不能让整句凭空消失 —— 后者根本发现不了。
            for chunk_idx in token_to_chunk:
                if not out_by_chunk[chunk_idx].strip():
                    out_by_chunk[chunk_idx] = chunks[chunk_idx].strip()

        return _merge_chunks(out_by_chunk)


def _looks_like_missing_rows(lines: list[dict[str, Any]]) -> bool:
    """行距里出现约两倍的跳变 = 中间整整少了一行，值得切条重认一次。

    实测同一张图：正文行距 26，换段 39~42（1.5 倍），漏掉一行则是 51~53（2 倍），
    所以 1.75 倍这条线能把「换段」和「漏行」分开。判错了只是多花一次 OCR 的时间，
    不会认错内容，宁可宽一点。
    """
    ys = sorted(l["y"] for l in lines if l.get("h", 0) > 0)
    if len(ys) < 6:  # 行太少统计不出常规行距，也基本不是密集长文
        return False
    gaps = [b - a for a, b in zip(ys, ys[1:]) if b - a > 0]
    if len(gaps) < 3:
        return False
    med = sorted(gaps)[len(gaps) // 2]
    return med > 0 and any(g > med * 1.75 for g in gaps)


def _dedup_lines(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """切条识别的重叠区会把同一行认两次，按框位置去重，同位置留文字更全的那条。"""
    rows.sort(key=lambda d: (d["y"], d["x"]))
    out: list[dict[str, Any]] = []
    for it in rows:
        hit = None
        for o in out:
            vy = min(it["y"] + it["h"], o["y"] + o["h"]) - max(it["y"], o["y"])
            vx = min(it["x"] + it["w"], o["x"] + o["w"]) - max(it["x"], o["x"])
            if vy > min(it["h"], o["h"]) * 0.5 and vx > min(it["w"], o["w"]) * 0.5:
                hit = o
                break
        if hit is None:
            out.append(it)
        elif len(it["text"]) > len(hit["text"]):
            hit.update(it)
    return out


def _chunk_text(text: str) -> list[str]:
    """按段落/句子切块（长句再按逗号切），小模型对短句质量更好。

    切块粒度直接决定内容会不会丢：NLLB 这类小模型碰到破折号、或者三四个逗号并列的
    长从句时，会译着译着就把后半截整段吞掉（不是截断报错，是安静地少一半）。
    实测四段英文原文，破折号后的内容 100% 丢失；把破折号也当作切点、并让英文的
    逗号再切阈值向中文看齐之后，四段全部完整译出。译文会稍微直白一点，
    但比丢句子强得多。
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    parts: list[str] = []
    for block in re.split(r"(\n+)", text):
        if not block:
            continue
        if block.startswith("\n"):
            parts.extend(["\n"] * len(block))
            continue
        for seg in re.split(r"(?<=[。！？!?；;\.…—–])", block):
            seg = seg.strip()
            if not seg:
                continue
            has_zh = bool(re.search(r"[一-鿿]", seg))
            comma_count = seg.count("，") + seg.count(",")
            if has_zh and (len(seg) > 80 or (comma_count >= 2 and len(seg) > 40)):
                parts.extend([s for s in re.split(r"(?<=[，,])", seg) if s.strip()])
            elif (not has_zh) and len(seg) > 110:
                parts.extend([s for s in re.split(r"(?<=[，,])", seg) if s.strip()])
            else:
                parts.append(seg)
    return _merge_tiny(parts) or [text]


def _merge_tiny(parts: list[str]) -> list[str]:
    """把过短的碎块并回相邻块再送去翻译。

    破折号切点常在两头留下 "not"、"early morning—" 这种残片，单独喂给模型会译成
    孤零零的 "没有"、"早晨-" 卡在译文里。并回去既不影响完整性，也不会有碎片。
    """
    def short(s: str) -> bool:
        s = s.strip()
        return bool(s) and len(s) < (6 if re.search(r"[一-鿿]", s) else 15)

    def glue(a: str, b: str) -> str:
        a, b = a.rstrip(), b.strip()
        sep = "" if re.search(r"[一-鿿]$", a) or a.endswith(("—", "–")) else " "
        return f"{a}{sep}{b}"

    out: list[str] = []
    for p in parts:
        if p == "\n" or not p.strip():
            out.append(p)
        elif short(p) and out and out[-1] != "\n":
            out[-1] = glue(out[-1], p)  # 并进上一块
        else:
            out.append(p)
    # 上面只能往回并，段首的残片还得往后并一次
    for i, p in enumerate(out):
        if p != "\n" and short(p) and i + 1 < len(out) and out[i + 1] != "\n":
            out[i + 1] = glue(p, out[i + 1])
            out[i] = ""
    return [p for p in out if p]


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
        self._ocr: dict[tuple[str, str, str, str], Any] = {}

    @staticmethod
    def _auto_rec_opts(rec: str, keys: str, height: int) -> tuple[int, str]:
        """自动推断 rec 模型的输入高度和字典文件，省得用户手工填一堆参数。

        - 高度：直接读 ONNX 输入形状的第 3 维（PP-OCRv3/4/5=48，v1/v2.0=32）。
          填错要么维度报错要么识别成空，是这里最容易踩的坑，所以宁可自己读。
        - 字典：模型自带（metadata 里有 character）就不用外挂；否则在同目录找 .txt。
        """
        import onnxruntime as ort

        sess = ort.InferenceSession(rec, providers=["CPUExecutionProvider"])
        if not height:
            shape = sess.get_inputs()[0].shape
            if len(shape) >= 3 and isinstance(shape[2], int) and shape[2] > 0:
                height = shape[2]

        has_builtin_dict = "character" in sess.get_modelmeta().custom_metadata_map
        if not keys and not has_builtin_dict:
            folder = Path(rec).parent
            txts = sorted(folder.glob("*.txt"))
            preferred = [p for p in txts if any(k in p.name.lower() for k in ("dict", "key", "char"))]
            picked = (preferred or txts)[:1]
            if not picked:
                raise RuntimeError(
                    f"这个识别模型没有内嵌字典，需要配套的字典文件（一个 .txt，每行一个字符）。"
                    f"把它和模型放在同一个文件夹（{folder}）即可自动识别，"
                    f"或在设置里手动指定「字典」。"
                )
            keys = str(picked[0])
        return height, keys

    def ensure_ocr(
        self, det: str = "", rec: str = "", keys: str = "", cls: str = "", height: int = 0
    ):
        """按模型路径缓存 RapidOCR 实例。

        全空 = 内置中英模型（默认）。传路径则用自定义的 PP-OCR 格式 ONNX
        （韩语/俄语/日语等系统没装语言包的语种靠这个），一个语种一份实例常驻。
        height 是 rec 模型要求的输入高度：PP-OCRv3/v4/v5 多为 48，
        PP-OCRv1/v2.0 时代的老模型是 32，填错会直接报维度错或识别成空。
        """
        if rec:
            height, keys = self._auto_rec_opts(rec, keys, height)
        key = (det, rec, keys, cls, str(height))
        inst = self._ocr.get(key)
        if inst is None:
            from rapidocr_onnxruntime import RapidOCR

            kwargs: dict[str, Any] = {}
            if det:
                kwargs["det_model_path"] = det
            if rec:
                kwargs["rec_model_path"] = rec
            if keys:
                # rec 模型没把字典写进 ONNX metadata 时必须外挂 keys 文件
                kwargs["rec_keys_path"] = keys
            if cls:
                kwargs["cls_model_path"] = cls
            if height:
                kwargs["rec_img_shape"] = [3, int(height), 320]
            inst = RapidOCR(**kwargs)
            self._ocr[key] = inst
        return inst

    def ocr_image(self, payload: dict[str, Any]) -> dict[str, Any]:
        """识别一张 base64 PNG（F3 框选裁剪结果），返回逐行文本 + 行框（原图像素坐标）。

        行框供「原位覆盖」把译文贴回文字原来的位置，因此坐标必须换算回未放大的原图。
        """
        import base64
        import io

        import numpy as np
        from PIL import Image

        b64 = str(payload.get("imageB64") or "").split(",")[-1].strip()
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
        # 小图放大有助识别；大图放大只会拖慢（det 内部会再缩放），不放
        scale = 1.0
        if max(img.size) < 600:
            scale = 2.0
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        cls_path = str(payload.get("clsPath") or "").strip()
        rec_path = str(payload.get("recPath") or "").strip()
        det_path = str(payload.get("detPath") or "").strip()
        try:
            height = int(payload.get("recHeight") or 0)
        except (TypeError, ValueError):
            height = 0
        engine = self.ensure_ocr(
            det_path,
            rec_path,
            str(payload.get("keysPath") or "").strip(),
            cls_path,
            height,
        )
        # 方向分类器是按中文训练的，套在韩语等语种上会把整行判成倒置再翻转 180°，
        # 识别结果直接归零（实测）。截图本来就不会倒着放，自定义模型默认关掉它，
        # 除非用户自己配了对应语种的 cls 模型。
        custom = bool(rec_path or det_path)
        kwargs: dict[str, Any] = {}
        if custom and not cls_path:
            kwargs["use_cls"] = False
        lines = self._ocr_pass(engine, img, kwargs, scale)
        # 疑似漏行才切条重跑：常见的字幕 / 短句 / 气泡一秒都不多花。
        # 取并集而不是替换 —— 实测两次识别漏的不是同几行（整图漏 y=231/519，
        # 切条漏 y=112/283），单用哪一边都还是 16 行，并起来才凑齐。
        if _looks_like_missing_rows(lines):
            merged = _dedup_lines(lines + self._ocr_tiled(engine, img, kwargs, scale))
            if len(merged) > len(lines):
                lines = merged
        return {"source": "\n".join(l["text"] for l in lines), "lines": lines}

    @staticmethod
    def _rows_from_result(result: Any, scale: float, offset_y: float = 0.0) -> list[dict[str, Any]]:
        """RapidOCR 原始结果 → 逐行文本 + 行框，坐标换算回未放大、未切条的原图。"""
        lines: list[dict[str, Any]] = []
        for item in result or []:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            text = str(item[1]).strip()
            if not text:
                continue
            entry: dict[str, Any] = {"text": text, "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
            try:
                pts = [(float(p[0]) / scale, (float(p[1]) + offset_y) / scale) for p in item[0]]
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                entry.update(
                    x=min(xs), y=min(ys), w=max(xs) - min(xs), h=max(ys) - min(ys)
                )
            except (TypeError, ValueError, IndexError):
                pass  # 拿不到框就只给文本，覆盖模式会自动退回整块显示
            lines.append(entry)
        return lines

    def _ocr_pass(
        self, engine: Any, img: Any, kwargs: dict[str, Any], scale: float
    ) -> list[dict[str, Any]]:
        import numpy as np

        result, _ = engine(np.array(img)[:, :, ::-1], **kwargs)
        return self._rows_from_result(result, scale)

    def _ocr_tiled(
        self, engine: Any, img: Any, kwargs: dict[str, Any], scale: float
    ) -> list[dict[str, Any]]:
        """把图横向切成几条重叠的带子分别识别。

        检测器内部固定把整图缩到 limit_side_len=736，密集长文里正文只剩十几像素高，
        于是整行整行地漏 —— 实测一张 19 行的图只回 16 行。每漏一行还会连带把行距
        撑成两倍，让分段逻辑从段落中间劈开，所以一处漏行在用户眼里是「少了一句
        又多了一个段落」两个毛病。切条之后每条里的字相对更大，行就找得回来
        （实测切 3 条 19 行全中）。重叠区按框位置去重。
        预放大救不了：det 内部反正要缩回去，实测放大后反而更差（2x 只剩 12 行）。
        """
        import numpy as np

        h = img.height
        # 每条约 320px 高。实测同一张图切 2 条和切 3 条并集结果一样（都 18 行、
        # 行距一样规整），所以取更省时间的那档。
        n = max(2, min(6, -(-h // 320)))
        step = h / n
        overlap = max(40, int(step * 0.25))
        rows: list[dict[str, Any]] = []
        for i in range(n):
            top = max(0, int(i * step) - overlap)
            bot = min(h, int((i + 1) * step) + overlap)
            if bot - top < 20:
                continue
            strip = np.array(img.crop((0, top, img.width, bot)))[:, :, ::-1]
            result, _ = engine(strip, **kwargs)
            rows += self._rows_from_result(result, scale, offset_y=float(top))
        return _dedup_lines(rows)

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
