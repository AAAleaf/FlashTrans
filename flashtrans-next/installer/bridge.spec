# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec：把 backend_bridge.py（CT2 翻译 + RapidOCR）冻结成独立可执行程序，
# 随安装包分发后用户无需安装 Python 即可使用 NLLB / Opus-MT 模型与高质量截图 OCR。
# 构建：运行 flashtrans-next/scripts/build_bridge.ps1（输出到 installer/bridge-dist/）
from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs

# RapidOCR 需要打包 onnx 模型与配置文件
_r_datas, _r_bins, _r_hidden = collect_all("rapidocr_onnxruntime")

a = Analysis(
    ["../backend_bridge.py"],
    pathex=[],
    binaries=collect_dynamic_libs("ctranslate2") + collect_dynamic_libs("onnxruntime") + _r_bins,
    datas=_r_datas,
    hiddenimports=_r_hidden,
    excludes=["tkinter", "unittest", "pydoc", "doctest", "pip", "setuptools"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="flashtrans-bridge",
    debug=False,
    strip=False,
    upx=False,
    # stdio 协议需要控制台子系统；主程序以 CREATE_NO_WINDOW 启动它，不会闪黑窗
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="flashtrans-bridge",
)
