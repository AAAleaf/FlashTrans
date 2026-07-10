from __future__ import annotations

from typing import Callable

from PySide6.QtCore import Qt, QPoint, Signal, QObject, QEvent
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from settings_store import ApiProfile, SettingsStore


MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008

# ──────────────────────────────────────────────
# Theme definitions
# ──────────────────────────────────────────────

THEME_NAMES = {
    "dark":      "深色",
    "light":     "浅色",
    "eye_care":  "护眼",
    "gray":      "石墨",
    "gray_blue": "午夜",
    "nature":    "靛蓝",
    "rose":      "粉色",
    "ocean":     "深海",
    "purple":    "紫色",
    "amber":     "橙色",
    "mint":      "薄荷",
    "slate":     "青蓝",
}

THEME_NAMES_EN = {
    "dark":      "Dark",
    "light":     "Light",
    "eye_care":  "Eye Care",
    "gray":      "Graphite",
    "gray_blue": "Midnight",
    "nature":    "Indigo",
    "rose":      "Pink",
    "ocean":     "Ocean",
    "purple":    "Purple",
    "amber":     "Orange",
    "mint":      "Mint",
    "slate":     "Teal",
}


def _ios_light(
    accent: str, accent_light: str, accent_dark: str, *,
    bg: str = "#F2F2F7", surface: str = "#FFFFFF", border: str = "#E3E3E8",
    btn_bg: str = "#E9E9EB", btn_hover: str = "#DFDFE4", btn_press: str = "#D2D2D8",
) -> dict[str, str]:
    return {
        "bg": bg, "surface": surface, "titlebar": bg, "border": border,
        "text": "#1C1C1E", "text_dim": "#8A8A8E",
        "accent": accent, "accent_light": accent_light, "accent_dark": accent_dark,
        "btn_bg": btn_bg, "btn_hover": btn_hover, "btn_press": btn_press,
        "close_hover": "#FF3B30", "sel_bg": accent,
    }


def _ios_dark(
    accent: str, accent_light: str, accent_dark: str, *,
    bg: str = "#1C1C1E", surface: str = "#2C2C2E", border: str = "#3A3A3C",
    btn_bg: str = "#3A3A3C", btn_hover: str = "#48484A", btn_press: str = "#303032",
) -> dict[str, str]:
    return {
        "bg": bg, "surface": surface, "titlebar": bg, "border": border,
        "text": "#F2F2F7", "text_dim": "#98989F",
        "accent": accent, "accent_light": accent_light, "accent_dark": accent_dark,
        "btn_bg": btn_bg, "btn_hover": btn_hover, "btn_press": btn_press,
        "close_hover": "#FF453A", "sel_bg": accent_dark,
    }


# Apple 系统色（iOS system colors），浅色主题用标准饱和度，深色主题用提亮版本
_THEME_VARS: dict[str, dict[str, str]] = {
    "light":     _ios_light("#007AFF", "#2E93FF", "#0066D6"),
    "dark":      _ios_dark("#0A84FF", "#3D9BFF", "#0870DB"),
    "eye_care":  _ios_light("#34A853", "#4BBE68", "#2B8F46",
                            bg="#ECF2E4", surface="#F8FBF2", border="#DCE5CE",
                            btn_bg="#E2EAD6", btn_hover="#D8E2C9", btn_press="#CBD8B9"),
    "gray":      _ios_dark("#98989F", "#AEAEB5", "#7C7C83", bg="#1A1A1C", surface="#28282A"),
    "gray_blue": _ios_dark("#5E8DE6", "#7AA2F0", "#4A77D0",
                           bg="#12151F", surface="#1C2130", border="#2B3245",
                           btn_bg="#252C3E", btn_hover="#303952", btn_press="#1E2434"),
    "nature":    _ios_light("#5856D6", "#6E6CE0", "#4644BE"),
    "rose":      _ios_light("#FF2D55", "#FF5476", "#E01843", bg="#F7F2F3"),
    "ocean":     _ios_dark("#64D2FF", "#85DCFF", "#3FB8EC",
                           bg="#0B1220", surface="#152036", border="#233252",
                           btn_bg="#1D2A44", btn_hover="#273656", btn_press="#182338"),
    "purple":    _ios_dark("#BF5AF2", "#CE7EF6", "#A63FE0",
                           bg="#1A1523", surface="#282033", border="#3A3048",
                           btn_bg="#352B44", btn_hover="#413552", btn_press="#2B2338"),
    "amber":     _ios_light("#FF9500", "#FFAB33", "#E08300"),
    "mint":      _ios_light("#00A79E", "#0FBFB5", "#00908A", bg="#EFF6F4", surface="#FCFFFE"),
    "slate":     _ios_dark("#40C8E0", "#65D5E8", "#2BAEC6",
                           bg="#111826", surface="#1B2536", border="#2B3852",
                           btn_bg="#243149", btn_hover="#2E3D5A", btn_press="#1D283C"),
}

# Language list: (code, label_key)
_LANG_LIST = [
    ("auto",    "lang_auto"),
    ("zh",      "lang_zh"),
    ("zh_hant", "lang_zh_hant"),
    ("en",      "lang_en"),
    ("ja",      "lang_ja"),
    ("ko",      "lang_ko"),
    ("fr",      "lang_fr"),
    ("de",      "lang_de"),
    ("es",      "lang_es"),
    ("it",      "lang_it"),
    ("pt",      "lang_pt"),
    ("ru",      "lang_ru"),
    ("ar",      "lang_ar"),
    ("hi",      "lang_hi"),
    ("vi",      "lang_vi"),
    ("th",      "lang_th"),
    ("id",      "lang_id"),
    ("ms",      "lang_ms"),
    ("tr",      "lang_tr"),
    ("nl",      "lang_nl"),
    ("pl",      "lang_pl"),
    ("uk",      "lang_uk"),
    ("sv",      "lang_sv"),
    ("el",      "lang_el"),
    ("he",      "lang_he"),
    ("bn",      "lang_bn"),
]


