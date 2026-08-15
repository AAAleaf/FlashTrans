import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ApiProfile {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LocalSettings {
  mode: "api" | "nllb" | "qwen" | "opus";
  modelsDir: string;
  selectedModel: string;
  /** F4 对话 / OCR 纠错专用的 .gguf；留空 = 沿用翻译模型（仅它本身是 GGUF 时可用） */
  assistantModel?: string;
  ocrEnabled: boolean;
  extraModels?: string[];
  /** 默认文件夹扫描到但被用户从列表移除的模型（只隐藏显示，不动磁盘文件） */
  hiddenModels?: string[];
  modelMeta?: Record<string, { name?: string; note?: string }>;
}

export interface PromptPreset {
  name: string;
  text: string;
}

/** 自定义 OCR 模型（RapidOCR 格式的 PP-OCR ONNX），用于系统没装语言包的语种 */
export interface OcrProfile {
  name: string;
  recPath: string;
  keysPath: string;
  detPath: string;
  clsPath: string;
  /** rec 模型要求的输入高度：PP-OCRv3/v4/v5 一般 48，v1/v2.0 老模型是 32 */
  recHeight?: number;
}

export interface Settings {
  theme: "dark" | "light";
  popupStaySecs: number;
  closeOnBlur: boolean;
  uiScale: number;
  sourceLang: string;
  targetLang: string;
  /** 双向自动切换：识别到的语言正好是目标语言时，改译回源语言 */
  autoSwap?: boolean;
  /** 截图翻译把译文原位覆盖在框选区域上 */
  snipOverlay?: boolean;
  /** 覆盖层排版：auto 按文字密度自动选，inplace 逐段贴回原处，panel 整块重排 */
  snipOverlayLayout?: "auto" | "inplace" | "panel";
  local: LocalSettings;
  hotkeys: Record<string, string>;
  api: { selected: string; profiles: ApiProfile[] };
  prompts?: { selected: string; presets: PromptPreset[] };
  ocr?: { selected: string; profiles: OcrProfile[] };
}

/** 自定义 OCR 预设容器（旧配置无此字段时就地补全） */
export function ensureOcr(s: Settings): { selected: string; profiles: OcrProfile[] } {
  if (!s.ocr) s.ocr = { selected: "", profiles: [] };
  if (!Array.isArray(s.ocr.profiles)) s.ocr.profiles = [];
  return s.ocr;
}

/** 当前生效的自定义 OCR 模型；未选返回 null（走默认 RapidOCR / 系统 OCR） */
export function activeOcrProfile(s: Settings): OcrProfile | null {
  const sel = s.ocr?.selected;
  if (!sel) return null;
  return s.ocr?.profiles?.find((p) => p.name === sel) ?? null;
}

/** 领域提示词预设容器（旧配置无此字段时就地补全） */
export function ensurePrompts(s: Settings): { selected: string; presets: PromptPreset[] } {
  if (!s.prompts) s.prompts = { selected: "", presets: [] };
  if (!Array.isArray(s.prompts.presets)) s.prompts.presets = [];
  return s.prompts;
}

/** 当前生效的领域提示词文本；未选或引擎不适用时由调用方决定是否传入 */
export function activeDomainPrompt(s: Settings): string {
  const pr = s.prompts;
  if (!pr?.selected) return "";
  const p = pr.presets?.find((x) => x.name === pr.selected);
  return (p?.text ?? "").trim();
}

/** 把键盘事件转成全局热键组合串（如 "Ctrl+Shift+A" / "F2"）；不合法返回 null */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const c = e.code;
  let key = "";
  if (/^F\d{1,2}$/.test(c)) key = c;
  else if (c.startsWith("Key")) key = c.slice(3);
  else if (c.startsWith("Digit")) key = c.slice(5);
  else if (c === "Space") key = "Space";
  else return null;
  // 非 F 键必须带修饰键，避免吞掉正常输入
  if (!mods.length && !/^F\d/.test(key)) return null;
  return [...mods, key].join("+");
}

export interface ModelInfo {
  id: string;
  kind: "nllb" | "qwen" | string;
  label: string;
  path: string;
  ready: boolean;
  detail: string;
}

export interface ModelStatus {
  models_root: string;
  models: ModelInfo[];
}

export async function loadSettings(): Promise<Settings> {
  return (await invoke("settings_get")) as Settings;
}

export async function saveSettings(s: Settings): Promise<void> {
  await invoke("settings_set", { value: s });
}

export function activeProfile(s: Settings): ApiProfile {
  const p = s.api.profiles.find((x) => x.name === s.api.selected);
  return p ?? s.api.profiles[0] ?? { name: "default", baseUrl: "", apiKey: "", model: "" };
}

export function applyTheme(theme: string) {
  document.documentElement.classList.toggle("light", theme === "light");
}