def _build_qss(theme: str, font_size: int = 12) -> str:
    v = _THEME_VARS.get(theme, _THEME_VARS["dark"])
    fs = max(10, min(24, int(font_size or 12)))
    return f"""
* {{
    outline: none;
}}
QWidget {{
    background: transparent;
    color: {v['text']};
    font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
    font-size: {fs}px;
    border: none;
}}
#RootCard {{
    background: {v['bg']};
    border: 1px solid {v['border']};
    border-radius: 14px;
}}
#TitleBar {{
    background: transparent;
}}
#ToolBar {{
    background: transparent;
}}
QSplitter::handle {{
    background: transparent;
}}
QPushButton {{
    background: {v['btn_bg']};
    border: none;
    border-radius: 10px;
    padding: 6px 14px;
    color: {v['text']};
    font-weight: 500;
}}
QPushButton:hover {{
    background: {v['btn_hover']};
}}
QPushButton:pressed {{
    background: {v['btn_press']};
}}
QPushButton:disabled {{
    color: {v['text_dim']};
}}
QPushButton#TranslateBtn {{
    background: {v['accent']};
    border-radius: 17px;
    padding: 7px 24px;
    color: #ffffff;
    font-weight: 600;
    font-size: {fs + 1}px;
    min-width: 64px;
}}
QPushButton#TranslateBtn:hover {{
    background: {v['accent_light']};
    color: #ffffff;
}}
QPushButton#TranslateBtn:pressed {{
    background: {v['accent_dark']};
    color: #ffffff;
}}
QPushButton#IconButton {{
    padding: 0px;
    min-width: 34px;
    max-width: 34px;
    min-height: 30px;
    max-height: 30px;
    border-radius: 10px;
    font-size: {fs + 3}px;
}}
QPushButton#WindowButton, QPushButton#CloseButton {{
    background: transparent;
    min-width: 30px;
    max-width: 30px;
    min-height: 30px;
    max-height: 30px;
    border-radius: 15px;
    padding: 0px;
    font-size: 15px;
    color: {v['text_dim']};
}}
QPushButton#WindowButton:hover {{
    background: {v['btn_hover']};
    color: {v['text']};
}}
QPushButton#CloseButton:hover {{
    background: {v['close_hover']};
    color: #ffffff;
}}
QTextEdit, QPlainTextEdit {{
    background: {v['surface']};
    border: 1.5px solid transparent;
    border-radius: 14px;
    padding: 12px 14px;
    color: {v['text']};
    selection-background-color: {v['sel_bg']};
    selection-color: #ffffff;
}}
QTextEdit:focus, QPlainTextEdit:focus {{
    border-color: {v['accent']};
}}
QComboBox {{
    background: {v['btn_bg']};
    border: none;
    border-radius: 10px;
    padding: 5px 8px 5px 12px;
    color: {v['text']};
    font-weight: 500;
    min-width: 72px;
    max-width: 130px;
}}
QComboBox:hover {{
    background: {v['btn_hover']};
}}
QComboBox::drop-down {{
    border: none;
    width: 18px;
    padding-right: 4px;
}}
QComboBox QAbstractItemView {{
    background: {v['surface']};
    border: 1px solid {v['border']};
    border-radius: 10px;
    color: {v['text']};
    selection-background-color: {v['accent']};
    selection-color: #ffffff;
    padding: 6px;
    outline: none;
}}
QComboBox QAbstractItemView::item {{
    min-height: 26px;
    padding-left: 10px;
    border-radius: 6px;
}}
QLineEdit {{
    background: {v['surface']};
    border: 1.5px solid transparent;
    border-radius: 10px;
    padding: 7px 12px;
    color: {v['text']};
    selection-background-color: {v['sel_bg']};
    selection-color: #ffffff;
}}
QLineEdit:focus {{
    border-color: {v['accent']};
}}
QSpinBox {{
    background: {v['surface']};
    border: 1.5px solid transparent;
    border-radius: 10px;
    padding: 5px 10px;
    color: {v['text']};
}}
QSpinBox:focus {{
    border-color: {v['accent']};
}}
QGroupBox QLineEdit, QGroupBox QSpinBox {{
    background: {v['bg']};
}}
QGroupBox {{
    background: {v['surface']};
    border: none;
    border-radius: 14px;
    margin-top: 26px;
    padding: 12px 10px 8px 10px;
    font-weight: 600;
    color: {v['text']};
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 8px;
    top: 4px;
    padding: 0 4px;
    color: {v['text_dim']};
    background: transparent;
    font-size: {max(9, fs - 1)}px;
    font-weight: 600;
    letter-spacing: 1px;
}}
QCheckBox {{
    color: {v['text']};
    spacing: 8px;
    background: transparent;
}}
QCheckBox::indicator {{
    width: 18px;
    height: 18px;
    border: 1.5px solid {v['border']};
    border-radius: 6px;
    background: {v['surface']};
}}
QCheckBox::indicator:hover {{
    border-color: {v['accent']};
}}
QCheckBox::indicator:checked {{
    background: {v['accent']};
    border-color: {v['accent']};
}}
QLabel {{
    background: transparent;
    color: {v['text']};
    border: none;
}}
QLabel#AppTitle {{
    font-size: {fs + 1}px;
    font-weight: 600;
    color: {v['text']};
    letter-spacing: 0.3px;
}}
QLabel#BackendBadge {{
    background: {v['btn_bg']};
    color: {v['text_dim']};
    border-radius: 10px;
    padding: 3px 10px;
    font-size: {max(9, fs - 2)}px;
    font-weight: 600;
}}
QLabel#SepArrow {{
    color: {v['text_dim']};
    font-size: {fs + 1}px;
    padding: 0 2px;
}}
QScrollBar:vertical {{
    background: transparent;
    width: 6px;
    margin: 4px 1px;
}}
QScrollBar::handle:vertical {{
    background: {v['btn_hover']};
    border-radius: 3px;
    min-height: 30px;
}}
QScrollBar::handle:vertical:hover {{
    background: {v['text_dim']};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0px;
}}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
    background: transparent;
}}
QScrollBar:horizontal {{
    background: transparent;
    height: 6px;
    margin: 1px 4px;
}}
QScrollBar::handle:horizontal {{
    background: {v['btn_hover']};
    border-radius: 3px;
    min-width: 30px;
}}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0px;
}}
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{
    background: transparent;
}}
QDialog {{
    background: {v['bg']};
}}
QMessageBox {{
    background: {v['surface']};
}}
QToolTip {{
    background: {v['surface']};
    color: {v['text']};
    border: 1px solid {v['border']};
    border-radius: 6px;
    padding: 4px 8px;
}}
"""