/** 界面缩放：用 CSS zoom 整体放大/缩小（解决不同分辨率下字忽大忽小） */
export function applyScale(scale?: number) {
  const z = scale && scale > 0.4 ? scale : 1;
  const root = document.documentElement;
  (root.style as { zoom?: string }).zoom = String(z);
  // zoom 不会改变 vh 的取值，100vh 会被一起放大 z 倍 → 底栏（翻译/复制按钮）被挤出窗口，
  // 用户点不到也看不见。把视口高度按 1/z 换算回来，布局才仍然是"刚好一屏"。
  root.style.setProperty("--vh-scale", String(1 / z));
}

/** 当前界面缩放倍率（窗口自适应高度时要把 CSS 像素换算成实际显示高度） */
export function currentScale(): number {
  const z = parseFloat((document.documentElement.style as { zoom?: string }).zoom || "1");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export function onSettingsChanged(cb: (s: Settings) => void) {
  listen("settings-changed", (e) => cb(e.payload as Settings));
}

export async function scanModels(modelsDir = ""): Promise<ModelStatus> {
  return (await invoke("models_scan", { modelsDir: modelsDir || null })) as ModelStatus;
}

export async function probeModel(path: string): Promise<ModelInfo | null> {
  return (await invoke("model_probe", { path })) as ModelInfo | null;
}

/** 合并默认文件夹扫描结果 + 用户手动添加的模型（extraModels），过滤被移除隐藏的，并套用自定义名称/备注 */
export async function collectModels(settings: Settings): Promise<{ root: string; models: ModelInfo[] }> {
  const st = await scanModels(settings.local.modelsDir);
  const hidden = new Set(settings.local.hiddenModels ?? []);
  const map = new Map<string, ModelInfo>();
  for (const m of st.models) {
    if (!hidden.has(m.path)) map.set(m.path, m);
  }

  const extras = settings.local.extraModels ?? [];
  for (const path of extras) {
    if (map.has(path)) continue;
    const info = await probeModel(path);
    if (info) map.set(info.path, info);
    else map.set(path, {
      id: path, kind: path.toLowerCase().endsWith(".gguf") ? "qwen" : "nllb",
      label: path.split(/[\\/]/).pop() || path, path, ready: false,
      detail: "路径无效或模型文件缺失",
    });
  }

  const meta = settings.local.modelMeta ?? {};
  const models = [...map.values()].map((m) => {
    const custom = meta[m.path];
    return {
      ...m,
      label: custom?.name?.trim() || m.label,
      detail: custom?.note?.trim() || m.detail,
    };
  });
  models.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return { root: st.models_root, models };
}

export function selectedLocalModel(settings: Settings, models: ModelInfo[] = []): ModelInfo | null {
  const selected = settings.local.selectedModel;
  const byId = selected ? models.find((m) => m.id === selected || m.path === selected) : null;
  if (byId) return byId;
  if (selected) {
    const kind = selected.toLowerCase().endsWith(".gguf") ? "qwen" : "nllb";
    return { id: selected, kind, label: selected.split(/[\\/]/).pop() || selected, path: selected, ready: true, detail: "" };
  }
  return models.find((m) => m.kind === settings.local.mode && m.ready) ?? null;
}

export function localReady(settings: Settings): boolean {
  return settings.local.mode !== "api" && Boolean(settings.local.selectedModel);
}

/** F4 对话 / OCR 纠错要用的本地 GGUF：优先专用助手模型，否则翻译模型本身是 GGUF 时用它 */
export function assistantModel(settings: Settings): string {
  const dedicated = (settings.local.assistantModel ?? "").trim();
  if (dedicated) return dedicated;
  if (settings.local.mode === "qwen" && settings.local.selectedModel) return settings.local.selectedModel;
  return "";
}

export async function localTranslate(settings: Settings, text: string, ocr = false): Promise<string> {
  const { source, target } = resolveLangPair(settings, text);
  const res = (await invoke("local_translate", {
    req: {
      backend: settings.local.mode,
      model: settings.local.selectedModel,
      text,
      sourceLang: source,
      targetLang: target,
      // 目标语言英文名（喂给本地 GGUF 提示词，比 FLORES 码可靠）；auto 时留空由后端解析
      targetName: target !== "auto" ? langEnglish(target) : "",
      ocr,
      // 领域提示词仅 GGUF 大模型使用；NLLB/Opus 桥接忽略
      domainPrompt: activeDomainPrompt(settings),
    },
  })) as { text?: string };
  return (res.text ?? "").trim();
}

export async function localChat(
  settings: Settings,
  question: string,
  contextTitle = "",
  contextSource = "",
  contextTranslated = "",
): Promise<string> {
  const res = (await invoke("local_chat", {
    req: {
      backend: "qwen", // 对话只有 GGUF 能做，助手模型可与翻译模型不同
      model: assistantModel(settings),
      question,
      contextTitle,
      contextSource,
      contextTranslated,
    },
  })) as { text?: string };
  return stripThink(res.text ?? "");
}

// [code, 中文名, English]。
// 常用语言用短码（zh/en/…），由 backend_bridge.py 的 NLLB_LANG_MAP 映射到 FLORES 码，
// 保持与已存设置兼容；其余为 FLORES-200（NLLB-200 全量支持）语言，code 直接采用
// FLORES 码（xxx_Yyyy），Python 端按该规则原样放行，无需逐条登记。
// 顺序：自动检测 + 常用 25 种置顶，之后按 FLORES 码字母序。
export const LANGS_FULL: [string, string, string][] = [
  ["auto", "自动检测", "Auto detect"],
  ["zh", "中文（简体）", "Chinese (Simplified)"],
  ["zh-Hant", "中文（繁体）", "Chinese (Traditional)"],
  ["en", "英语", "English"],
  ["ja", "日语", "Japanese"],
  ["ko", "韩语", "Korean"],
  ["fr", "法语", "French"],
  ["de", "德语", "German"],
  ["es", "西班牙语", "Spanish"],
  ["it", "意大利语", "Italian"],
  ["pt", "葡萄牙语", "Portuguese"],
  ["ru", "俄语", "Russian"],
  ["ar", "阿拉伯语", "Arabic"],
  ["hi", "印地语", "Hindi"],
  ["vi", "越南语", "Vietnamese"],
  ["th", "泰语", "Thai"],
  ["id", "印尼语", "Indonesian"],
  ["ms", "马来语", "Malay"],
  ["tr", "土耳其语", "Turkish"],
  ["nl", "荷兰语", "Dutch"],
  ["pl", "波兰语", "Polish"],
  ["uk", "乌克兰语", "Ukrainian"],
  ["sv", "瑞典语", "Swedish"],
  ["el", "希腊语", "Greek"],
  ["he", "希伯来语", "Hebrew"],
  ["bn", "孟加拉语", "Bengali"],
  // ── FLORES-200 其余语言（NLLB 全量支持）──
  ["ace_Arab", "亚齐语（阿拉伯文）", "Acehnese (Arabic)"],
  ["ace_Latn", "亚齐语（拉丁文）", "Acehnese (Latin)"],
  ["acm_Arab", "美索不达米亚阿拉伯语", "Mesopotamian Arabic"],
  ["acq_Arab", "塔伊兹-亚丁阿拉伯语", "Taʼizzi-Adeni Arabic"],
  ["aeb_Arab", "突尼斯阿拉伯语", "Tunisian Arabic"],
  ["afr_Latn", "南非荷兰语", "Afrikaans"],
  ["ajp_Arab", "南黎凡特阿拉伯语", "South Levantine Arabic"],
  ["aka_Latn", "阿坎语", "Akan"],
  ["amh_Ethi", "阿姆哈拉语", "Amharic"],
  ["apc_Arab", "北黎凡特阿拉伯语", "North Levantine Arabic"],
  ["ars_Arab", "内志阿拉伯语", "Najdi Arabic"],
  ["ary_Arab", "摩洛哥阿拉伯语", "Moroccan Arabic"],
  ["arz_Arab", "埃及阿拉伯语", "Egyptian Arabic"],
  ["asm_Beng", "阿萨姆语", "Assamese"],
  ["ast_Latn", "阿斯图里亚斯语", "Asturian"],
  ["awa_Deva", "阿瓦德语", "Awadhi"],
  ["ayr_Latn", "中艾马拉语", "Central Aymara"],
  ["azb_Arab", "南阿塞拜疆语", "South Azerbaijani"],
  ["azj_Latn", "北阿塞拜疆语", "North Azerbaijani"],
  ["bak_Cyrl", "巴什基尔语", "Bashkir"],
  ["bam_Latn", "班巴拉语", "Bambara"],
  ["ban_Latn", "巴厘语", "Balinese"],
  ["bel_Cyrl", "白俄罗斯语", "Belarusian"],
  ["bem_Latn", "本巴语", "Bemba"],
  ["bho_Deva", "博杰普尔语", "Bhojpuri"],
  ["bjn_Arab", "班查尔语（阿拉伯文）", "Banjar (Arabic)"],
  ["bjn_Latn", "班查尔语（拉丁文）", "Banjar (Latin)"],
  ["bod_Tibt", "藏语", "Standard Tibetan"],
  ["bos_Latn", "波斯尼亚语", "Bosnian"],
  ["bug_Latn", "布吉语", "Buginese"],
  ["bul_Cyrl", "保加利亚语", "Bulgarian"],
  ["cat_Latn", "加泰罗尼亚语", "Catalan"],
  ["ceb_Latn", "宿务语", "Cebuano"],
  ["ces_Latn", "捷克语", "Czech"],
  ["cjk_Latn", "乔奎语", "Chokwe"],
  ["ckb_Arab", "中库尔德语（索拉尼）", "Central Kurdish"],
  ["crh_Latn", "克里米亚鞑靼语", "Crimean Tatar"],
  ["cym_Latn", "威尔士语", "Welsh"],
  ["dan_Latn", "丹麦语", "Danish"],
  ["dik_Latn", "西南丁卡语", "Southwestern Dinka"],
  ["dyu_Latn", "迪尤拉语", "Dyula"],
  ["dzo_Tibt", "宗喀语", "Dzongkha"],
  ["epo_Latn", "世界语", "Esperanto"],
  ["est_Latn", "爱沙尼亚语", "Estonian"],
  ["eus_Latn", "巴斯克语", "Basque"],
  ["ewe_Latn", "埃维语", "Ewe"],
  ["fao_Latn", "法罗语", "Faroese"],
  ["pes_Arab", "波斯语（西）", "Western Persian"],
  ["fij_Latn", "斐济语", "Fijian"],
  ["fin_Latn", "芬兰语", "Finnish"],
  ["fon_Latn", "丰语", "Fon"],
  ["fur_Latn", "弗留利语", "Friulian"],
  ["fuv_Latn", "尼日利亚富拉语", "Nigerian Fulfulde"],
  ["gla_Latn", "苏格兰盖尔语", "Scottish Gaelic"],
  ["gle_Latn", "爱尔兰语", "Irish"],
  ["glg_Latn", "加利西亚语", "Galician"],
  ["grn_Latn", "瓜拉尼语", "Guarani"],
  ["guj_Gujr", "古吉拉特语", "Gujarati"],
  ["hat_Latn", "海地克里奥尔语", "Haitian Creole"],
  ["hau_Latn", "豪萨语", "Hausa"],
  ["hne_Deva", "恰蒂斯加尔语", "Chhattisgarhi"],
  ["hrv_Latn", "克罗地亚语", "Croatian"],
  ["hun_Latn", "匈牙利语", "Hungarian"],
  ["hye_Armn", "亚美尼亚语", "Armenian"],
  ["ibo_Latn", "伊博语", "Igbo"],
  ["ilo_Latn", "伊洛卡诺语", "Ilocano"],
  ["isl_Latn", "冰岛语", "Icelandic"],
  ["jav_Latn", "爪哇语", "Javanese"],
  ["kab_Latn", "卡拜尔语", "Kabyle"],
  ["kac_Latn", "景颇语", "Jingpho"],
  ["kam_Latn", "坎巴语", "Kamba"],
  ["kan_Knda", "卡纳达语", "Kannada"],
  ["kas_Arab", "克什米尔语（阿拉伯文）", "Kashmiri (Arabic)"],
  ["kas_Deva", "克什米尔语（天城文）", "Kashmiri (Devanagari)"],
  ["kat_Geor", "格鲁吉亚语", "Georgian"],
  ["knc_Arab", "中卡努里语（阿拉伯文）", "Central Kanuri (Arabic)"],
  ["knc_Latn", "中卡努里语（拉丁文）", "Central Kanuri (Latin)"],
  ["kaz_Cyrl", "哈萨克语", "Kazakh"],
  ["kbp_Latn", "卡比耶语", "Kabiyè"],
  ["kea_Latn", "佛得角克里奥尔语", "Kabuverdianu"],
  ["khm_Khmr", "高棉语", "Khmer"],
  ["kik_Latn", "基库尤语", "Kikuyu"],
  ["kin_Latn", "卢旺达语", "Kinyarwanda"],
  ["kir_Cyrl", "吉尔吉斯语", "Kyrgyz"],
  ["kmb_Latn", "金本杜语", "Kimbundu"],
  ["kon_Latn", "刚果语", "Kikongo"],
  ["kmr_Latn", "北库尔德语（库尔曼吉）", "Northern Kurdish"],
  ["lao_Laoo", "老挝语", "Lao"],
  ["lvs_Latn", "拉脱维亚语", "Latvian"],
  ["lij_Latn", "利古里亚语", "Ligurian"],
  ["lim_Latn", "林堡语", "Limburgish"],
  ["lin_Latn", "林加拉语", "Lingala"],
  ["lit_Latn", "立陶宛语", "Lithuanian"],
  ["lmo_Latn", "伦巴第语", "Lombard"],
  ["ltg_Latn", "拉特加莱语", "Latgalian"],
  ["ltz_Latn", "卢森堡语", "Luxembourgish"],
  ["lua_Latn", "卢巴-卡赛语", "Luba-Kasai"],
  ["lug_Latn", "卢干达语", "Ganda"],
  ["luo_Latn", "卢奥语", "Luo"],
  ["lus_Latn", "米佐语", "Mizo"],
  ["mag_Deva", "摩揭陀语", "Magahi"],
  ["mai_Deva", "迈蒂利语", "Maithili"],
  ["mal_Mlym", "马拉雅拉姆语", "Malayalam"],
  ["mar_Deva", "马拉地语", "Marathi"],
  ["min_Latn", "米南加保语", "Minangkabau"],
  ["mkd_Cyrl", "马其顿语", "Macedonian"],
  ["plt_Latn", "马达加斯加语", "Plateau Malagasy"],
  ["mlt_Latn", "马耳他语", "Maltese"],
  ["mni_Beng", "曼尼普尔语", "Meitei"],
  ["khk_Cyrl", "蒙古语", "Halh Mongolian"],
  ["mos_Latn", "摩西语", "Mossi"],
  ["mri_Latn", "毛利语", "Maori"],
  ["mya_Mymr", "缅甸语", "Burmese"],
  ["nno_Latn", "挪威尼诺斯克语", "Norwegian Nynorsk"],
  ["nob_Latn", "挪威博克马尔语", "Norwegian Bokmål"],
  ["npi_Deva", "尼泊尔语", "Nepali"],
  ["nso_Latn", "北索托语", "Northern Sotho"],
  ["nus_Latn", "努尔语", "Nuer"],
  ["nya_Latn", "齐切瓦语", "Nyanja"],
  ["oci_Latn", "奥克语", "Occitan"],
  ["gaz_Latn", "奥罗莫语", "West Central Oromo"],
  ["ory_Orya", "奥里亚语", "Odia"],
  ["pag_Latn", "邦阿西楠语", "Pangasinan"],
  ["pan_Guru", "旁遮普语", "Eastern Panjabi"],
  ["pap_Latn", "帕皮阿门托语", "Papiamento"],
  ["prs_Arab", "达里语", "Dari"],
  ["pbt_Arab", "南普什图语", "Southern Pashto"],
  ["quy_Latn", "阿亚库乔克丘亚语", "Ayacucho Quechua"],
  ["ron_Latn", "罗马尼亚语", "Romanian"],
  ["run_Latn", "隆迪语", "Rundi"],
  ["sag_Latn", "桑戈语", "Sango"],
  ["san_Deva", "梵语", "Sanskrit"],
  ["sat_Olck", "桑塔利语", "Santali"],
  ["scn_Latn", "西西里语", "Sicilian"],
  ["shn_Mymr", "掸语", "Shan"],
  ["sin_Sinh", "僧伽罗语", "Sinhala"],
  ["slk_Latn", "斯洛伐克语", "Slovak"],
  ["slv_Latn", "斯洛文尼亚语", "Slovenian"],
  ["smo_Latn", "萨摩亚语", "Samoan"],
  ["sna_Latn", "绍纳语", "Shona"],
  ["snd_Arab", "信德语", "Sindhi"],
  ["som_Latn", "索马里语", "Somali"],
  ["sot_Latn", "南索托语", "Southern Sotho"],
  ["als_Latn", "阿尔巴尼亚语", "Tosk Albanian"],
  ["srd_Latn", "撒丁语", "Sardinian"],
  ["srp_Cyrl", "塞尔维亚语", "Serbian"],
  ["ssw_Latn", "斯瓦蒂语", "Swati"],
  ["sun_Latn", "巽他语", "Sundanese"],
  ["swh_Latn", "斯瓦希里语", "Swahili"],
  ["szl_Latn", "西里西亚语", "Silesian"],
  ["tam_Taml", "泰米尔语", "Tamil"],
  ["tat_Cyrl", "鞑靼语", "Tatar"],
  ["tel_Telu", "泰卢固语", "Telugu"],
  ["tgk_Cyrl", "塔吉克语", "Tajik"],
  ["tgl_Latn", "他加禄语", "Tagalog"],
  ["tir_Ethi", "提格利尼亚语", "Tigrinya"],
  ["taq_Latn", "塔马舍克语（拉丁文）", "Tamasheq (Latin)"],
  ["taq_Tfng", "塔马舍克语（提非纳文）", "Tamasheq (Tifinagh)"],
  ["tpi_Latn", "托克皮辛语", "Tok Pisin"],
  ["tsn_Latn", "茨瓦纳语", "Tswana"],
  ["tso_Latn", "聪加语", "Tsonga"],
  ["tuk_Latn", "土库曼语", "Turkmen"],
  ["tum_Latn", "通布卡语", "Tumbuka"],
  ["twi_Latn", "特威语", "Twi"],
  ["tzm_Tfng", "中阿特拉斯塔马塞特语", "Central Atlas Tamazight"],
  ["uig_Arab", "维吾尔语", "Uyghur"],
  ["umb_Latn", "姆本杜语", "Umbundu"],
  ["urd_Arab", "乌尔都语", "Urdu"],
  ["uzn_Latn", "乌兹别克语", "Uzbek"],
  ["vec_Latn", "威尼斯语", "Venetian"],
  ["war_Latn", "瓦莱语", "Waray"],
  ["wol_Latn", "沃洛夫语", "Wolof"],
  ["xho_Latn", "科萨语", "Xhosa"],
  ["ydd_Hebr", "意第绪语", "Eastern Yiddish"],
  ["yor_Latn", "约鲁巴语", "Yoruba"],
  ["yue_Hant", "粤语", "Cantonese"],
  ["zul_Latn", "祖鲁语", "Zulu"],
];

export const LANGS: [string, string][] = LANGS_FULL.map(([c, zh]) => [c, zh]);

const EN_BY_CODE = new Map(LANGS_FULL.map(([c, , en]) => [c, en]));

export function langLabel(code: string): string {
  return LANGS.find(([c]) => c === code)?.[1] ?? code;
}

/** 返回语言的英文名（喂给 LLM 提示词比 FLORES 码更可靠）；未知则原样返回 code。 */
export function langEnglish(code: string): string {
  return EN_BY_CODE.get(code) ?? code;
}

export function detectLang(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(text)) return "th";
  return "en";
}

export function resolveTarget(text: string, source: string, target: string): string {
  if (target && target !== "auto") return target;
  const src = source && source !== "auto" ? source : detectLang(text);
  return src === "zh" || src === "zh-Hant" ? "en" : "zh";
}

/** 两个语言码是否指同一门语言（中文简繁视为同一门，避免中→中空转） */
function sameLang(a: string, b: string): boolean {
  const norm = (x: string) => (x.startsWith("zh") ? "zh" : x);
  return norm(a) === norm(b);
}

/**
 * 解析这次翻译真正要用的「源语言 → 目标语言」。
 *
 * 开了「双向自动切换」后：文本本身就是目标语言时，反过来译回源语言
 * （设中→英，遇到英文就译成中文）。语言判定靠字符集，只能区分
 * 中/日/韩/俄/阿/泰/拉丁字母，同属拉丁字母的英↔法之类分不出，故对它们不生效。
 */
export function resolveLangPair(settings: Settings, text: string): { source: string; target: string } {
  const source = settings.sourceLang;
  const target = resolveTarget(text, source, settings.targetLang);
  if (!settings.autoSwap || !text.trim()) return { source, target };

  const detected = detectLang(text);
  if (!sameLang(detected, target)) return { source, target };
  // 文本已经是目标语言 → 掉头：源语言明确就译回源语言，否则中英互为对方
  const back = source && source !== "auto" ? source : detected === "zh" ? "en" : "zh";
  if (sameLang(back, detected)) return { source, target };
  return { source: detected, target: back };
}