def _build_popup_qss(theme: str, font_size: int = 12) -> str:
    v = _THEME_VARS.get(theme, _THEME_VARS["dark"])
    fs = max(10, min(24, int(font_size or 12)))
    return f"""
QWidget {{
    background: transparent;
    color: {v['text']};
    font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
    font-size: {fs}px;
    border: none;
    outline: none;
}}
QWidget#PopupCard {{
    background: {v['surface']};
    border: 1px solid {v['border']};
    border-radius: 16px;
}}
QLabel {{
    padding: 2px 6px;
    color: {v['text']};
    background: transparent;
}}
QLabel#PopupTitle {{
    font-size: {max(9, fs - 1)}px;
    font-weight: 600;
    letter-spacing: 1px;
    padding: 2px 8px;
    color: {v['text_dim']};
}}
QPlainTextEdit {{
    background: {v['bg']};
    border: 1.5px solid transparent;
    border-radius: 12px;
    padding: 8px 10px;
    color: {v['text']};
    selection-background-color: {v['sel_bg']};
    selection-color: #ffffff;
}}
QPlainTextEdit:focus {{
    border-color: {v['accent']};
}}
QLineEdit {{
    background: {v['bg']};
    border: 1.5px solid transparent;
    border-radius: 10px;
    padding: 7px 12px;
    color: {v['text']};
    selection-background-color: {v['sel_bg']};
    selection-color: #ffffff;
}}
QLineEdit:focus {{
    border-color: {v['accent']};
}}
QPushButton {{
    background: {v['btn_bg']};
    border: none;
    border-radius: 10px;
    padding: 6px 14px;
    color: {v['text']};
    font-weight: 500;
}}
QPushButton:hover {{
    background: {v['btn_hover']};
}}
QPushButton:pressed {{
    background: {v['btn_press']};
}}
QPushButton:disabled {{
    color: {v['text_dim']};
}}
QScrollBar:vertical {{
    background: transparent;
    width: 6px;
    margin: 4px 1px;
}}
QScrollBar::handle:vertical {{
    background: {v['btn_hover']};
    border-radius: 3px;
    min-height: 16px;
}}
QScrollBar::handle:vertical:hover {{
    background: {v['text_dim']};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0px;
}}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
    background: transparent;
}}
"""


def _vk_to_key_name(vk: int) -> str:
    vk = int(vk)
    if 0x70 <= vk <= 0x87:
        return f"F{vk - 0x6F}"
    if 0x30 <= vk <= 0x39:
        return chr(vk)
    if 0x41 <= vk <= 0x5A:
        return chr(vk)
    names = {
        0x20: "Space",
        0x09: "Tab",
        0x1B: "Esc",
        0x0D: "Enter",
        0x2E: "Del",
        0x08: "Backspace",
        0x25: "Left",
        0x26: "Up",
        0x27: "Right",
        0x28: "Down",
    }
    return names.get(vk, f"VK_{vk}")


def _format_hotkey(mods: int, vk: int) -> str:
    parts: list[str] = []
    mods = int(mods)
    if mods & MOD_CONTROL:
        parts.append("Ctrl")
    if mods & MOD_ALT:
        parts.append("Alt")
    if mods & MOD_SHIFT:
        parts.append("Shift")
    if mods & MOD_WIN:
        parts.append("Win")
    parts.append(_vk_to_key_name(int(vk)))
    return "+".join(parts)


class _HotkeyEdit(QLineEdit):
    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._vk = 0
        self._mods = 0
        self.setReadOnly(True)
        self.setPlaceholderText("点击后按组合键" if QApplication.instance().property("ui_lang") != "en" else "Click and press keys")

    def set_hotkey(self, mods: int, vk: int) -> None:
        self._mods = int(mods)
        self._vk = int(vk)
        self.setText(_format_hotkey(self._mods, self._vk))
        self.changed.emit()

    def hotkey(self) -> dict[str, int]:
        return {"vk": int(self._vk), "mods": int(self._mods)}

    def keyPressEvent(self, event) -> None:  # type: ignore[override]
        if event.key() in (Qt.Key_Control, Qt.Key_Shift, Qt.Key_Alt, Qt.Key_Meta):
            event.accept()
            return
        vk = int(getattr(event, "nativeVirtualKey")() or 0)
        if vk <= 0:
            event.accept()
            return
        mods = 0
        qt_mods = event.modifiers()
        if qt_mods & Qt.ControlModifier:
            mods |= MOD_CONTROL
        if qt_mods & Qt.AltModifier:
            mods |= MOD_ALT
        if qt_mods & Qt.ShiftModifier:
            mods |= MOD_SHIFT
        if qt_mods & Qt.MetaModifier:
            mods |= MOD_WIN
        self.set_hotkey(mods, vk)
        event.accept()


class _SourceEditFilter(QObject):
    ctrl_enter = Signal()

    def eventFilter(self, obj, event):  # type: ignore[override]
        if event.type() == QEvent.KeyPress:
            if event.key() in (Qt.Key_Return, Qt.Key_Enter) and (event.modifiers() & Qt.ControlModifier):
                self.ctrl_enter.emit()
                return True
        return False