let reqCounter = 1;

interface StreamHandlers {
  onDelta: (t: string) => void;
  onDone: (full: string) => void;
  onError: (msg: string) => void;
}

let handlersBound = false;
let active: { id: number; h: StreamHandlers } | null = null;

function bindOnce() {
  if (handlersBound) return;
  handlersBound = true;
  listen("llm:delta", (e) => {
    const p = e.payload as { id: number; text: string };
    if (active && p.id === active.id) active.h.onDelta(p.text);
  });
  listen("llm:done", (e) => {
    const p = e.payload as { id: number; full: string };
    if (active && p.id === active.id) {
      const h = active.h;
      active = null;
      h.onDone(stripThink(p.full));
    }
  });
  listen("llm:error", (e) => {
    const p = e.payload as { id: number; message: string };
    if (active && p.id === active.id) {
      const h = active.h;
      active = null;
      h.onError(p.message);
    }
  });
}

export function stripThink(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export async function llmStream(
  profile: ApiProfile,
  messages: { role: string; content: string }[],
  h: StreamHandlers,
  temperature = 0.2,
): Promise<number> {
  bindOnce();
  const id = reqCounter++;
  active = { id, h };
  await invoke("llm_stream", {
    reqId: id,
    req: {
      base_url: profile.baseUrl,
      api_key: profile.apiKey,
      model: profile.model,
      messages,
      temperature,
    },
  });
  return id;
}

export function cancelStreamUi() {
  active = null;
}

/**
 * 本地模型的流式翻译。后端发的是和在线 API 完全一样的 llm:delta / llm:done / llm:error，
 * 所以这里能直接复用上面那套监听和 StreamHandlers —— 调用方不用区分本地还是在线。
 *
 * 注意 NLLB / Opus 没有逐 token 这回事，后端会一次性补一个 done；对调用方无差别，
 * 只是看不到逐字效果。
 */
export async function localTranslateStream(
  settings: Settings,
  text: string,
  h: StreamHandlers,
  ocr = false,
): Promise<number> {
  bindOnce();
  const id = reqCounter++;
  active = { id, h };
  const { source, target } = resolveLangPair(settings, text);
  await invoke("local_translate_stream", {
    reqId: id,
    req: {
      backend: settings.local.mode,
      model: settings.local.selectedModel,
      text,
      sourceLang: source,
      targetLang: target,
      targetName: target !== "auto" ? langEnglish(target) : "",
      ocr,
      domainPrompt: activeDomainPrompt(settings),
    },
  });
  return id;
}

/** 本地模型的流式对话（F4）。协议同 {@link localTranslateStream}。 */
export async function localChatStream(
  settings: Settings,
  question: string,
  contextTitle: string,
  contextSource: string,
  contextTranslated: string,
  h: StreamHandlers,
): Promise<number> {
  bindOnce();
  const id = reqCounter++;
  active = { id, h };
  await invoke("local_chat_stream", {
    reqId: id,
    req: {
      backend: settings.local.mode,
      model: assistantModel(settings) || settings.local.selectedModel,
      question,
      contextTitle,
      contextSource,
      contextTranslated,
    },
  });
  return id;
}

/** 释放本地模型占用的内存（GGUF 权重缓存 + NLLB/Opus 的 bridge 子进程）。下次用会自动重载。 */
export async function localUnload(): Promise<{ gguf: number; bridge: boolean }> {
  return (await invoke("local_unload")) as { gguf: number; bridge: boolean };
}

export function translateMessages(text: string, targetLang: string, ocr = false, domain = "") {
  const langName = langEnglish(targetLang);
  let content =
    `You are a professional translator. Translate the user's text into ${langName}. ` +
    "Preserve meaning, tone and formatting. Output ONLY the translation, nothing else.";
  if (ocr) {
    content +=
      " The text was extracted via OCR and may contain minor recognition errors; " +
      "silently correct obvious errors from context before translating.";
  }
  if (domain.trim()) {
    content += ` Follow these additional requirements from the user (domain, terminology, style): ${domain.trim()}`;
  }
  content += " /no_think";
  return [
    { role: "system", content },
    { role: "user", content: text },
  ];
}

/**
 * 是否有能纠错的 LLM 后端：本地 GGUF（翻译模型本身，或单独指定的助手模型）
 * 或已配置的 API。NLLB/Opus 是专用翻译模型，无法纠错。
 */
export function ocrCorrectAvailable(settings: Settings): boolean {
  if (assistantModel(settings)) return true;
  if (localReady(settings)) return false;
  const p = activeProfile(settings);
  return Boolean(p.baseUrl && p.model);
}

/** OCR 原文纠错的 API 提示词：只修错字/去多余空格、保持原语言、不翻译。 */
export function ocrCorrectMessages(text: string) {
  return [
    {
      role: "system",
      content:
        "You are an OCR post-corrector. The user's text was extracted from a screenshot and may " +
        "contain recognition errors: wrong or split characters, missing characters, and spurious " +
        "spaces between characters. Fix obvious errors using context and remove the spurious spaces. " +
        "Keep the SAME language — do NOT translate. Preserve line breaks. Output ONLY the corrected " +
        "text, nothing else. /no_think",
    },
    { role: "user", content: text },
  ];
}

/** 本地 GGUF 纠错（非 qwen 后端由 Rust 原样返回）。用助手模型，可与翻译模型不同。 */
export async function localCorrectOcr(settings: Settings, text: string): Promise<string> {
  const res = (await invoke("local_correct", {
    req: { backend: "qwen", model: assistantModel(settings), text },
  })) as { text?: string };
  return (res.text ?? "").trim();
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function makeDropdown(
  items: [string, string][],
  value: string,
  onChange: (v: string) => void,
): { root: HTMLElement; set: (v: string) => void } {
  const root = el("div", "dd");
  const btn = el("button", "dd-btn");
  const label = el("span", "", items.find(([v]) => v === value)?.[1] ?? "");
  const chev = el("span", "chev", "▾");
  btn.append(label, chev);
  const menu = el("div", "dd-menu");
  root.append(btn, menu);

  let cur = value;

  function render() {
    menu.innerHTML = "";
    for (const [v, t] of items) {
      const it = el("div", "dd-item");
      const chk = el("span", "check", v === cur ? "✓" : "");
      it.append(chk, el("span", "", t));
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        cur = v;
        label.textContent = t;
        root.classList.remove("open");
        render();
        onChange(v);
      });
      menu.appendChild(it);
    }
  }
  render();

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".dd.open").forEach((d) => d !== root && d.classList.remove("open"));
    root.classList.toggle("open");
  });
  document.addEventListener("click", () => root.classList.remove("open"));

  return {
    root,
    set(v: string) {
      cur = v;
      label.textContent = items.find(([x]) => x === v)?.[1] ?? v;
      render();
    },
  };
}