class DashboardWindow(QWidget):
    translate_requested = Signal()
    copy_source_requested = Signal()
    copy_target_requested = Signal()
    clear_requested = Signal()
    theme_changed = Signal(str, int)  # theme_name, font_size

    def __init__(self, on_hotkeys_changed: Callable[[], None] | None = None) -> None:
        super().__init__()
        self._store = SettingsStore()
        self._on_hotkeys_changed = on_hotkeys_changed
        self._ui_lang = self._store.get_ui_language()
        self.setWindowTitle(self._t("dashboard_title"))
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.Window | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setMinimumSize(820, 480)

        self._theme = self._store.get_theme()
        self._font_size = self._store.get_font_size()
        self._drag_active = False
        self._drag_offset = QPoint()

        self._build_ui()
        self.apply_theme(self._theme, self._font_size)
        self._apply_ui_language()

    @property
    def source_edit(self) -> QTextEdit:
        return self._source_edit

    @property
    def target_edit(self) -> QTextEdit:
        return self._target_edit

    def apply_theme(self, theme: str, font_size: int | None = None) -> None:
        theme = theme.lower().strip()
        if theme not in THEME_NAMES:
            theme = "dark"
        self._theme = theme
        if font_size is not None:
            self._font_size = max(10, min(24, int(font_size)))
        self.setStyleSheet(_build_qss(self._theme, self._font_size))
        if hasattr(self, "_combo_theme"):
            self._set_combo_by_data(self._combo_theme, self._theme)

    def get_theme(self) -> str:
        return self._theme

    def get_font_size(self) -> int:
        return self._font_size

    def set_source_text(self, text: str) -> None:
        self._source_edit.setPlainText(text or "")

    def set_target_text(self, text: str) -> None:
        self._target_edit.setPlainText(text or "")

    def get_source_text(self) -> str:
        return self._source_edit.toPlainText() or ""

    def mousePressEvent(self, event) -> None:  # type: ignore[override]
        if event.button() == Qt.LeftButton and self._is_in_title_bar(event.position().toPoint()):
            self._drag_active = True
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # type: ignore[override]
        if self._drag_active and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # type: ignore[override]
        if event.button() == Qt.LeftButton:
            self._drag_active = False
        super().mouseReleaseEvent(event)

    def _is_in_title_bar(self, pos: QPoint) -> bool:
        return pos.y() <= self._title_bar.height()

    def _build_ui(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        self._root_card = QWidget(self)
        self._root_card.setObjectName("RootCard")
        outer.addWidget(self._root_card)

        root = QVBoxLayout(self._root_card)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── Title bar ──────────────────────────────
        self._title_bar = QWidget(self)
        self._title_bar.setObjectName("TitleBar")
        self._title_bar.setFixedHeight(48)
        title_layout = QHBoxLayout(self._title_bar)
        title_layout.setContentsMargins(14, 0, 8, 0)
        title_layout.setSpacing(10)

        self._logo = QLabel(self._title_bar)
        self._logo.setFixedSize(22, 22)
        self._logo.setPixmap(QApplication.windowIcon().pixmap(22, 22))
        title_layout.addWidget(self._logo)

        self._title = QLabel(self._t("dashboard_title"), self._title_bar)
        self._title.setObjectName("AppTitle")
        title_layout.addWidget(self._title)

        self._backend_label = QLabel("", self._title_bar)
        self._backend_label.setObjectName("BackendBadge")
        self._backend_label.hide()
        title_layout.addWidget(self._backend_label)

        title_layout.addStretch(1)

        btn_min = QPushButton("−", self._title_bar)
        btn_min.setObjectName("WindowButton")
        btn_min.setToolTip("最小化")

        btn_close = QPushButton("×", self._title_bar)
        btn_close.setObjectName("CloseButton")
        btn_close.setToolTip("关闭")

        btn_min.clicked.connect(self.showMinimized)
        btn_close.clicked.connect(self.close)

        title_layout.addWidget(btn_min)
        title_layout.addWidget(btn_close)

        root.addWidget(self._title_bar)

        # ── Toolbar ────────────────────────────────
        toolbar_wrap = QWidget(self)
        toolbar_wrap.setObjectName("ToolBar")
        toolbar_wrap.setFixedHeight(54)
        toolbar_layout = QHBoxLayout(toolbar_wrap)
        toolbar_layout.setContentsMargins(14, 8, 14, 8)
        toolbar_layout.setSpacing(6)

        # Primary action button
        self._btn_translate = QPushButton(self._t("translate"), toolbar_wrap)
        self._btn_translate.setObjectName("TranslateBtn")

        # Language selectors
        self._source_lang = QComboBox(toolbar_wrap)
        self._target_lang = QComboBox(toolbar_wrap)
        self._populate_lang_combos()

        sep_arrow = QLabel("→", toolbar_wrap)
        sep_arrow.setObjectName("SepArrow")

        # Secondary actions
        self._btn_copy_src = QPushButton(self._t("copy_source"), toolbar_wrap)
        self._btn_copy_tgt = QPushButton(self._t("copy_target"), toolbar_wrap)
        self._btn_clear = QPushButton(self._t("clear"), toolbar_wrap)

        # Theme combo
        self._combo_theme = QComboBox(toolbar_wrap)
        self._combo_theme.setMaximumWidth(90)
        for k, label in THEME_NAMES.items():
            self._combo_theme.addItem(label, k)
        self._set_combo_by_data(self._combo_theme, self._theme)

        # Settings button
        self._btn_settings = QPushButton("⚙", toolbar_wrap)
        self._btn_settings.setObjectName("IconButton")
        self._btn_settings.setToolTip(self._t("tip_settings"))

        # Tooltips
        self._btn_translate.setToolTip(self._t("tip_translate"))
        self._btn_copy_src.setToolTip(self._t("tip_copy_source"))
        self._btn_copy_tgt.setToolTip(self._t("tip_copy_target"))
        self._btn_clear.setToolTip(self._t("tip_clear"))
        self._source_lang.setToolTip(self._t("tip_source_lang"))
        self._target_lang.setToolTip(self._t("tip_target_lang"))
        self._combo_theme.setToolTip(self._t("tip_theme"))

        # Connections
        self._btn_translate.clicked.connect(self.translate_requested.emit)
        self._btn_copy_src.clicked.connect(self.copy_source_requested.emit)
        self._btn_copy_tgt.clicked.connect(self.copy_target_requested.emit)
        self._btn_clear.clicked.connect(self.clear_requested.emit)
        self._btn_settings.clicked.connect(self._open_settings_dialog)
        self._source_lang.currentIndexChanged.connect(
            lambda: self._store.set_source_language(self.get_source_language())
        )
        self._target_lang.currentIndexChanged.connect(
            lambda: self._store.set_target_language(self.get_target_language())
        )
        self._combo_theme.currentIndexChanged.connect(self._on_theme_changed)

        # Layout order: [Translate] [SrcLang] → [TgtLang]  stretch  [CopySrc] [CopyTgt] [Clear] | [Theme] [⚙]
        toolbar_layout.addWidget(self._btn_translate)
        toolbar_layout.addSpacing(6)
        toolbar_layout.addWidget(self._source_lang)
        toolbar_layout.addWidget(sep_arrow)
        toolbar_layout.addWidget(self._target_lang)
        toolbar_layout.addStretch(1)
        toolbar_layout.addWidget(self._btn_copy_src)
        toolbar_layout.addWidget(self._btn_copy_tgt)
        toolbar_layout.addWidget(self._btn_clear)
        toolbar_layout.addSpacing(6)
        toolbar_layout.addWidget(self._combo_theme)
        toolbar_layout.addWidget(self._btn_settings)

        root.addWidget(toolbar_wrap)

        # ── Text areas ─────────────────────────────
        content = QWidget(self)
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(14, 10, 14, 14)
        content_layout.setSpacing(0)

        splitter = QSplitter(Qt.Horizontal, content)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(8)

        self._source_edit = QTextEdit(splitter)
        self._source_edit.setReadOnly(False)
        self._source_edit.setPlaceholderText(self._t("source_placeholder"))

        self._target_edit = QTextEdit(splitter)
        self._target_edit.setReadOnly(True)
        self._target_edit.setPlaceholderText(self._t("target_placeholder"))

        splitter.addWidget(self._source_edit)
        splitter.addWidget(self._target_edit)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 1)

        content_layout.addWidget(splitter, 1)
        root.addWidget(content, 1)

        self._source_filter = _SourceEditFilter(self)
        self._source_filter.ctrl_enter.connect(self.translate_requested.emit)
        self._source_edit.installEventFilter(self._source_filter)

    def _populate_lang_combos(self) -> None:
        src_cur = self._store.get_source_language()
        self._source_lang.blockSignals(True)
        self._source_lang.clear()
        for code, label_key in _LANG_LIST:
            self._source_lang.addItem(self._t(label_key), code)
        self._set_combo_by_data(self._source_lang, src_cur)
        self._source_lang.blockSignals(False)

        tgt_cur = self._store.get_target_language()
        self._target_lang.blockSignals(True)
        self._target_lang.clear()
        for code, label_key in _LANG_LIST:
            self._target_lang.addItem(self._t(label_key), code)
        self._set_combo_by_data(self._target_lang, tgt_cur)
        self._target_lang.blockSignals(False)

    def _on_theme_changed(self) -> None:
        theme = str(self._combo_theme.currentData() or "dark")
        self._theme = theme
        self._store.set_theme(theme)
        self.setStyleSheet(_build_qss(self._theme, self._font_size))
        self.theme_changed.emit(self._theme, self._font_size)

    def get_target_language(self) -> str:
        try:
            return str(self._target_lang.currentData() or "auto")
        except Exception:
            return "auto"

    def get_source_language(self) -> str:
        try:
            return str(self._source_lang.currentData() or "auto")
        except Exception:
            return "auto"

    def get_subject(self) -> str:
        return ""

    def get_ui_language(self) -> str:
        return self._ui_lang

    def set_backend_info(self, text: str) -> None:
        text = str(text or "").strip()
        self._backend_label.setText(text)
        self._backend_label.setVisible(bool(text))

    def _t(self, key: str) -> str:
        zh = {
            "dashboard_title": "FlashTrans",
            "translate": "翻译",
            "copy_source": "复制原文",
            "copy_target": "复制译文",
            "clear": "清空",
            "settings": "设置",
            "lang_auto":    "自动",
            "lang_zh":      "中文(简)",
            "lang_zh_hant": "中文(繁)",
            "lang_en":      "英语",
            "lang_ja":      "日语",
            "lang_ko":      "韩语",
            "lang_fr":      "法语",
            "lang_de":      "德语",
            "lang_es":      "西班牙语",
            "lang_it":      "意大利语",
            "lang_pt":      "葡萄牙语",
            "lang_ru":      "俄语",
            "lang_ar":      "阿拉伯语",
            "lang_hi":      "印地语",
            "lang_vi":      "越南语",
            "lang_th":      "泰语",
            "lang_id":      "印尼语",
            "lang_ms":      "马来语",
            "lang_tr":      "土耳其语",
            "lang_nl":      "荷兰语",
            "lang_pl":      "波兰语",
            "lang_uk":      "乌克兰语",
            "lang_sv":      "瑞典语",
            "lang_el":      "希腊语",
            "lang_he":      "希伯来语",
            "lang_bn":      "孟加拉语",
            "tip_translate": "将左侧原文翻译到右侧（快捷键：Ctrl+Enter）",
            "tip_copy_source": "复制左侧识别结果",
            "tip_copy_target": "复制右侧翻译结果",
            "tip_clear": "清空原文和译文",
            "tip_settings": "配置 API / 界面 / 快捷键",
            "tip_theme": "切换主题",
            "tip_source_lang": "源语言（自动=自动检测）",
            "tip_target_lang": "目标语言",
            "source_placeholder": "原文（可编辑，Ctrl+Enter 翻译）",
            "target_placeholder": "译文（翻译结果）",
            "dlg_title": "设置",
            "ui_lang": "界面语言",
            "ui_zh": "中文",
            "ui_en": "English",
            "llm_enable": "启用 F4 大模型交互（使用 API）",
            "font_size": "字体大小",
            "api_profile": "配置名称",
            "api_base": "API Base URL",
            "api_model": "Model",
            "api_key": "API Key",
            "save": "保存",
            "delete": "删除",
            "ok": "确定",
        }
        en = {
            "dashboard_title": "FlashTrans",
            "translate": "Translate",
            "copy_source": "Copy Src",
            "copy_target": "Copy Tgt",
            "clear": "Clear",
            "settings": "Settings",
            "lang_auto":    "Auto",
            "lang_zh":      "Chinese (S)",
            "lang_zh_hant": "Chinese (T)",
            "lang_en":      "English",
            "lang_ja":      "Japanese",
            "lang_ko":      "Korean",
            "lang_fr":      "French",
            "lang_de":      "German",
            "lang_es":      "Spanish",
            "lang_it":      "Italian",
            "lang_pt":      "Portuguese",
            "lang_ru":      "Russian",
            "lang_ar":      "Arabic",
            "lang_hi":      "Hindi",
            "lang_vi":      "Vietnamese",
            "lang_th":      "Thai",
            "lang_id":      "Indonesian",
            "lang_ms":      "Malay",
            "lang_tr":      "Turkish",
            "lang_nl":      "Dutch",
            "lang_pl":      "Polish",
            "lang_uk":      "Ukrainian",
            "lang_sv":      "Swedish",
            "lang_el":      "Greek",
            "lang_he":      "Hebrew",
            "lang_bn":      "Bengali",
            "tip_translate": "Translate left text to the right (Ctrl+Enter)",
            "tip_copy_source": "Copy source text",
            "tip_copy_target": "Copy translated text",
            "tip_clear": "Clear both panes",
            "tip_settings": "Configure API / UI / hotkeys",
            "tip_theme": "Switch theme",
            "tip_source_lang": "Source language (Auto = auto-detect)",
            "tip_target_lang": "Target language",
            "source_placeholder": "Source text (editable, Ctrl+Enter to translate)",
            "target_placeholder": "Translation result",
            "dlg_title": "Settings",
            "ui_lang": "UI Language",
            "ui_zh": "中文",
            "ui_en": "English",
            "llm_enable": "Enable F4 LLM (via API)",
            "font_size": "Font Size",
            "api_profile": "Profile",
            "api_base": "API Base URL",
            "api_model": "Model",
            "api_key": "API Key",
            "save": "Save",
            "delete": "Delete",
            "ok": "OK",
        }
        return (en if self._ui_lang == "en" else zh).get(key, key)

    def _apply_ui_language(self) -> None:
        self.setWindowTitle(self._t("dashboard_title"))
        self._title.setText(self._t("dashboard_title"))
        self._btn_translate.setText(self._t("translate"))
        self._btn_copy_src.setText(self._t("copy_source"))
        self._btn_copy_tgt.setText(self._t("copy_target"))
        self._btn_clear.setText(self._t("clear"))

        self._btn_translate.setToolTip(self._t("tip_translate"))
        self._btn_copy_src.setToolTip(self._t("tip_copy_source"))
        self._btn_copy_tgt.setToolTip(self._t("tip_copy_target"))
        self._btn_clear.setToolTip(self._t("tip_clear"))
        self._source_lang.setToolTip(self._t("tip_source_lang"))
        self._target_lang.setToolTip(self._t("tip_target_lang"))
        self._combo_theme.setToolTip(self._t("tip_theme"))

        self._source_edit.setPlaceholderText(self._t("source_placeholder"))
        self._target_edit.setPlaceholderText(self._t("target_placeholder"))

        self._populate_lang_combos()

        cur_theme = self.get_theme()
        self._combo_theme.blockSignals(True)
        self._combo_theme.clear()
        theme_map = THEME_NAMES_EN if self._ui_lang == "en" else THEME_NAMES
        for k, label in theme_map.items():
            self._combo_theme.addItem(label, k)
        self._set_combo_by_data(self._combo_theme, cur_theme)
        self._combo_theme.blockSignals(False)

    def _set_combo_by_data(self, combo: QComboBox, value: str) -> None:
        value = str(value or "")
        for i in range(combo.count()):
            if str(combo.itemData(i)) == value:
                combo.setCurrentIndex(i)
                return
        combo.setCurrentIndex(0)

    def _open_settings_dialog(self) -> None:
        dlg = _SettingsDialog(
            self._store, self._ui_lang, self,
            on_hotkeys_changed=self._on_hotkeys_changed,
            current_font_size=self._font_size,
        )
        if dlg.exec() == QDialog.Accepted:
            self._ui_lang = self._store.get_ui_language()
            new_font_size = self._store.get_font_size()
            if new_font_size != self._font_size:
                self._font_size = new_font_size
                self.setStyleSheet(_build_qss(self._theme, self._font_size))
                self.theme_changed.emit(self._theme, self._font_size)
            self._apply_ui_language()


class _SettingsDialog(QDialog):
    def __init__(
        self,
        store: SettingsStore,
        ui_lang: str,
        parent: QWidget | None = None,
        on_hotkeys_changed: Callable[[], None] | None = None,
        current_font_size: int = 12,
    ) -> None:
        super().__init__(parent)
        self._store = store
        self._ui_lang = ui_lang if ui_lang in ("zh-CN", "en") else "zh-CN"
        self._on_hotkeys_changed = on_hotkeys_changed
        self._current_font_size = current_font_size
        self.setWindowTitle("设置" if self._ui_lang != "en" else "Settings")
        self.setModal(True)
        self.resize(600, 640)
        if parent is not None:
            try:
                self.setStyleSheet(parent.styleSheet())
            except Exception:
                pass

        root = QVBoxLayout(self)
        root.setSpacing(10)

        form = QFormLayout()
        form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        form.setSpacing(8)
        root.addLayout(form)

        self._lang_combo = QComboBox(self)
        self._lang_combo.addItem("中文", "zh-CN")
        self._lang_combo.addItem("English", "en")
        self._set_combo_by_data(self._lang_combo, self._store.get_ui_language())
        form.addRow("界面语言" if self._ui_lang != "en" else "UI Language", self._lang_combo)

        # Font size
        self._font_spin = QSpinBox(self)
        self._font_spin.setRange(10, 24)
        self._font_spin.setValue(current_font_size)
        self._font_spin.setSuffix(" px")
        form.addRow("字体大小" if self._ui_lang != "en" else "Font Size", self._font_spin)

        # Popup auto-close delay
        self._popup_close_combo = QComboBox(self)
        for secs, zh_label, en_label in (
            (5, "5 秒", "5 s"),
            (8, "8 秒", "8 s"),
            (15, "15 秒", "15 s"),
            (30, "30 秒", "30 s"),
            (0, "不自动关闭", "Never"),
        ):
            self._popup_close_combo.addItem(en_label if self._ui_lang == "en" else zh_label, secs)
        cur_secs = self._store.get_popup_autoclose_secs()
        idx = self._popup_close_combo.findData(cur_secs)
        if idx < 0:
            self._popup_close_combo.addItem(
                f"{cur_secs} s" if self._ui_lang == "en" else f"{cur_secs} 秒", cur_secs
            )
            idx = self._popup_close_combo.count() - 1
        self._popup_close_combo.setCurrentIndex(idx)
        self._popup_close_combo.setToolTip(
            "划词/截图结果弹窗多久后自动关闭；鼠标悬停在弹窗上时不会关闭"
            if self._ui_lang != "en"
            else "Auto-close delay for result popups; hovering keeps them open"
        )
        form.addRow("弹窗停留" if self._ui_lang != "en" else "Popup stay", self._popup_close_combo)

        self._llm_enable = QCheckBox(
            "启用 F4 大模型交互（使用 API）" if self._ui_lang != "en" else "Enable F4 LLM (via API)", self
        )
        self._llm_enable.setChecked(self._store.get_llm_enabled())
        form.addRow("", self._llm_enable)

        # Hotkeys
        hotkey_box = QGroupBox("快捷键" if self._ui_lang != "en" else "Hotkeys", self)
        hotkey_layout = QFormLayout(hotkey_box)
        hotkey_layout.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        hotkey_layout.setSpacing(6)

        self._hk_f1 = _HotkeyEdit(hotkey_box)
        self._hk_f2 = _HotkeyEdit(hotkey_box)
        self._hk_f3 = _HotkeyEdit(hotkey_box)
        self._hk_f4 = _HotkeyEdit(hotkey_box)
        self._hk_f5 = _HotkeyEdit(hotkey_box)

        hotkey_layout.addRow("F1 划词" if self._ui_lang != "en" else "F1 Select", self._hk_f1)
        hotkey_layout.addRow("F2 打字" if self._ui_lang != "en" else "F2 Type", self._hk_f2)
        hotkey_layout.addRow("F3 截图" if self._ui_lang != "en" else "F3 Screenshot", self._hk_f3)
        hotkey_layout.addRow("F4 对话" if self._ui_lang != "en" else "F4 Chat", self._hk_f4)
        hotkey_layout.addRow("F5 仪表盘" if self._ui_lang != "en" else "F5 Dashboard", self._hk_f5)

        hk_btn_row = QWidget(hotkey_box)
        hk_btn_layout = QHBoxLayout(hk_btn_row)
        hk_btn_layout.setContentsMargins(0, 0, 0, 0)
        hk_btn_layout.setSpacing(8)
        self._btn_hotkeys_reset = QPushButton("恢复默认" if self._ui_lang != "en" else "Reset", hk_btn_row)
        self._btn_hotkeys_save = QPushButton("保存快捷键" if self._ui_lang != "en" else "Save Hotkeys", hk_btn_row)
        hk_btn_layout.addStretch(1)
        hk_btn_layout.addWidget(self._btn_hotkeys_reset)
        hk_btn_layout.addWidget(self._btn_hotkeys_save)
        hotkey_layout.addRow("", hk_btn_row)

        self._load_hotkeys()
        root.addWidget(hotkey_box)

        # API config
        api_box = QGroupBox("API" if self._ui_lang == "en" else "API 配置", self)
        api_layout = QFormLayout(api_box)
        api_layout.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        api_layout.setSpacing(6)

        self._profile_combo = QComboBox(api_box)
        for n in self._store.list_profiles():
            self._profile_combo.addItem(n, n)
        self._set_combo_by_data(self._profile_combo, self._store.get_selected_profile())
        api_layout.addRow("配置名称" if self._ui_lang != "en" else "Profile", self._profile_combo)

        p = self._store.get_profile(str(self._profile_combo.currentData() or "default"))
        self._base_url = QLineEdit(api_box)
        self._base_url.setText(p.base_url)
        self._base_url.setPlaceholderText("https://api.example.com/v1")
        api_layout.addRow("API URL", self._base_url)

        self._model = QLineEdit(api_box)
        self._model.setText(p.model)
        self._model.setPlaceholderText("gpt-4o-mini / deepseek-chat / ...")
        api_layout.addRow("Model", self._model)

        key_row = QWidget(api_box)
        key_row_layout = QHBoxLayout(key_row)
        key_row_layout.setContentsMargins(0, 0, 0, 0)
        key_row_layout.setSpacing(6)

        self._api_key = QLineEdit(key_row)
        self._api_key.setEchoMode(QLineEdit.Password)
        self._api_key.setText(p.api_key)
        self._api_key.setPlaceholderText("sk-...")

        self._show_key = QCheckBox("显示" if self._ui_lang != "en" else "Show", key_row)
        self._show_key.setChecked(False)
        self._show_key.toggled.connect(
            lambda on: self._api_key.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password)
        )
        key_row_layout.addWidget(self._api_key, 1)
        key_row_layout.addWidget(self._show_key)
        api_layout.addRow("API Key", key_row)

        root.addWidget(api_box)

        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(8)
        self._btn_save = QPushButton("保存" if self._ui_lang != "en" else "Save", row)
        self._btn_delete = QPushButton("删除" if self._ui_lang != "en" else "Delete", row)
        self._btn_ok = QPushButton("确定" if self._ui_lang != "en" else "OK", row)
        self._btn_ok.setObjectName("TranslateBtn")
        row_layout.addStretch(1)
        row_layout.addWidget(self._btn_save)
        row_layout.addWidget(self._btn_delete)
        row_layout.addWidget(self._btn_ok)
        root.addWidget(row)

        self._profile_combo.currentIndexChanged.connect(self._load_profile)
        self._btn_save.clicked.connect(self._save)
        self._btn_delete.clicked.connect(self._delete)
        self._btn_hotkeys_reset.clicked.connect(self._reset_hotkeys)
        self._btn_hotkeys_save.clicked.connect(lambda: self._save_hotkeys(show_success=True))
        self._btn_ok.clicked.connect(self._ok)

    def _set_combo_by_data(self, combo: QComboBox, value: str) -> None:
        value = str(value or "")
        for i in range(combo.count()):
            if str(combo.itemData(i)) == value:
                combo.setCurrentIndex(i)
                return
        combo.setCurrentIndex(0)

    def _load_profile(self) -> None:
        name = str(self._profile_combo.currentData() or "default")
        p = self._store.get_profile(name)
        self._base_url.setText(p.base_url)
        self._model.setText(p.model)
        self._api_key.setText(p.api_key)
        self._store.set_selected_profile(name)

    def _save(self) -> None:
        name = str(self._profile_combo.currentData() or "default").strip() or "default"
        p = ApiProfile(
            name=name,
            base_url=str(self._base_url.text() or "").strip(),
            api_key=str(self._api_key.text() or "").strip(),
            model=str(self._model.text() or "").strip(),
        )
        self._store.upsert_profile(p)
        self._store.set_selected_profile(name)
        QMessageBox.information(
            self, "提示" if self._ui_lang != "en" else "Info", "已保存" if self._ui_lang != "en" else "Saved"
        )

    def _delete(self) -> None:
        name = str(self._profile_combo.currentData() or "default").strip()
        if not name or name == "default":
            return
        self._store.delete_profile(name)
        self._profile_combo.clear()
        for n in self._store.list_profiles():
            self._profile_combo.addItem(n, n)
        self._set_combo_by_data(self._profile_combo, self._store.get_selected_profile())
        self._load_profile()

    def _ok(self) -> None:
        self._store.set_ui_language(str(self._lang_combo.currentData() or "zh-CN"))
        self._store.set_llm_enabled(bool(self._llm_enable.isChecked()))
        self._store.set_selected_profile(str(self._profile_combo.currentData() or "default"))
        self._store.set_font_size(int(self._font_spin.value()))
        pc = self._popup_close_combo.currentData()
        self._store.set_popup_autoclose_secs(int(pc) if pc is not None else 8)
        if not self._save_hotkeys(show_success=False):
            return
        self.accept()

    def _load_hotkeys(self) -> None:
        hk = self._store.get_hotkeys()
        self._hk_f1.set_hotkey(int(hk.get("f1", {}).get("mods", 0)), int(hk.get("f1", {}).get("vk", 0x70)))
        self._hk_f2.set_hotkey(int(hk.get("f2", {}).get("mods", 0)), int(hk.get("f2", {}).get("vk", 0x71)))
        self._hk_f3.set_hotkey(int(hk.get("f3", {}).get("mods", 0)), int(hk.get("f3", {}).get("vk", 0x72)))
        self._hk_f4.set_hotkey(int(hk.get("f4", {}).get("mods", 0)), int(hk.get("f4", {}).get("vk", 0x73)))
        self._hk_f5.set_hotkey(int(hk.get("f5", {}).get("mods", 0)), int(hk.get("f5", {}).get("vk", 0x74)))

    def _reset_hotkeys(self) -> None:
        self._hk_f1.set_hotkey(0, 0x70)
        self._hk_f2.set_hotkey(0, 0x71)
        self._hk_f3.set_hotkey(0, 0x72)
        self._hk_f4.set_hotkey(0, 0x73)
        self._hk_f5.set_hotkey(0, 0x74)

    def _collect_hotkeys(self) -> dict[str, dict[str, int]]:
        return {
            "f1": self._hk_f1.hotkey(),
            "f2": self._hk_f2.hotkey(),
            "f3": self._hk_f3.hotkey(),
            "f4": self._hk_f4.hotkey(),
            "f5": self._hk_f5.hotkey(),
        }

    def _save_hotkeys(self, show_success: bool) -> bool:
        hk = self._collect_hotkeys()
        labels = {
            "f1": "F1 划词" if self._ui_lang != "en" else "F1 Select",
            "f2": "F2 打字" if self._ui_lang != "en" else "F2 Type",
            "f3": "F3 截图" if self._ui_lang != "en" else "F3 Screenshot",
            "f4": "F4 对话" if self._ui_lang != "en" else "F4 Chat",
            "f5": "F5 仪表盘" if self._ui_lang != "en" else "F5 Dashboard",
        }
        seen: dict[tuple[int, int], str] = {}
        conflicts: list[tuple[str, str, str]] = []
        for k, v in hk.items():
            key = (int(v.get("mods", 0)), int(v.get("vk", 0)))
            if key in seen:
                conflicts.append((labels.get(seen[key], seen[key]), labels.get(k, k), _format_hotkey(*key)))
            else:
                seen[key] = k
        if conflicts:
            msg = "\n".join([f"{a} / {b}: {combo}" for a, b, combo in conflicts[:3]])
            QMessageBox.warning(
                self,
                "冲突" if self._ui_lang != "en" else "Conflict",
                ("快捷键冲突，请修改后再保存：\n" if self._ui_lang != "en" else "Hotkey conflict:\n") + msg,
            )
            return False

        self._store.set_hotkeys(hk)
        ok = callable(self._on_hotkeys_changed)
        if ok:
            try:
                self._on_hotkeys_changed()
            except Exception:
                pass
        if show_success:
            QMessageBox.information(
                self,
                "提示" if self._ui_lang != "en" else "Info",
                "快捷键已保存" if self._ui_lang != "en" else "Hotkeys saved",
            )
        return True