export interface SearchItem {
  value: string; // 选项值（语言 code）
  label: string; // 主显示（中文名）
  sub?: string; // 副显示（英文名，弱化）
  search: string; // 预拼接的小写检索串（中文名+英文名+code）
}

/** 可搜索下拉：菜单顶部固定筛选框，支持中文/英文/code 搜索、上下键与回车选择。 */
export function makeSearchDropdown(
  items: SearchItem[],
  value: string,
  onChange: (v: string) => void,
): { root: HTMLElement; set: (v: string) => void } {
  const root = el("div", "dd dd-search");
  const btn = el("button", "dd-btn");
  const label = el("span", "", items.find((i) => i.value === value)?.label ?? value);
  const chev = el("span", "chev", "▾");
  btn.append(label, chev);
  const menu = el("div", "dd-menu");
  const filter = el("input", "dd-filter") as HTMLInputElement;
  filter.type = "text";
  filter.placeholder = "搜索语言…";
  filter.spellcheck = false;
  const head = el("div", "dd-head");
  head.appendChild(filter);
  const list = el("div", "dd-list");
  menu.append(head, list);
  menu.addEventListener("click", (e) => e.stopPropagation());
  root.append(btn, menu);

  let cur = value;
  let hl = 0; // 高亮项在可见列表中的下标
  let visible: SearchItem[] = items;

  function renderList() {
    const q = filter.value.trim().toLowerCase();
    visible = q ? items.filter((i) => i.search.includes(q)) : items;
    if (hl >= visible.length) hl = visible.length - 1;
    if (hl < 0) hl = 0;
    list.innerHTML = "";
    if (!visible.length) {
      list.appendChild(el("div", "dd-empty", "无匹配语言"));
      return;
    }
    visible.forEach((it, idx) => {
      const row = el("div", "dd-item" + (idx === hl ? " hl" : ""));
      const chk = el("span", "check", it.value === cur ? "✓" : "");
      const txt = el("span", "dd-text");
      txt.appendChild(el("span", "dd-name", it.label));
      if (it.sub) txt.appendChild(el("span", "dd-sub", it.sub));
      row.append(chk, txt);
      row.addEventListener("mousemove", () => {
        if (hl !== idx) {
          hl = idx;
          paintHl();
        }
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        pick(it);
      });
      list.appendChild(row);
    });
  }

  function paintHl() {
    const rows = list.querySelectorAll(".dd-item");
    rows.forEach((r, i) => r.classList.toggle("hl", i === hl));
    (rows[hl] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  function pick(it: SearchItem) {
    cur = it.value;
    label.textContent = it.label;
    close();
    onChange(it.value);
  }

  function open() {
    document.querySelectorAll(".dd.open").forEach((d) => d !== root && d.classList.remove("open"));
    root.classList.add("open");
    filter.value = "";
    visible = items;
    hl = Math.max(0, items.findIndex((i) => i.value === cur));
    renderList();
    paintHl();
    setTimeout(() => filter.focus(), 0);
  }

  function close() {
    root.classList.remove("open");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (root.classList.contains("open")) close();
    else open();
  });
  filter.addEventListener("click", (e) => e.stopPropagation());
  filter.addEventListener("input", () => {
    hl = 0;
    renderList();
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hl < visible.length - 1) {
        hl++;
        paintHl();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hl > 0) {
        hl--;
        paintHl();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible[hl]) pick(visible[hl]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  document.addEventListener("click", () => close());

  renderList();

  return {
    root,
    set(v: string) {
      cur = v;
      label.textContent = items.find((i) => i.value === v)?.label ?? v;
      renderList();
    },
  };
}

let toastEl: HTMLElement | null = null;
let toastTimer: number | undefined;
export function toast(msg: string, ok = true) {
  if (!toastEl) {
    toastEl = el("div", "toast");
    document.body.appendChild(toastEl);
  }
  toastEl.innerHTML = "";
  if (ok) toastEl.appendChild(el("span", "ok-ic", "✓"));
  toastEl.appendChild(el("span", "", msg));
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl!.classList.remove("show"), 1800);
}

export const ICONS = {
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  clear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  swap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13M13 3l4 4-4 4"/><path d="M20 17H7M11 21l-4-4 4-4"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  winMin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
  winMax: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
  winClose: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
};

/** 三个窗口控制按钮统一注入图标 */
export function mountWinControls() {
  const set = (id: string, icon: string) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icon;
  };
  set("tb-min", ICONS.winMin);
  set("tb-max", ICONS.winMax);
  set("tb-close", ICONS.winClose);
}

export function iconBtn(icon: string, title: string): HTMLButtonElement {
  const b = el("button", "iconbtn");
  b.title = title;
  b.innerHTML = icon;
  return b;
}
