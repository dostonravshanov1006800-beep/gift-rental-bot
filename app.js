"use strict";

/* ============================================================
 * CONFIG
 * ============================================================ */
const CONFIG = {
  botUsername: "free_rental_bot",
  appShortName: "gifts",
  profileKey: "gr_profile_v3",
  termsKey: "gr_terms_v3",
  favKey: "gr_fav_v3",
  scanToken: "8853140164:AAEgXsHJY-JjR3lPvJ2JBQjnW-goFebgzIU", // токен скан-бота @free_gifte_bot: только getUserGifts/getFile (утечка безвредна)
  verifyKey: {"kty":"EC","crv":"P-256","x":"GQ1mE9ZzXYcYxW6yLoBD3lzMYOpQd60ntJgUPdY7nLo","y":"5JBfRbOwbZD4bb1yEutCIQeFw3eB7inih9agTkGLs3g","key_ops":["verify"],"ext":true},
};
const PERIODS = ["час", "день", "неделя", "месяц"];
const CURRENCIES = ["UZS", "RUB", "USD", "USDT", "TON"];

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  try { tg.ready(); tg.expand(); tg.setHeaderColor && tg.setHeaderColor("#0e1015"); tg.setBackgroundColor && tg.setBackgroundColor("#0e1015"); } catch (e) {}
}

/* ============================================================
 * utils
 * ============================================================ */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
// эмодзи из имён подарков вычищаем на чтении: у regular-подарков оно дублирует стикер
const EMO = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const gname = (v) => String(v || "").replace(EMO, "").trim();
const dname = (g) => {
  const v = g.name != null ? g.name : g.n;
  return (g.p === "unique" || g.model || g.m) ? (gname(v) || "Подарок") : (String(v || "").trim() || "Подарок");
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastT = null;
function toast(m) { const el = $("#toast"); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3000); }
function haptic(k) { try { if (tg && tg.HapticFeedback) k === "ok" ? tg.HapticFeedback.notificationOccurred("success") : tg.HapticFeedback.selectionChanged(); } catch (e) {} }
const hex = (n) => (typeof n === "number" && !isNaN(n) ? "#" + n.toString(16).padStart(6, "0") : null);
const pct = (r) => (typeof r === "number" ? (r / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "");
function money(v) { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? String(v) : n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }); }
function numOf(v) { const n = parseFloat(String(v || "").replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; }

const b64e = (str) => { const b = new TextEncoder().encode(str); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const b64d = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); };
const b64bytes = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };

async function verifySig(payload, sig) {
  if (!window.crypto || !crypto.subtle) return "nocrypto";
  try {
    const k = await crypto.subtle.importKey("jwk", CONFIG.verifyKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, b64bytes(sig), new TextEncoder().encode(payload))) ? "valid" : "invalid";
  } catch (e) { return "nocrypto"; }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    try { const t = document.createElement("textarea"); t.value = text; t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); return true; } catch (e2) { return false; }
  }
}
function openTg(url) { if (tg && tg.openTelegramLink && url.startsWith("https://t.me/")) tg.openTelegramLink(url); else window.open(url, "_blank"); }

/* ---------- storage: CloudStorage + localStorage ---------- */
const csOK = () => !!(tg && tg.CloudStorage && typeof tg.CloudStorage.getItem === "function");
const csGet = (k) => new Promise((res) => { let d = false; const f = (v) => { if (!d) { d = true; res(v); } }; setTimeout(() => f(null), 2500); try { tg.CloudStorage.getItem(k, (e, v) => f(e ? null : v)); } catch (e) { f(null); } });
const csSet = (k, v) => new Promise((res) => { let d = false; const f = (x) => { if (!d) { d = true; res(x); } }; setTimeout(() => f(false), 2500); try { tg.CloudStorage.setItem(k, v, (e) => f(!e)); } catch (e) { f(false); } });
// ключи хранилища привязаны к uid: на Desktop/Web webview-хранилище общее для всех
// аккаунтов бота, без неймспейса второй юзер устройства видел бы чужой профиль
const skey = (key) => `${key}_${S && S.uid ? S.uid : "0"}`;
async function load(key, dflt) {
  const k = skey(key);
  let raw = csOK() ? await csGet(k) : null;
  if (!raw) raw = localStorage.getItem(k);
  try { const d = raw ? JSON.parse(raw) : null; if (d && typeof d === "object") return d; } catch (e) {}
  return dflt;
}
const timers = {};
function save(key, obj) {
  const k = skey(key);
  clearTimeout(timers[k]);
  timers[k] = setTimeout(async () => {
    const raw = JSON.stringify(obj);
    try { localStorage.setItem(k, raw); } catch (e) {}
    if (csOK()) await csSet(k, raw);
  }, 350);
}

/* ============================================================
 * state
 * ============================================================ */
// пользователь: SDK -> initData -> хэш URL (#tgWebAppData) -> sessionStorage. SDK может не успеть загрузиться.
function parseTgUser() {
  const fromQS = (qs) => { try { const u = new URLSearchParams(qs).get("user"); return u ? JSON.parse(u) : null; } catch (e) { return null; } };
  let u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (!u && tg && tg.initData) u = fromQS(tg.initData);
  if (!u) {
    try { const h = new URLSearchParams(location.hash.replace(/^#/, "")).get("tgWebAppData"); if (h) u = fromQS(h); } catch (e) {}
  }
  try {
    if (u && u.id) sessionStorage.setItem("gr_tguser", JSON.stringify(u));
    else { const s = sessionStorage.getItem("gr_tguser"); if (s) u = JSON.parse(s); }
  } catch (e) {}
  return u && u.id ? u : null;
}
const tgUser = parseTgUser() || (function () {
  try {
    const qu = new URLSearchParams(location.search).get("u");
    if (qu && /^\d{5,14}$/.test(qu)) return { id: Number(qu), first_name: "", username: "" };
    const ls = localStorage.getItem("gr_lastuser"); if (ls) { const o = JSON.parse(ls); if (o && o.id) return o; }
  } catch (e) {}
  return null;
})();
// SDK в вебвью (особенно Android, запуск с menu button) иногда отдаёт initData с задержкой:
// пересчитываем пользователя в любой момент, а не один раз на загрузке модуля
function getTg() { return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null; }
function parseTgUserLive() {
  const w = getTg();
  const fromQS = (qs) => { try { const u = new URLSearchParams(qs).get("user"); return u ? JSON.parse(u) : null; } catch (e) { return null; } };
  let u = w && w.initDataUnsafe && w.initDataUnsafe.user;
  if (!u && w && w.initData) u = fromQS(w.initData);
  if (!u) { try { const h = new URLSearchParams(location.hash.replace(/^#/, "")).get("tgWebAppData"); if (h) u = fromQS(h); } catch (e) {} }
  if (!u) { try { const q = new URLSearchParams(location.search).get("tgWebAppData"); if (q) u = fromQS(q); } catch (e) {} }
  if (!u) { try { const s = sessionStorage.getItem("gr_tguser"); if (s) u = JSON.parse(s); } catch (e) {} }
  if (u && u.id) { try { sessionStorage.setItem("gr_tguser", JSON.stringify(u)); localStorage.setItem("gr_lastuser", JSON.stringify({ id: u.id, first_name: u.first_name || "", username: u.username || "", photo_url: u.photo_url || "" })); } catch (e) {} return u; }
  // нет данных от Telegram (запуск по прямой ссылке / старый вебвью): uid из персональной кнопки бота (?u=) или запомненный на устройстве
  try {
    const qu = new URLSearchParams(location.search).get("u");
    if (qu && /^\d{5,14}$/.test(qu)) { const o = { id: Number(qu), first_name: "", username: "" }; localStorage.setItem("gr_lastuser", JSON.stringify(o)); return o; }
    const ls = localStorage.getItem("gr_lastuser"); if (ls) { const o = JSON.parse(ls); if (o && o.id) return o; }
  } catch (e) {}
  return null;
}
const S = {
  tab: "market",
  lang: (function () { try { return localStorage.getItem("gr_lang") || "ru"; } catch (e) { return "ru"; } })(),
  theme: (function () { try { return localStorage.getItem("gr_theme") || "auto"; } catch (e) { return "auto"; } })(),
  uid: tgUser ? String(tgUser.id) : "0",
  user: tgUser,
  profile: { name: "", about: "", uname: "", sell: "", sellCur: "UZS", req: [] },
  terms: {},          // gid -> {p, cur, per, on}
  fav: {},            // key -> true
  catalog: null,      // [{...gift, owner}]
  myGifts: null,      // "pending" | []
  orders: null,       // incoming
  myOrders: null,     // outgoing
  ordersSeg: "in",
  q: "", cur: "all", sort: "new",
  showcase: null, payload: null, sig: null,
};
const gkey = (g) => (g.owner ? g.owner.uid : S.uid) + ":" + g.g;

/* ============================================================
 * data
 * ============================================================ */
const RAW = "https://raw.githubusercontent.com/dostonravshanov1006800-beep/gift-rental-bot/main/";
async function getJSON(path) {
  const bust = path + "?t=" + Date.now();
  // 1) живой коммит в репо: доступен через ~2с, без ожидания деплоя Pages
  try {
    const r = await fetch(RAW + bust, { cache: "no-store" });
    if (r.status === 404) return "404";
    if (r.ok) return await r.json();
  } catch (e) {}
  // 2) фолбэк: Pages-версия (отстаёт на ~минуту)
  try {
    const r = await fetch(bust, { cache: "no-store" });
    if (r.status === 404) return "404";
    if (r.ok) return await r.json();
  } catch (e) {}
  return null;
}
async function loadCatalog() { const d = await getJSON("data/catalog.json"); S.catalog = d && d !== "404" ? d.items || [] : []; }
async function loadMine() {
  if (S.uid === "0") { S.myGifts = []; return; }
  getJSON("data/heartbeat.json").then((hb) => { if (hb && hb !== "404" && hb.ts) { S.hb = hb.ts; drawScanState(); } });
  const d = await getJSON(`data/gifts/${S.uid}.json`);
  S.myGifts = d === "404" ? "pending" : d ? d.gifts || [] : [];
  S.myGiftsUpd = d && d !== "404" ? d.updated || 0 : 0;
}
async function loadOrders() {
  if (S.uid === "0") { S.orders = []; S.myOrders = []; return; }
  const a = await getJSON(`data/orders/${S.uid}.json`); S.orders = a && a !== "404" ? a.orders || [] : [];
  const b = await getJSON(`data/my_orders/${S.uid}.json`); S.myOrders = b && b !== "404" ? b.orders || [] : [];
  const seen = Number(localStorage.getItem("gr_seen_" + S.uid) || 0);
  const fresh = S.orders.filter((o) => o.status === "new" && o.ts > seen).length;
  $("#ordersDot").hidden = !fresh;
}

/* ============================================================
 * shell: tabs
 * ============================================================ */

/* ============================
 * I18N: RU / EN / UZ + тема
 * ============================ */
const I18N = {
  ru: { tab_market:"Аренда", tab_fav:"Избранное", tab_orders:"Заказы", tab_profile:"Профиль",
    h_fav:"Избранное", h_orders:"Заказы", h_showcase:"Витрина", h_profile:"Профиль",
    b_publish:"Опубликовать", b_add:"Сдать подарок", b_refresh:"Обновить", b_order:"Заказать аренду",
    b_done:"Выполнен", b_cancel:"Отмена", b_write:"Написать", b_edit:"Редактировать", b_share:"Моя витрина",
    b_copy:"Копировать", b_retry:"Повторить", b_about:"О сервисе и условиях", b_nft:"Открыть NFT", b_remove:"Снять",
    b_addreq:"+ Добавить реквизит", b_agree:"Принимаю условия",
    st_req:"Реквизиты для оплаты", st_rent:"Сдать подарок в аренду", st_faq:"Частые вопросы (FAQ)", st_settings:"Настройки",
    s_theme:"Тема", s_lang:"Язык", s_auto:"Авто", s_dark:"Тёмная", s_light:"Светлая",
    e_fav:"Пусто", e_fav2:"Нажми на сердечко на карточке подарка.",
    e_nothing:"Ничего не найдено", e_nocat:"Пока нет подарков в аренде", e_noorders:"Заказов нет",
    e_noorders_in:"Когда клиент закажет подарок, бот пришлёт уведомление, а заказ появится здесь.",
    e_noorders_out:"Твои заказы на аренду появятся здесь.", e_login:"Нужен вход через бота",
    e_nogifts:"В профиле Telegram нет подарков", e_notfound:"Подарки не найдены", e_scan:"Подключи сканер один раз",
    e_showcase:"Витрина не найдена",
    p_gifts:"подарков", p_rent:"в аренде", p_done:"сдач", p_noid:"не определён", p_user:"Пользователь",
    scan_now:"Сканировано сейчас", scan_ago:"{n} с назад", scan_sync:"Профиль синхронизируется автоматически",
    scan_boot:"Бот сейчас перезапускается, данные обновятся через минуту", scan_scan:"Сканирую профиль Telegram…",
    f_search:"Поиск подарков и арендодателей", c_cheaper:"Дешевле", c_pricier:"Дороже", f_all:"Все",
    e_mkt_q:"Измени поиск или фильтры.", e_mkt_nocat:"Арендодатели публикуют подарки в разделе «Профиль».",
    hint_orders:"Кнопки «Выполнен» и «Отмена» копируют команду: отправь её боту.",
    e_gifts2:"Бот проверил твой профиль только что: подарков нет. Получишь подарок, он появится здесь сам через пару секунд.",
    e_gifts3:"Скрыты подарки? Открой Telegram → Профиль → Подарки и сделай их видимыми.",
    e_nf2:"Профиль подключён и синхронизируется автоматически: как только в Telegram появится подарок, он возникнет здесь сам.",
    e_scan2:"Это нужно сделать единожды: дальше профиль обновляется сам, без вопросов.", b_scan:"Подключить (1 раз)",
    h_edit:"Редактировать профиль", st_cta:"Частые вопросы (FAQ)",
    f_price:"Цена", f_comment:"Комментарий (срок, вопросы)", f_ph:"Например: на 3 дня", f_owner:"Арендодатель", f_mine:"Это твой подарок.",
    f_negotiable:"Цена по договорённости", f_stars:"в профиле", f_type:"Тип", f_nft:"Уникальный NFT", f_reg:"Обычный подарок",
    f_model:"Модель", f_sym:"Символ", f_back:"Фон", f_stars:"Звёзды",
    t_login:"Нужен вход через бота", t_openlogin:"Открываю бота для входа…", t_copied:"Скопировано",
    t_idcopied:"ID скопирован", t_saved:"Сохранено", t_ordersend:"Заказ отправляется…", t_ordcopy:"Заказ скопирован. Вставь его в чат бота и отправь.",
    t_ordcopyfail:"Не удалось скопировать заказ. Попробуй ещё раз.", t_ordeep:"Откроется бот: нажми кнопку «Маркет» внизу — заказ дойдёт сам.",
    t_ordeep2:"Доставляю твой заказ…", t_refresh:"Обновлено", t_cmdcopy:"Команда скопирована. Отправь её боту.",
    t_pubfinish:"Завершаю публикацию…", t_recovered:"Данные восстановлены из каталога", t_pubnone:"Включи хотя бы один подарок",
    t_pubsame:"Уже опубликовано", t_pubsent:"Публикую…",
    t_pubdeep:"Откроется бот: нажми «Сдать подарок» внизу — публикация завершится сама.",
    t_pubdeep2:"Откроется бот: нажми «Сдать подарок» внизу (публикация сама завершится). Или вставь скопированное и отправь.",
    t_pubfail:"Не удалось отправить. Нажми «Сдать подарок» внизу в чате бота и попробуй снова.",
    t_agreed:"Спасибо! Условия приняты", t_nopub:"Сначала опубликуй подарки в каталог",
    t_showcase:"Ссылка на твою витрину скопирована",
    hint_rent:"Включи переключатель, укажи цену и срок. Бот сверит подарки с твоим профилем, публикация мгновенная.",
    hint_rent2:"Включи подарки, укажи цену и нажми «Опубликовать»",
    seg_in:"Входящие · {n}", seg_out:"Мои · {n}", or_client:"Клиент:", or_owner:"Арендодатель:", o_new:"новый", o_done:"выполнен", o_cancelled:"отменён",
    st_rented:"в аренде", st_not:"не в аренде",
    req_l:"Карта UZ", req_v:"Номер / кошелёк",
    ab_service:"О сервисе", ab_terms:"Условия использования", ab_founded:"Основатель", ab_faqimg:"фото-инструкция", f_stars_p:"в профиле",
    _:0 },
  en: { tab_market:"Rent", tab_fav:"Favorites", tab_orders:"Orders", tab_profile:"Profile",
    h_fav:"Favorites", h_orders:"Orders", h_showcase:"Showcase", h_profile:"Profile",
    b_publish:"Publish", b_add:"Rent out a gift", b_refresh:"Refresh", b_order:"Rent this gift",
    b_done:"Done", b_cancel:"Cancel", b_write:"Message", b_edit:"Edit", b_share:"My showcase",
    b_copy:"Copy", b_retry:"Retry", b_about:"About & Terms", b_nft:"Open NFT", b_remove:"Unlist",
    b_addreq:"+ Add payment details", b_agree:"I accept the terms",
    st_req:"Payment details", st_rent:"Rent out a gift", st_faq:"FAQ", st_settings:"Settings",
    s_theme:"Theme", s_lang:"Language", s_auto:"Auto", s_dark:"Dark", s_light:"Light",
    e_fav:"Empty", e_fav2:"Tap the heart on a gift card.",
    e_nothing:"Nothing found", e_nocat:"No gifts for rent yet", e_noorders:"No orders",
    e_noorders_in:"When a client orders a gift, the bot will notify you and the order appears here.",
    e_noorders_out:"Your rental orders will appear here.", e_login:"Sign in via the bot",
    e_nogifts:"No gifts in your Telegram profile", e_notfound:"Gifts not found", e_scan:"Connect the scanner once",
    e_showcase:"Showcase not found",
    p_gifts:"gifts", p_rent:"listed", p_done:"rented", p_noid:"unknown", p_user:"User",
    scan_now:"Scanned just now", scan_ago:"{n} s ago", scan_sync:"Profile syncs automatically",
    scan_boot:"The bot is restarting, data refreshes in a minute", scan_scan:"Scanning your Telegram profile…",
    f_search:"Search gifts and owners", c_cheaper:"Cheaper", c_pricier:"Pricier", f_all:"All",
    e_mkt_q:"Change the search or filters.", e_mkt_nocat:"Owners publish gifts in the «Profile» section.",
    hint_orders:"«Done» and «Cancel» copy a command: send it to the bot.",
    e_gifts2:"The bot just checked your profile: no gifts. Once you receive one, it appears here in seconds.",
    e_gifts3:"Gifts hidden? Open Telegram → Profile → Gifts and make them visible.",
    e_nf2:"Your profile is connected and syncs automatically: once a gift appears on Telegram it shows up here by itself.",
    e_scan2:"You only do this once: after that the profile updates by itself.", b_scan:"Connect (once)",
    h_edit:"Edit profile", st_cta:"FAQ",
    f_price:"Price", f_comment:"Comment (dates, questions)", f_ph:"E.g.: for 3 days", f_owner:"Owner", f_mine:"This is your own gift.",
    f_negotiable:"Price by agreement", f_stars:"in profile", f_type:"Type", f_nft:"Unique NFT", f_reg:"Regular gift",
    f_model:"Model", f_sym:"Symbol", f_back:"Backdrop", f_stars:"Stars",
    t_login:"Sign in via the bot", t_openlogin:"Opening the bot…", t_copied:"Copied",
    t_idcopied:"ID copied", t_saved:"Saved", t_ordersend:"Sending your order…", t_ordcopy:"Order copied. Paste it in the bot chat and send.",
    t_ordcopyfail:"Could not copy the order. Try again.", t_ordeep:"The bot will open: tap «Rent» at the bottom — the order will arrive itself.",
    t_ordeep2:"Delivering your order…", t_refresh:"Updated", t_cmdcopy:"Command copied. Send it to the bot.",
    t_pubfinish:"Finishing publication…", t_recovered:"Data restored from the catalog", t_pubnone:"Enable at least one gift",
    t_pubsame:"Already published", t_pubsent:"Publishing…",
    t_pubdeep:"The bot will open: tap «Rent out» at the bottom — publication finishes itself.",
    t_pubdeep2:"The bot will open: tap «Rent out» at the bottom (publication finishes itself). Or paste the copied text.",
    t_pubfail:"Could not send. Tap «Rent out» at the bottom of the bot chat and try again.",
    t_agreed:"Thanks! Terms accepted", t_nopub:"Publish your gifts to the catalog first",
    t_showcase:"Your showcase link copied",
    hint_rent:"Toggle a gift on, set the price and period. The bot checks gifts against your profile, publishing is instant.",
    hint_rent2:"Enable gifts, set a price and tap «Publish»",
    seg_in:"Incoming · {n}", seg_out:"Mine · {n}", or_client:"Client:", or_owner:"Owner:", o_new:"new", o_done:"done", o_cancelled:"cancelled",
    st_rented:"listed", st_not:"not listed",
    req_l:"Card UZ", req_v:"Number / wallet",
    ab_service:"About", ab_terms:"Terms of use", ab_founded:"Founder", ab_faqimg:"guide photo", f_stars_p:"in profile",
    _:0 },
  uz: { tab_market:"Ijara", tab_fav:"Sevimlilar", tab_orders:"Buyurtmalar", tab_profile:"Profil",
    h_fav:"Sevimlilar", h_orders:"Buyurtmalar", h_showcase:"Vitrina", h_profile:"Profil",
    b_publish:"Chiqarish", b_add:"Sovg'a ijaraga", b_refresh:"Yangilash", b_order:"Ijaraga olish",
    b_done:"Bajarildi", b_cancel:"Bekor", b_write:"Yozish", b_edit:"Tahrirlash", b_share:"Mening vitrinam",
    b_copy:"Nusxa", b_retry:"Qayta", b_about:"Xizmat va shartlar", b_nft:"NFT ochish", b_remove:"O'chirish",
    b_addreq:"+ To'lov ma'lumot qo'shish", b_agree:"Shartlarni qabul qilaman",
    st_req:"To'lov ma'lumotlari", st_rent:"Sovg'a ijaraga berish", st_faq:"Ko'p so'raladigan savollar", st_settings:"Sozlamalar",
    s_theme:"Mavzu", s_lang:"Til", s_auto:"Avto", s_dark:"Tungi", s_light:"Yorug'",
    e_fav:"Bo'sh", e_fav2:"Sovg'a kartasidagi yurakchani bosing.",
    e_nothing:"Hech narsa topilmadi", e_nocat:"Hozircha ijara sovg'asi yo'q", e_noorders:"Buyurtma yo'q",
    e_noorders_in:"Mijoz sovg'a buyurtma qilsa, bot xabar beradi va buyurtma shu yerda paydo bo'ladi.",
    e_noorders_out:"Ijara buyurtmalaringiz shu yerda ko'rinadi.", e_login:"Bot orqali kirish kerak",
    e_nogifts:"Telegram profilingizda sovg'a yo'q", e_notfound:"Sovg'a topilmadi", e_scan:"Skanerni bir marta ulang",
    e_showcase:"Vitrina topilmadi",
    p_gifts:"sovg'a", p_rent:"ijarada", p_done:"ijara", p_noid:"aniqlanmagan", p_user:"Foydalanuvchi",
    scan_now:"Hozir skaner qilindi", scan_ago:"{n} s oldin", scan_sync:"Profil avtomatik sinxronlanadi",
    scan_boot:"Bot qayta ishga tushmoqda, ma'lumot bir daqiqada yangilanadi", scan_scan:"Telegram profilingiz skaner qilinmoqda…",
    f_search:"Sovg'a va ijara beruvchilarni qidirish", c_cheaper:"Arzon", c_pricier:"Qimmat", f_all:"Barchasi",
    e_mkt_q:"Qidiruv yoki filtrlarni o'zgartiring.", e_mkt_nocat:"Ijara beruvchilar sovg'alarni «Profil» bo'limida chiqaradi.",
    hint_orders:"«Bajarildi» va «Bekor» buyruqni nusxalaydi: uni botga yuboring.",
    e_gifts2:"Bot profilingizni hozir tekshirdi: sovg'a yo'q. Sovg'a olsangiz, bir necha soniyada shu yerda paydo bo'ladi.",
    e_gifts3:"Sovg'alar yashirinmi? Telegram → Profil → Sovg'alar ni oching va ko'rinishiga o'tkazing.",
    e_nf2:"Profil ulangan va avtomatik sinxronlanadi: Telegramda sovg'a paydo bo'lsa, o'zi shu yerda chiqadi.",
    e_scan2:"Buni bir marta qilasiz: keyin profil o'zi yangilanadi.", b_scan:"Ulash (1 marta)",
    h_edit:"Profilni tahrirlash", st_cta:"Ko'p so'raladigan savollar",
    f_price:"Narx", f_comment:"Izoh (muddat, savollar)", f_ph:"Masalan: 3 kunga", f_owner:"Ijara beruvchi", f_mine:"Bu sizning sovg'angiz.",
    f_negotiable:"Narx kelishuv bo'yicha", f_stars:"profilda", f_type:"Turi", f_nft:"Nodavviy NFT", f_reg:"Oddiy sovg'a",
    f_model:"Model", f_sym:"Belgi", f_back:"Fon", f_stars:"Yulduzlar",
    t_login:"Bot orqali kirish kerak", t_openlogin:"Bot ochilmoqda…", t_copied:"Nusxalandi",
    t_idcopied:"ID nusxalandi", t_saved:"Saqlandi", t_ordersend:"Buyurtma yuborilmoqda…", t_ordcopy:"Buyurtma nusxalandi. Bot chatiga qo'yib yuboring.",
    t_ordcopyfail:"Buyurtmani nusxalash imkonsiz. Yana urinib ko'ring.", t_ordeep:"Bot ochiladi: pastdagi «Ijara» tugmasini bosing — buyurtma o'zi yetib boradi.",
    t_ordeep2:"Buyurtmangiz yetkazilmoqda…", t_refresh:"Yangilandi", t_cmdcopy:"Buyruq nusxalandi. Botga yuboring.",
    t_pubfinish:"Nashr yakunlanmoqda…", t_recovered:"Ma'lumot katalogdan tiklandi", t_pubnone:"Kamida bitta sovg'ani yoqing",
    t_pubsame:"Allaqachon chiqarilgan", t_pubsent:"Chiqarilmoqda…",
    t_pubdeep:"Bot ochiladi: pastdagi «Sovg'a ijaraga» tugmasini bosing — nashr o'zi tugaydi.",
    t_pubdeep2:"Bot ochiladi: pastdagi «Sovg'a ijaraga» tugmasini bosing. Yoki nusxalangan matnni qo'ying.",
    t_pubfail:"Yuborilmadi. Bot chatida pastdagi «Sovg'a ijaraga» tugmasini bosib qayta urinib ko'ring.",
    t_agreed:"Rahmat! Shartlar qabul qilindi", t_nopub:"Avval sovg'alarni katalogga chiqaring",
    t_showcase:"Vitrina havolangiz nusxalandi",
    hint_rent:"Tugmani yoqing, narx va muddatni belgilang. Bot sovg'alarni profilingiz bilan tekshiradi, nashr bir zumda.",
    hint_rent2:"Sovg'alarni yoqing, narx belgilang va «Chiqarish»ni bosing",
    seg_in:"Kiruvchi · {n}", seg_out:"Mening · {n}", or_client:"Mijoz:", or_owner:"Ijara beruvchi:", o_new:"yangi", o_done:"bajarildi", o_cancelled:"bekor qilindi",
    st_rented:"ijarada", st_not:"ijarada emas",
    req_l:"Karta UZ", req_v:"Raqam / hamyon",
    ab_service:"Xizmat haqida", ab_terms:"Foydalanish shartlari", ab_founded:"Asoschi", ab_faqimg:"ko'rsatma rasmi", f_stars_p:"profilda",
    _:0 }
};
function t(k, vars) {
  let s = (I18N[S.lang] && I18N[S.lang][k]) || I18N.ru[k] || k;
  if (vars) for (const v of Object.keys(vars)) s = s.replace("{" + v + "}", vars[v]);
  return s;
}
function setLang(l) {
  S.lang = I18N[l] ? l : "ru";
  try { localStorage.setItem("gr_lang", S.lang); } catch (e) {}
  try { tg && tg.CloudStorage && tg.CloudStorage.setItem("lang", S.lang); } catch (e) {}
  try { document.documentElement.setAttribute("lang", S.lang); } catch (e) {}
  $$("[data-i18n]").forEach((el) => { const v = I18N[S.lang][el.dataset.i18n] || I18N.ru[el.dataset.i18n]; if (v) el.textContent = v; });
}
function applyTheme() {
  const eff = S.theme === "auto" ? (tg && tg.colorScheme === "light" ? "light" : "dark") : (S.theme || "dark");
  document.documentElement.classList.toggle("light", eff === "light");
  try { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", eff === "light" ? "#f2f4f8" : "#0e1015"); } catch (e) {}
}
function setTheme(th) {
  S.theme = ["auto", "dark", "light"].includes(th) ? th : "auto";
  try { localStorage.setItem("gr_theme", S.theme); } catch (e) {}
  try { tg && tg.CloudStorage && tg.CloudStorage.setItem("theme", S.theme); } catch (e) {}
  applyTheme();
}

// восстановить язык/тему из облака Telegram (если localStorage очищен) и применить
try { tg && tg.CloudStorage && tg.CloudStorage.getItem("lang", (e, v) => { if (!e && I18N[v]) { S.lang = v; try { localStorage.setItem("gr_lang", v); } catch (x) {} setLang(v); render(); } }); } catch (e) {}
try { tg && tg.CloudStorage && tg.CloudStorage.getItem("theme", (e, v) => { if (!e && v) { S.theme = v; try { localStorage.setItem("gr_theme", v); } catch (x) {} applyTheme(); } }); } catch (e) {}
try { tg && tg.onEvent && tg.onEvent("themeChanged", applyTheme); } catch (e) {}
applyTheme(); setLang(S.lang);

const _mParam = new URLSearchParams(location.search).get("m") || "";
const _pubMode = _mParam === "pub";
// sendData реально доставляет ТОЛЬКО вход с reply-кнопки (низ чата). Вход с menu-кнопки слева
// (src=menu) эквивалентен inline-открытию: sendData там НЕ доставляется и заказ ушёл бы в никуда.
const _fromMenu = new URLSearchParams(location.search).get("src") === "menu";
const _kbMode = !_fromMenu && ["pub", "mkt", "m"].includes(_mParam);

function openAddRent() {
  if (S.uid === "0") { toast(t("t_login")); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=login`), 400); return; }
  setTab("profile");
  requestAnimationFrame(() => { const m = $("#mine"); if (m) m.scrollIntoView({ behavior: "smooth", block: "start" }); });
  toast(t("hint_rent2"));
}

function setTab(t) {
  S.tab = t;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  render();
  window.scrollTo(0, 0);
  const fab = $("#gadd"); if (fab) fab.hidden = !(t === "market" && !S.viewShowcase);
  drawPubBar();
}
function render() {
  if (S.showcase && S.tab === "market" && S.viewShowcase) return renderShowcase();
  ({ market: renderMarket, fav: renderFav, orders: renderOrders, profile: renderProfile }[S.tab])();
}

/* ============================================================
 * gift card (цены внизу, ровная сетка)
 * ============================================================ */
function card(g, i) {
  const c1 = hex(g.cc) || "#5aa7e0", c2 = hex(g.ec) || "#2b3f66";
  const fav = S.fav[gkey(g)];
  const price = g.p
    ? `<div class="gprice">${esc(money(g.p))} <small>${esc(g.cur || "")} / ${esc(g.per || "")}</small></div>`
    : `<div class="gprice dim">по договорённости</div>`;
  return `<div class="gcard" data-i="${i}">
    <div class="gcanvas" style="--c1:${c1};--c2:${c2}">
      ${g.t ? `<img src="${esc(g.t)}" alt="" loading="lazy" onerror="this.remove()">` : `<span style="font-size:40px">🎁</span>`}
      ${g.num != null ? `<div class="gnum">#${esc(g.num)}</div>` : ""}
      <button class="gheart ${fav ? "on" : ""}" data-fav="${i}" aria-label="В избранное"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/></svg></button>
    </div>
    <div class="ginfo">
      <div class="gname">${esc(dname(g))}</div>
      <div class="gattr">${esc(g.m || "")}${g.s ? " · " + esc(g.s) : ""}</div>
      ${price}
    </div>
  </div>`;
}

function bindCards(list, root) {
  $$(".gcard", root).forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-fav]")) return;
    openDetail(list[+el.dataset.i]);
  }));
  $$("[data-fav]", root).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const g = list[+b.dataset.fav]; const k = gkey(g);
    if (S.fav[k]) delete S.fav[k]; else S.fav[k] = { ...g };
    save(CONFIG.favKey, S.fav); haptic();
    b.classList.toggle("on", !!S.fav[k]);
    if (S.tab === "fav") renderFav();
  }));
}

/* ============================================================
 * MARKET (главная аренда)
 * ============================================================ */
function marketList() {
  let l = (S.catalog || []).slice();
  const q = S.q.trim().toLowerCase();
  if (q) l = l.filter((g) => [g.n, g.m, g.s, g.num, g.owner && g.owner.name, g.owner && g.owner.uname].some((v) => v != null && String(v).toLowerCase().includes(q)));
  if (S.cur !== "all") l = l.filter((g) => g.cur === S.cur);
  if (S.sort === "asc") l.sort((a, b) => (numOf(a.p) ?? 1e18) - (numOf(b.p) ?? 1e18));
  if (S.sort === "desc") l.sort((a, b) => (numOf(b.p) ?? -1) - (numOf(a.p) ?? -1));
  return l;
}

function renderMarket() {
  $("#topbar").innerHTML = `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="q" type="search" placeholder="${t("f_search")}" value="${esc(S.q)}"></div>`;
  const curs = ["all", ...CURRENCIES];
  $("#view").innerHTML = `
    <div class="chips">
      ${curs.map((c) => `<button class="chip ${S.cur === c ? "on" : ""}" data-cur="${c}">${c === "all" ? "Все" : c}</button>`).join("")}
      <button class="chip ${S.sort === "asc" ? "on" : ""}" data-sort="asc">${t("c_cheaper")}</button>
      <button class="chip ${S.sort === "desc" ? "on" : ""}" data-sort="desc">${t("c_pricier")}</button>
    </div>
    <div id="grid"></div>`;
  $("#q").addEventListener("input", (e) => { S.q = e.target.value; drawGrid(); });
  $$("[data-cur]").forEach((b) => b.addEventListener("click", () => { S.cur = b.dataset.cur; renderMarket(); }));
  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => { S.sort = S.sort === b.dataset.sort ? "new" : b.dataset.sort; renderMarket(); }));
  drawGrid();
}
function drawGrid() {
  const box = $("#grid"); if (!box) return;
  if (S.catalog === null) { box.innerHTML = `<div class="grid">${Array(6).fill(`<div class="gcard"><div class="gcanvas skeleton"></div><div class="ginfo"><div class="skeleton" style="height:12px;border-radius:6px"></div></div></div>`).join("")}</div>`; return; }
  const l = marketList();
  if (!l.length) {
    box.innerHTML = `<div class="empty"><b>${S.catalog.length ? t("e_nothing") : t("e_nocat")}</b>${S.catalog.length ? t("e_mkt_q") : t("e_mkt_nocat")}</div>`;
    return;
  }
  box.innerHTML = `<div class="grid">${l.map(card).join("")}</div>`;
  bindCards(l, box);
}

/* ============================================================
 * FAVORITES
 * ============================================================ */
function renderFav() {
  $("#topbar").innerHTML = `<h1>${t("h_fav")}</h1>`;
  const l = Object.values(S.fav);
  if (!l.length) { $("#view").innerHTML = `<div class="empty"><b>${t("e_fav")}</b>${t("e_fav2")}</div>`; return; }
  $("#view").innerHTML = `<div class="grid">${l.map(card).join("")}</div>`;
  bindCards(l, $("#view"));
}

/* ============================================================
 * DETAIL + ORDER
 * ============================================================ */
function openDetail(g) {
  haptic();
  const c1 = hex(g.cc) || "#5aa7e0", c2 = hex(g.ec) || "#2b3f66";
  const o = g.owner || { uid: S.showcase ? S.showcase.uid : "", name: S.showcase ? S.showcase.name : "", uname: S.showcase ? S.showcase.uname : "" };
  const mine = String(o.uid) === S.uid;
  const rows = [[t("f_model"), g.m, g.mr], [t("f_sym"), g.s, g.sr], [t("f_back"), g.b || "", g.br]].filter((r) => r[1]);
  const isNft = g.num != null || !!(g.m || g.s || g.b);
  // тип подарка: NFT — уникальный (модель/узор/фон/номер/ссылка), обычный — просто эмодзи со звёздами
  const typeChip = `<div class="dchip ${isNft ? "nft" : "reg"}"><span>${t("f_type")}</span><b>${isNft ? t("f_nft") : t("f_reg")}</b></div>`;
  const starsChip = !isNft && g.stars ? `<div class="dchip"><span>${t("f_stars")}</span><b>${esc(g.stars)} ★</b></div>` : "";
  $("#sheet").innerHTML = `
    <div class="sheet-h"><span>${esc(g.dn || dname(g))}${g.num != null ? " #" + esc(g.num) : ""}</span><button class="sheet-x" id="x">×</button></div>
    <div class="dcanvas" style="--c1:${c1};--c2:${c2}">${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : "🎁"}</div>
    <div class="dchips">${typeChip}${starsChip}${rows.map((r) => `<div class="dchip"><span>${r[0]}</span><b>${esc(r[1])}</b>${r[2] ? `<i>${pct(r[2])}</i>` : ""}</div>`).join("")}</div>
    <div class="dprice">${g.p ? `${esc(money(g.p))} ${esc(g.cur || "")} <small>/ ${esc(g.per || "")}</small>` : g.stars ? `${esc(g.stars)} <small>★ ${t("f_stars_p")}</small>` : `<small>${t("f_negotiable")}</small>`}</div>
    <div class="owner"><div class="oav">${esc((o.name || o.uname || "?").slice(0, 1).toUpperCase())}</div><div><b>${esc(o.name || t("f_owner"))}</b><span>${o.uname ? "@" + esc(o.uname) : "ID " + esc(o.uid)}</span></div></div>
    ${mine ? `<div class="hint" style="margin:0 0 10px">${t("f_mine")}</div>` : `
    <div class="field"><label>${t("f_comment")}</label><input id="oc" maxlength="80" placeholder="${t("f_ph")}"></div>
    <div class="row">
      <button class="btn" id="ord">${t("b_order")}</button>
      ${g.g && isNft ? `<button class="btn out" id="nft">${t("b_nft")}</button>` : ""}
    </div>`}
    ${mine && g.g && isNft ? `<button class="btn out" id="nft" style="width:100%">${t("b_nft")}</button>` : ""}`;
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  if ($("#nft")) $("#nft").onclick = () => openTg(`https://t.me/nft/${encodeURIComponent(String(g.g).toLowerCase())}`);
  const ord = $("#ord");
  if (ord) ord.onclick = async () => sendOrder(
      { o: 1, coid: S.uid + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        lu: String(o.uid), g: g.g, p: g.p || "", cur: g.cur || "", per: g.per || "", c: ($("#oc").value || "").slice(0, 80) });

}
document.addEventListener("click", (e) => { if (e.target === $("#overlay")) $("#overlay").hidden = true; });

const ORD_INTENT_KEY = "gr_ord_intent_v1";
function loadOrdIntent() { try { const v = JSON.parse(localStorage.getItem(ORD_INTENT_KEY) || "null"); return v && v.uid === S.uid ? v : null; } catch (e) { return null; } }
function saveOrdIntent(raw, attempts) { try { localStorage.setItem(ORD_INTENT_KEY, JSON.stringify({ uid: S.uid, ts: Date.now(), attempts: attempts || 0, raw })); } catch (e) {} }
function clearOrdIntent() { try { localStorage.removeItem(ORD_INTENT_KEY); } catch (e) {} }

// заказ доставлен боту только если sendData закрыл апп; живой апп через 1.6с = доставки не было
async function sendOrder(obj, showSheetToast) {
  const raw = JSON.stringify(obj);
  haptic("ok"); toast(t("t_ordersend"));
  $("#overlay").hidden = true;
  let tried = false;
  try { if (_canSendData()) { tg.sendData(raw); tried = true; } } catch (e) {}
  if (tried && _kbMode) {
    // вход с нижней кнопки: Telegram всегда закрывает апп и доставляет sendData.
    // Не ждём document.hidden (на медленных телефонах он не срабатывает -> дубли заказов).
    clearOrdIntent(); return;  // доставлено, бот уведомит арендодателя
  }
  if (tried) {
    await new Promise((r) => setTimeout(r, 1600));
    if (document.hidden) { clearOrdIntent(); return; }  // доставлено, бот уведомит арендодателя
  }
  // апп открыт не с reply-кнопки: запоминаем заказ, доводим при следующем входе с клавиатуры
  const it = loadOrdIntent();
  const attempts = (it ? (it.attempts || 0) : 0) + (tried ? 1 : 0);
  saveOrdIntent(raw, attempts);
  if (attempts >= 2) {
    // второй раз не доставилось: запасной путь — копипаст в чат бота
    const payload = b64e(raw);
    if (await copy(payload)) {
      toast(t("t_ordcopy"));
      setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 600);
    } else toast(t("t_ordcopyfail"));
    return;
  }
  toast(t("t_ordeep"));
  setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=ord`), 700);
}

// автодоводка: апп открыт с reply-клавиатуры («Маркет»/«Сдать подарок») + есть свежий заказ
function maybeAutoOrder() {
  if (!_kbMode || S.uid === "0") return;
  const it = loadOrdIntent();
  if (!it) return;
  if (Date.now() - it.ts > 10 * 60 * 1000) { clearOrdIntent(); return; }
  saveOrdIntent(it.raw, (it.attempts || 0) + 1);
  toast(t("t_ordeep2"));
  setTimeout(() => { try { tg.sendData(it.raw); } catch (e) {} }, 500);
  // если доставка прошла — апп закроется; остаёмся на чек-поинте подтверждения ниже
  setTimeout(() => {
    // kb-режим: sendData доставлен (Telegram закрывает апп). Если апп почему-то жив,
    // считаем доставленным и молча чистим интент: повторная отправка дала бы дубль.
    clearOrdIntent();
  }, 2600);
}

/* ============================================================
 * ORDERS
 * ============================================================ */
function renderOrders() {
  const inc = S.orders || [], out = S.myOrders || [];
  if (S.ordersSeg === "in" && !inc.length && out.length) S.ordersSeg = "out";
  $("#topbar").innerHTML = `<h1>${t("h_orders")}</h1><div class="tb-right"><button class="btn sec sm" id="rf">${t("b_refresh")}</button></div>`;
  $("#rf").onclick = async () => { await loadOrders(); renderOrders(); toast(t("t_refresh")); };
  localStorage.setItem("gr_seen_" + S.uid, String(Math.floor(Date.now() / 1000))); $("#ordersDot").hidden = true;
  const list = S.ordersSeg === "in" ? inc.slice().reverse() : out.slice().reverse();
  const when = (t) => new Date((t || 0) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const st = (s) => `<span class="ost ${s === "done" ? "done" : s === "cancelled" ? "cancelled" : "new"}">${s === "done" ? t("o_done") : s === "cancelled" ? t("o_cancelled") : t("o_new")}</span>`;
  $("#view").innerHTML = `
    <div class="seg"><button data-s="in" class="${S.ordersSeg === "in" ? "on" : ""}">${t("seg_in", { n: inc.length })}</button><button data-s="out" class="${S.ordersSeg === "out" ? "on" : ""}">${t("seg_out", { n: out.length })}</button></div>
    ${list.length ? list.map((o) => `
      <div class="ocard">
        <div class="ohead"><b>№${esc(o.id)} · ${esc(o.name || "")}${o.num != null ? " #" + esc(o.num) : ""}</b>${st(o.status)}</div>
        <div class="osub">${o.price ? esc(money(o.price)) + " " + esc(o.cur || "") + " / " + esc(o.per || "") : "по договорённости"} · ${esc(when(o.ts))}</div>
        ${S.ordersSeg === "in"
          ? `<div class="ocl">${t("or_client")} ${o.client_username ? "@" + esc(o.client_username) : "ID " + esc(o.client_uid)}${o.comment ? " · «" + esc(o.comment) + "»" : ""}</div>
             ${o.status === "new" ? `<div class="oact">
               ${o.client_username ? `<button class="btn out sm" data-w="${esc(o.client_username)}">${t("b_write")}</button>` : ""}
               <button class="btn sm" data-cmd="/done ${esc(o.id)}">${t("b_done")}</button>
               <button class="btn danger sm" data-cmd="/cancel ${esc(o.id)}">${t("b_cancel")}</button></div>` : ""}`
          : `<div class="ocl">${t("or_owner")} ${o.owner_username ? "@" + esc(o.owner_username) : "ID " + esc(o.lu)}</div>`}
      </div>`).join("") : `<div class="empty"><b>${t("e_noorders")}</b>${S.ordersSeg === "in" ? t("e_noorders_in") : t("e_noorders_out")}</div>`}
    ${S.ordersSeg === "in" && list.length ? `<div class="hint">${t("hint_orders")}</div>` : ""}`;
  $$("[data-s]").forEach((b) => b.onclick = () => { S.ordersSeg = b.dataset.s; renderOrders(); });
  $$("[data-w]").forEach((b) => b.onclick = () => openTg(`https://t.me/${b.dataset.w}`));
  $$("[data-cmd]").forEach((b) => b.onclick = async () => { await copy(b.dataset.cmd); haptic("ok"); toast(t("t_cmdcopy")); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 500); });
}

/* ============================================================
 * PROFILE (Instagram-style) + размещение подарков
 * ============================================================ */
function termFor(g) { return S.terms[ikey(g)] || S.terms[g.gid] || {}; }  // читаем с фолбэком на старые ключи
function myListedCount() { return Array.isArray(S.myGifts) ? S.myGifts.filter((g) => (termFor(g)).on).length : 0; }

async function startLiveScan() {
  if (!CONFIG.scanToken || S.uid === "0") return;
  const changed = await liveScan(S.uid);
  if (S.tab === "profile") { if (changed) renderProfile(); else drawScanState(); }
}
setInterval(() => { if (!document.hidden && S.tab === "profile") startLiveScan(); }, 5000);

function renderProfile() {
  const u = S.user || {};
  const name = S.profile.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || t("p_user");
  const uname = S.profile.uname || u.username || "";
  const mineInCat = (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid).length;
  $("#topbar").innerHTML = `<h1>${uname ? "@" + esc(uname) : t("h_profile")}</h1>`;
  $("#view").innerHTML = `
    <div class="p-head">
      <div class="avatar"><div>${u.photo_url ? `<img src="${esc(u.photo_url)}" alt="">` : esc(name.slice(0, 1).toUpperCase())}</div></div>
      <div class="p-stats">
        <div><b>${Array.isArray(S.myGifts) ? S.myGifts.length : 0}</b><span>${t("p_gifts")}</span></div>
        <div><b>${mineInCat}</b><span>${t("p_rent")}</span></div>
        <div><b>${(S.orders || []).filter((o) => o.status === "done").length}</b><span>${t("p_done")}</span></div>
      </div>
    </div>
    <div class="p-body">
      <div class="p-name">${esc(name)}</div>
      ${uname ? `<div class="p-handle">@${esc(uname)}</div>` : ""}
      ${S.profile.about ? `<div class="p-about">${esc(S.profile.about)}</div>` : ""}
    </div>
    <div class="idrow"><div><small>Telegram ID</small><b>${S.uid === "0" ? t("p_noid") : esc(S.uid)}</b></div><button class="btn out sm" id="cid">${S.uid === "0" ? t("b_retry") : t("b_copy")}</button></div>
    <div class="btnrow"><button class="btn sec" id="edit">${t("b_edit")}</button><button class="btn sec" id="share">${t("b_share")}</button></div>

    <div class="section-title">${t("st_settings")}</div>
    <div class="card setcard">
      <div class="setrow"><span>${t("s_theme")}</span>
        <div class="seg mini" id="thseg">
          <button data-th="auto" class="${S.theme === "auto" ? "on" : ""}">${t("s_auto")}</button>
          <button data-th="dark" class="${S.theme === "dark" ? "on" : ""}">${t("s_dark")}</button>
          <button data-th="light" class="${S.theme === "light" ? "on" : ""}">${t("s_light")}</button>
        </div></div>
      <div class="setrow"><span>${t("s_lang")}</span>
        <div class="seg mini" id="langseg">
          <button data-l="ru" class="${S.lang === "ru" ? "on" : ""}">Русский</button>
          <button data-l="en" class="${S.lang === "en" ? "on" : ""}">English</button>
          <button data-l="uz" class="${S.lang === "uz" ? "on" : ""}">O\u2018zbek</button>
        </div></div>
    </div>
    <div class="section-title">${t("st_req")}</div>
    <div class="card" id="req"></div>

    <div class="section-title">${t("st_rent")}</div>
    <div class="scanstate" id="scanstate"></div>
    <div id="mine"></div>
    <div class="hint">${t("hint_rent")}</div>
    ${faqHtml()}
    <button class="btn sec sm" id="about" style="margin:14px auto 28px;display:block">${t("b_about")}</button>`;
  bindFaq();
  $("#cid").onclick = async () => {
    if (S.uid === "0") { const ok = await applyTgUser(); if (!ok) { toast(t("t_openlogin")); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=login`), 400); } return; }
    await copy(S.uid); haptic("ok"); toast(t("t_idcopied"));
  };
  startLiveScan();
  $$("#thseg button").forEach((b) => b.onclick = () => { setTheme(b.dataset.th); render(); });
  $$("#langseg button").forEach((b) => b.onclick = () => { setLang(b.dataset.l); render(); });
  $("#edit").onclick = openEdit;
  $("#share").onclick = shareShowcase;
  $("#about").onclick = openAbout;
  drawReq(); drawMine();
}

function drawReq() {
  const box = $("#req"); if (!box) return;
  box.innerHTML = S.profile.req.map((r, i) => `
    <div class="ritem"><input class="inp" data-rl="${i}" placeholder="${t("req_l")}" maxlength="30" value="${esc(r.l || "")}"><input class="inp" data-rv="${i}" placeholder="${t("req_v")}" maxlength="120" value="${esc(r.v || "")}"><button class="del" data-rd="${i}">×</button></div>`).join("")
    + `<button class="rlink" id="radd">${t("b_addreq")}</button>`;
  const sv = () => save(CONFIG.profileKey, S.profile);
  $$("[data-rl]", box).forEach((e) => e.oninput = () => { S.profile.req[+e.dataset.rl].l = e.value; sv(); });
  $$("[data-rv]", box).forEach((e) => e.oninput = () => { S.profile.req[+e.dataset.rv].v = e.value; sv(); });
  $$("[data-rd]", box).forEach((e) => e.onclick = () => { S.profile.req.splice(+e.dataset.rd, 1); sv(); drawReq(); });
  $("#radd").onclick = () => { S.profile.req.push({ l: "", v: "" }); sv(); drawReq(); };
}

// сканер: спросили один раз -> флаг по uid, больше никогда не спрашиваем
function scanAsked() { try { return localStorage.getItem("gr_scanask_v1") === S.uid; } catch (e) { return false; } }
function markScanAsked() { try { localStorage.setItem("gr_scanask_v1", S.uid); } catch (e) {} }

function drawScanState() {
  const el = $("#scanstate"); if (!el) return;
  if (S.uid === "0") { el.innerHTML = ``; return; }
  if (CONFIG.scanToken) {
    if (!S.liveTs && !S.liveFail) { el.innerHTML = `<span class="spin"></span>${t("scan_scan")}`; return; }
    if (S.liveTs) {
      const age = Math.max(0, Math.round((Date.now() - S.liveTs) / 1000));
      el.innerHTML = `<i class="dot-live"></i>${t("scan_now")}${age < 5 ? "" : " " + t("scan_ago", { n: age })}`;
      return;
    }
    // live-скан не удался (юзер не подключал скан-бота): показываем repo-статус ниже
  }
  if (S.myGifts === "pending") { el.innerHTML = `<span class="spin"></span>Сканирую профиль Telegram…`; return; }
  if (!Array.isArray(S.myGifts)) { el.innerHTML = ``; return; }
  // бот сканирует профиль каждые 2-10с; штамп подарков меняется только при изменении, поэтому живость берём из heartbeat
  const hbAge = S.hb ? Math.round(Date.now() / 1000 - S.hb) : null;
  el.innerHTML = hbAge != null && hbAge < 150
    ? `<i class="dot-live"></i>${t("scan_sync")}`
    : `<i class="dot-off"></i>${t("scan_boot")}`;
}

function drawMine() {
  const box = $("#mine"); if (!box) return; drawScanState();
  if (S.uid === "0") { box.innerHTML = `<div class="empty"><b>Нужен вход через бота</b>Ты открыл мини-апп напрямую, Telegram не передал профиль. Нажми кнопку: бот пришлёт персональную кнопку входа, и всё подключится сразу и навсегда.<button class="btn" id="retryuid" style="margin:14px auto 0;max-width:260px">Войти через бота</button></div>`; const rb = $("#retryuid"); if (rb) rb.onclick = () => openTg(`https://t.me/${CONFIG.botUsername}?start=login`); return; }
  const list = mergeGifts();
  if (!list.length) {
    // скелетоны только пока НЕТ ни одного ответа: репо-скан основного бота уже ответил (даже пустым) или скан-бот отказал, значит ждать нечего
    const repoAnswered = Array.isArray(S.myGifts);
    const scanning = ((!S.liveTs && !S.liveFail && !repoAnswered) || S.myGifts === "pending") && !S._scanGaveUp;
    if (scanning) {
      box.innerHTML = Array.from({ length: 3 }, () => `<div class="lrow skl"><div class="lthumb sk-block"></div><div class="lmeta"><b class="sk-line w60"></b><span class="sk-line w40"></span></div></div>`).join("");
      // одноразовый таймер: если скан затянулся, показываем CTA (без циклов перерисовки)
      if (!S._scanTmr) S._scanTmr = setTimeout(() => { if (mergeGifts().length) return; if (S.myGifts === "pending" || (CONFIG.scanToken && !S.liveTs && !mergeGifts().length)) { S._scanTmr = 0; S._scanGaveUp = true; drawMine(); } }, 7000);
      return;
    }
    const fresh = S.myGiftsUpd && (Date.now() / 1000 - S.myGiftsUpd) < 120;
    box.innerHTML = fresh
      ? `<div class="empty"><b>${t("e_nogifts")}</b>${t("e_gifts2")}<span class="hint">${t("e_gifts3")}</span></div>`
      : scanAsked() || S.liveTs
        ? `<div class="empty"><b>${t("e_notfound")}</b>${t("e_nf2")}</div>`
        : `<div class="empty"><b>${t("e_scan")}</b>${t("e_scan2")}<button class="btn" id="scancta">${t("b_scan")}</button></div>`;
    const cta = $("#scancta");
    if (cta) cta.onclick = () => { markScanAsked(); openTg(`https://t.me/${CONFIG.botUsername}?start=scan`); };
    return;
  }
  const repoIds = new Set((Array.isArray(S.myGifts) ? S.myGifts : []).map((g) => ikey(g)));
  const listedIds = new Set((S.catalog || []).filter((c) => c.owner && String(c.owner.uid) === S.uid).map((c) => String(c.g)));
  box.innerHTML = list.map((g) => {
    const k = ikey(g);
    const tr = S.terms[k] || S.terms[g.gid] || {};  // локальное имя: t() — функция перевода
    const listed = listedIds.has(k);
    const c1 = hex(g.cc) || "#5aa7e0", c2 = hex(g.ec) || "#2b3f66";
    return `<div class="lrow ${listed ? "is-listed" : ""}" data-g="${esc(k)}">
      <div class="lthumb" style="--c1:${c1};--c2:${c2}">${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : repoIds.has(k) && g.th_fuid ? `<img src="assets/gifts/${esc(g.th_fuid)}.webp" alt="" onerror="this.remove()">` : g.th_fuid ? `<img data-livethumb="${esc(k)}" alt="">` : "🎁"}</div>
      <div class="lmeta"><b>${esc(dname(g))}${g.num != null ? " #" + esc(g.num) : ""}</b><span>${esc(g.model || (g.stars ? g.stars + " ★" : ""))}${g.mr ? " · " + pct(g.mr) : ""}</span></div>
      ${listed ? `<button class="unl" data-unl="${esc(k)}">${t("b_remove")}</button>` : ""}
      <label class="switch"><input type="checkbox" ${tr.on ? "checked" : ""}><i></i></label>
    </div>
    <div class="pform" data-pf="${esc(k)}" ${tr.on ? "" : "hidden"} style="padding:0 14px 12px;border-bottom:1px solid var(--line)">
      <div class="row"><input class="inp" data-p inputmode="decimal" placeholder="${t("f_price")}" value="${esc(tr.p || "")}">
        <select class="inp" data-c>${CURRENCIES.map((c) => `<option ${c === (tr.cur || "UZS") ? "selected" : ""}>${c}</option>`).join("")}</select>
        <select class="inp" data-r>${PERIODS.map((c) => `<option ${c === (tr.per || "день") ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    </div>`;
  }).join("");
  // подаркам только из live-скана: прямая ссылка на стикер через getFile
  $$("img[data-livethumb]", box).forEach(async (el) => {
    const k = el.dataset.livethumb;
    const g = list.find((x) => ikey(x) === k);
    if (!g) return;
    let u = await thumbUrl(g);
    if (!u) { await new Promise((r) => setTimeout(r, 900)); u = await thumbUrl(g); }
    if (u && el.isConnected) el.src = u;
    else if (!u && el.isConnected) el.remove();
  });
  $$("[data-unl]", box).forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const gid = b.dataset.unl;
    S.terms[gid] = { ...(S.terms[gid] || {}), on: false }; save(CONFIG.termsKey, S.terms);
    S.catalog = (S.catalog || []).filter((c) => !(c.owner && String(c.owner.uid) === S.uid && String(c.g) === gid));
    haptic("ok"); renderProfile();
    await publish(true);
  });
  $$(".lrow", box).forEach((row) => {
    const gid = row.dataset.g; const pf = $(`[data-pf="${CSS.escape(gid)}"]`, box);
    const t = () => (S.terms[gid] = S.terms[gid] || {});
    $(".lmeta", row).onclick = async () => { const g = list.find((x) => ikey(x) === gid); if (g) openMyGiftDetail(g, repoIds.has(ikey(g))); };
    $("input[type=checkbox]", row).onchange = (e) => { t().on = e.target.checked; pf.hidden = !e.target.checked; save(CONFIG.termsKey, S.terms); haptic(); drawPubBar(); };
    $("[data-p]", pf).oninput = (e) => { t().p = e.target.value; save(CONFIG.termsKey, S.terms); drawPubBar(); };
    $("[data-c]", pf).onchange = (e) => { t().cur = e.target.value; save(CONFIG.termsKey, S.terms); drawPubBar(); };
    $("[data-r]", pf).onchange = (e) => { t().per = e.target.value; save(CONFIG.termsKey, S.terms); drawPubBar(); };
  });
  drawPubBar();
}

async function openMyGiftDetail(g, fromRepo) {
  haptic();
  let t = null;
  if (fromRepo && g.th_fuid) t = `assets/gifts/${g.th_fuid}.webp`;
  else t = await thumbUrl(g);
  const u = S.user || {};
  openDetail({
    n: g.name, dn: dname(g), num: g.num, m: g.model, s: g.symbol, b: g.backdrop,
    mr: g.mr, sr: g.sr, br: g.br, cc: g.cc, ec: g.ec, t,
    g: g.uniq || (g.p === "unique" ? g.gid : ""), stars: g.stars,
    p: "", owner: { uid: S.uid, name: S.profile.name || u.first_name || "", uname: u.username || "" },
  });
}

function openEdit() {
  const u = S.user || {};
  $("#sheet").innerHTML = `
    <div class="sheet-h"><span>${t("h_edit")}</span><button class="sheet-x" id="x">×</button></div>
    <div class="field"><label>Имя</label><input id="e1" maxlength="60" value="${esc(S.profile.name || [u.first_name, u.last_name].filter(Boolean).join(" "))}"></div>
    <div class="field"><label>Username для связи (без @)</label><input id="e2" maxlength="32" value="${esc(S.profile.uname || u.username || "")}"></div>
    <div class="field"><label>О себе / условия аренды</label><textarea id="e3" maxlength="300">${esc(S.profile.about)}</textarea></div>
    <button class="btn" id="e4" style="width:100%">Сохранить</button>`;
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  $("#e4").onclick = () => {
    S.profile.name = $("#e1").value.trim(); S.profile.uname = $("#e2").value.trim().replace(/^@/, ""); S.profile.about = $("#e3").value.trim();
    save(CONFIG.profileKey, S.profile); $("#overlay").hidden = true; renderProfile(); toast(t("t_saved"));
  };
}

function buildListing() {
  const gifts = mergeGifts().filter((g) => termFor(g).on).map((g) => {
    const t = S.terms[ikey(g)] || S.terms[g.gid] || {}; return { g: ikey(g), p: t.p || "", cur: t.cur || "UZS", per: t.per || "день" };
  });
  const u = S.user || {};
  return { l: 1, uid: S.uid, name: S.profile.name || [u.first_name, u.last_name].filter(Boolean).join(" "), uname: S.profile.uname || u.username || "", about: S.profile.about, req: S.profile.req.filter((r) => r.v), gifts };
}

// Публикация. sendData у Telegram работает ТОЛЬКО при запуске с reply-клавиатуры бота; в остальных режимах
// метод есть, но молча не доставляет. Поэтому: (1) оптимистично показываем листинг сразу, (2) отправляем,
// (3) ждём подтверждения из каталога, (4) если не пришло — честный фолбэк, а не вечное «Публикую…».
// sendData по докам Telegram работает только при запуске с keyboard button и ЗАКРЫВАЕТ мини-апп.
// Надёжный признак доставки один: апп закрылся. Если через 1.6с он ещё жив, доставки не было.
// намерение публикации: переживает закрытие аппа (localStorage), uid-связанное
const PUB_INTENT_KEY = "gr_pub_intent_v1";
function loadPubIntent() { try { const v = JSON.parse(localStorage.getItem(PUB_INTENT_KEY) || "null"); return v && v.uid === S.uid ? v : null; } catch (e) { return null; } }
function savePubIntent(attempts) { try { localStorage.setItem(PUB_INTENT_KEY, JSON.stringify({ uid: S.uid, ts: Date.now(), attempts: attempts || 0 })); } catch (e) {} }
function clearPubIntent() { try { localStorage.removeItem(PUB_INTENT_KEY); } catch (e) {} }
// автопубликация: апп открыт нижней кнопкой «Сдать подарок» (m=pub), намерение свежее -> шлём sendData сразу
function maybeAutoPublish() {
  if (!_pubMode || S.uid === "0") return;
  const it = loadPubIntent();
  if (!it) return;
  if (Date.now() - it.ts > 10 * 60 * 1000) { clearPubIntent(); return; }  // протухло
  if (wantKey() === myCatalogKey()) { clearPubIntent(); return; }  // уже опубликовано, дубль не нужен
  savePubIntent((it.attempts || 0) + 1);
  toast(t("t_pubfinish"));
  setTimeout(() => publish(true), 600);
}

// подтверждение: каталог (источник правды) совпал с тем, что отправили
function confirmPublished() {
  if (!S._pubWant && S._pubWant !== "") return;
  if (myCatalogKey() !== S._pubWant) return;
  S._pubWant = null; haptic("ok"); clearPubIntent(); drawPubBar();
  toast(S._pubWasEmpty ? "Снято с аренды" : "Опубликовано в каталоге");
  const btn = $("#pub"); if (btn) btn.classList.remove("busy");
}
const _canSendData = () => !!(tg && typeof tg.sendData === "function");
function myCatalogKey() { return (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid).map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|"); }
function wantKey() { return buildListing().gifts.map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|"); }
// локальные данные слетели (новое устройство, чистый storage): восстанавливаем цены и статусы из каталога по uid
function recoverTerms() {
  const mine = (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid);
  if (mine.length && !Object.keys(S.terms || {}).length) {
    for (const g of mine) S.terms[g.g] = { on: true, p: g.p, cur: g.cur, per: g.per };
    save(CONFIG.termsKey, S.terms);
    toast(t("t_recovered"));
  }
}
// профиль (реквизиты, имя) — из листинга юзера в репо
async function recoverProfile() {
  const pristine = !S.profile.name && !S.profile.about && !(S.profile.req || []).some((r) => r.v);
  if (!pristine) return;
  try {
    const l = await getJSON("data/listings/" + S.uid + ".json");
    if (l && l.req) {
      S.profile = { ...S.profile, name: l.name || S.profile.name, uname: l.uname || S.profile.uname,
        about: l.about || S.profile.about, req: (l.req || []).filter((r) => r && r.v) };
      save(CONFIG.profileKey, S.profile);
    }
  } catch (e) {}
}
// плавающая кнопка: видна только когда локальное состояние отличается от опубликованного; при скролле вниз прячется
function drawPubBar() {
  const bar = $("#pubbar"); if (!bar) return;
  const pending = S._pubWant != null && S._pubWant === wantKey();
  const show = S.tab === "profile" && S.uid !== "0" && wantKey() !== myCatalogKey() && !pending;
  if (show) bar.classList.remove("down");
  bar.classList.toggle("show", show);
}
let _scrY = 0, _scrTmr = 0;
window.addEventListener("scroll", () => {
  const bar = $("#pubbar"); if (!bar || !bar.classList.contains("show")) return;
  const y = window.scrollY;
  if (Math.abs(y - _scrY) > 4) bar.classList.add("down");
  _scrY = y; clearTimeout(_scrTmr);
  _scrTmr = setTimeout(() => { if (bar) bar.classList.remove("down"); }, 900);
}, { passive: true });

async function publish(force) {
  const obj = buildListing();
  const wasListed = (S.catalog || []).some((g) => g.owner && String(g.owner.uid) === S.uid);
  if (!obj.gifts.length && !wasListed && !force) return toast(t("t_pubnone"));
  // идемпотентность: локальное состояние совпадает с опубликованным -> повтор не нужен, бот не дёргаем
  if (!force) {
    const wantNow = obj.gifts.map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|");
    if (wantNow === myCatalogKey()) { haptic(); toast(t("t_pubsame")); clearPubIntent(); return; }
  }
  const raw = JSON.stringify(obj);
  const btn = $("#pub");
  const want = obj.gifts.map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|");

  // оптимистично: у арендодателя каталог обновляется мгновенно, без ожидания бота
  const me = { uid: S.uid, name: obj.name, uname: obj.uname };
  const known = mergeGifts();
  S.catalog = (S.catalog || []).filter((c) => !(c.owner && String(c.owner.uid) === S.uid)).concat(obj.gifts.map((g) => {
    const k = known.find((x) => ikey(x) === g.g) || {};
    return { g: g.g, n: k.name || "", m: k.model || "", s: k.symbol || "", num: k.num, cc: k.cc, ec: k.ec, mr: k.mr, sr: k.sr, br: k.br,
      b: k.backdrop || "", t: k.th_fuid ? `assets/gifts/${k.th_fuid}.webp` : "", p: g.p, cur: g.cur, per: g.per, ts: Math.floor(Date.now() / 1000), owner: me, _local: 1 };
  }));
  S._pubWant = want; S._pubAt = Date.now(); S._pubWasEmpty = !obj.gifts.length;
  if (btn) btn.classList.add("busy");
  haptic("ok"); toast(t("t_pubsent"));
  if (S.tab === "profile") drawMine();

  let tried = false;
  try { if (_canSendData()) { tg.sendData(raw); tried = true; } } catch (e) {}
  if (tried) {
    // если Telegram принял sendData, мини-апп закроется; живой апп через 1.6с = доставки не было
    await new Promise((r) => setTimeout(r, 1600));
    if (document.hidden) { clearPubIntent(); return; }  // доставка подтверждена закрытием: публикация у бота
  }
  // sendData не доставил (апп открыт из inline-кнопки или menu-кнопки): запоминаем намерение,
  // публикация завершится сама, как только юзер откроет апп нижней кнопкой «Сдать подарок»
  if (btn) btn.classList.remove("busy");
  const intent = loadPubIntent();
  if ((intent ? (intent.attempts || 0) : 0) >= 1) {
    // второй заход не удался тоже -> запасной путь: копипаст-команда в чат бота
    const payload = b64e(raw);
    if (payload.length <= 3900 && await copy(payload)) {
      toast(t("t_pubdeep2"));
      setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=pub`), 900);
      return;
    }
    toast(t("t_pubfail"));
    return;
  }
  savePubIntent();
  haptic("ok");
  toast(t("t_pubdeep"));
  setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=pub`), 1100);
}

const ABOUT_TEXTS = {
  ru: `
  <div class="sheet-h"><span>\u{1F381} Gift Rent</span><button class="sheet-x" id="x">\u00d7</button></div>
  <div class="about">
    <div class="ab-block"><b>О сервисе</b>
      Gift Rent — маркетплейс аренды подарков Telegram. Арендуй подарки у других юзеров или зарабатывай, сдавая свои. Основатель: <span class="ab-strong">Достонхожа</span> (@dostonxoja). Профиль сканируется автоматически, публикация занимает секунды, всё работает 24/7.</div>
    <div class="ab-block"><b>Условия использования</b>
      1. Оплата напрямую между юзерами (P2P) — сервис переводов не проводит.<br>
      2. Переводи деньги только после согласования сделки в чате с арендодателем.<br>
      3. Витрины проверяются цифровой подписью; мошенники попадают в блок-лист.<br>
      4. Все сделки фиксируются: заказ, подтверждение арендодателем, отметка «сдано».<br>
      5. Жалоба на мошенника — команда /block у бота, админ разберётся.</div>
  </div>`,
  en: `
  <div class="sheet-h"><span>\u{1F381} Gift Rent</span><button class="sheet-x" id="x">\u00d7</button></div>
  <div class="about">
    <div class="ab-block"><b>About the service</b>
      Gift Rent is a Telegram gift rental marketplace. Rent gifts from other users or earn by renting out yours. Founder: <span class="ab-strong">Dostunkhoja</span> (@dostonxoja). Your profile is scanned automatically, publishing takes seconds, everything runs 24/7.</div>
    <div class="ab-block"><b>Terms of use</b>
      1. Payment is direct between users (P2P) — the service processes no transfers.<br>
      2. Send money only after the deal is agreed in chat with the owner.<br>
      3. Showcases are verified by digital signature; scammers go to the blocklist.<br>
      4. Every deal is recorded: order, owner confirmation, «done» mark.<br>
      5. To report a scammer — /block command in the bot, the admin will review it.</div>
  </div>`,
  uz: `
  <div class="sheet-h"><span>\u{1F381} Gift Rent</span><button class="sheet-x" id="x">\u00d7</button></div>
  <div class="about">
    <div class="ab-block"><b>Xizmat haqida</b>
      Gift Rent — Telegram sovg'alarini ijaraga berish bozori. Boshqalardan sovg'a ijaraga oling yoki o'zingiznikini ijaraga berib daromad qiling. Asoschi: <span class="ab-strong">Достонхожа</span> (@dostonxoja). Profil avtomatik skaner qilinadi, nashr soniyalar ichida, hammasi 24/7 ishlaydi.</div>
    <div class="ab-block"><b>Foydalanish shartlari</b>
      1. To'lov foydalanuvchilar o'rtasida to'g'ridan-to'g'ri (P2P) — xizmat pul o'tkazmaydi.<br>
      2. Pulni faqat ijara beruvchi bilan chatda kelishilgandan keyin yuboring.<br>
      3. Vitrinalar raqamli imzo bilan tekshiriladi; firibgarlar blok-ro'yxatga tushadi.<br>
      4. Barcha bitimlar qayd etiladi: buyurtma, ijara beruvchi tasdig'i, «bajarildi» belgisi.<br>
      5. Firibgarni xabar qilish — botdagi /block buyrug'i, admin ko'rib chiqadi.</div>
  </div>`
};
const ABOUT_TEXT = (S) => ABOUT_TEXTS[S.lang] || ABOUT_TEXTS.ru;
function agreed() { try { return !!localStorage.getItem("gr_agree_" + S.uid) || !!localStorage.getItem("gr_agree_any"); } catch (e) { return false; } }
function markAgreed() {
  const v = String(Date.now());
  try { localStorage.setItem("gr_agree_" + S.uid, v); localStorage.setItem("gr_agree_any", v); localStorage.setItem("gr_about_seen_" + S.uid, v); } catch (e) {}
  try { tg && tg.CloudStorage && tg.CloudStorage.setItem("agreed", v); } catch (e) {}
}
// восстановить отметку из облака Telegram (если localStorage очистили)
try { tg && tg.CloudStorage && tg.CloudStorage.getItem("agreed", (e, v) => { if (!e && v) { try { localStorage.setItem("gr_agree_any", v); } catch (x) {} } }); } catch (e) {}


/* FAQ на трёх языках: [вопрос, ответ, (опц.) фото] */
const FAQ = {
  en: [
    ["How long does publishing a gift take?",
     "Usually 5–15 seconds: the bot checks the gift against your profile and updates the catalog. Allow up to 2 minutes: network and sync queue can add delay. If the gift is not in the catalog after 5 minutes, tap «Publish» again (safe to repeat) or open the app via the «Rent out» button at the bottom of the bot chat."],
    ["What if I tap «Publish» several times?",
     "No problem. If the state is already published, the app answers «Already published» and sends nothing. No duplicates."],
    ["How do I rent a gift? (photo)",
     "1) Tap «Rent» at the bottom. 2) Open a gift card. 3) Tap «Rent this gift» and leave a comment. The bot notifies the owner instantly, they will message you on Telegram. See the photo below.",
     "assets/faq/market.jpg"],
    ["How do I rent out a gift? (photo)",
     "1) Tap «Rent out» at the bottom. 2) Toggle on the gift. 3) Set price, currency and period. 4) Tap «Publish». Each gift is configured separately, even identical ones. See the photo below.",
     "assets/faq/publish.jpg"],
    ["Why is my gift missing from the list?",
     "Gifts come from your Telegram profile. Check they are visible: Telegram → Profile → Gifts. A new gift appears in the app within 5–60 seconds. If not, tap «Connect the scanner» once and come back."],
    ["How do I unlist a gift?",
     "Profile → on a listed gift tap «Unlist». The catalog updates as fast as publishing (up to 2 minutes with margin)."],
    ["How do orders arrive? (photo)",
     "The client taps «Rent this gift» and the bot sends you a notification: gift, price, client and comment (photo below). Then you contact the client on Telegram and agree on deposit and dates. Commands: /done N, /cancel N, /orders. If no notification within 2 minutes, open the bot with the «Rent» button at the bottom: the order arrives automatically.",
     "assets/faq/orders.jpg"],
    ["The bot is silent or buttons don't respond",
     "The bot runs 24/7 but restarts occasionally: it takes up to 5–10 minutes. Wait and retry. No data is lost: an unfinished publish or order is remembered and delivered on the next entry via the bottom buttons."],
    ["Data vanished on my phone, what do I do?",
     "You don't need to re-enter anything. The app finds your past prices, profile and rentals by Telegram ID itself. If it didn't, open the profile and wait 10–20 seconds."],
    ["How do I pay and return the gift?",
     "The service takes no money and transfers no gifts: it's P2P. Payment, deposit and return are agreed directly between owner and client using the details from the profile. Verify the person and never hand over a gift without a deposit."],
    ["Where to write if nothing helps?",
     "The service founder: @dostonxoja. Attach your Telegram ID from the profile and describe what happened."],
  ],
  uz: [
    ["Sovg'a chiqarish qancha vaqt oladi?",
     "Odatda 5–15 soniya: bot sovg'ani profilingiz bilan solishtiradi va katalogni yangilaydi. 2 daqiqagacha kutib turing: tarmoq va sinxronizatsiya navbati kechiktirishi mumkin. 5 daqiqadan keyin sovg'a katalogda bo'lmasa, «Chiqarish»ni yana bosing (takrorlash xavfsiz) yoki bot chatidagi pastdagi «Sovg'a ijaraga» tugmasi orqali ilovani oching."],
    ["«Chiqarish»ni bir necha marta bossam nima bo'ladi?",
     "Hech narsa. Holat allaqachon chiqarilgan bo'lsa, ilova «Allaqachon chiqarilgan» deb javob beradi va hech narsa yubormaydi. Nusxa bo'lmaydi."],
    ["Sovg'ani qanday ijaraga olish mumkin? (rasm)",
     "1) Pastdagi «Ijara» tugmasini bosing. 2) Sovg'a kartasini oching. 3) «Ijaraga olish»ni bosing va izoh qoldiring. Bot ijara beruvchiga darhol xabar beradi, u Telegramda yozadi. Pastdagi rasmni ko'ring.",
     "assets/faq/market.jpg"],
    ["Sovg'ani qanday ijaraga berish mumkin? (rasm)",
     "1) Pastdagi «Sovg'a ijaraga» tugmasini bosing. 2) Sovg'a tugmasini yoqing. 3) Narx, valyuta va muddatni belgilang. 4) «Chiqarish»ni bosing. Har bir sovg'a alohida sozlanadi, bir xillari ham. Pastdagi rasmni ko'ring.",
     "assets/faq/publish.jpg"],
    ["Sovg'am ro'yxatda yo'q nega?",
     "Sovg'alar Telegram profilingizdan olinadi. Ko'rinadiganini tekshiring: Telegram → Profil → Sovg'alar. Yangi sovg'a ilovada 5–60 soniyada paydo bo'ladi. Bo'lmasa, «Skanerni ulash»ni bir marta bosing va qaytib keling."],
    ["Sovg'ani ijaradan qanday o'chiraman?",
     "Profil → ijara beruvchi sovg'ada «O'chirish»ni bosing. Katalog chiqarish singari tez yangilanadi (2 daqiqagacha)."],
    ["Buyurtmalar qanday keladi? (rasm)",
     "Mijoz «Ijaraga olish»ni bosadi, bot sizga xabar yuboradi: sovg'a, narx, mijoz va izoh (pastdagi rasm). Keyin mijoz bilan Telegramda bog'lanib, garov va muddatni kelishasiz. Buyruqlar: /done №, /cancel №, /orders. 2 daqiqada xabar kelmasa, botni pastdagi «Ijara» tugmasi bilan oching: buyurtma o'zi yetib boradi.",
     "assets/faq/orders.jpg"],
    ["Bot javob bermaydi yoki tugmalar ishlamaydi",
     "Bot 24/7 ishlaydi, lekin ba'zan qayta ishga tushadi: bu 5–10 daqiqa oladi. Kutib turing va qayta urinib ko'ring. Ma'lumot yo'qolmaydi: tugallanmagan nashr va buyurtma eslab qolinadi va keyingi kirishda pastdagi tugmalar orqali yetkaziladi."],
    ["Telefonda ma'lumotlar yo'qoldi, nima qilish kerak?",
     "Hech narsani qayta kiritish shart emas. Ilova eski narxlaringiz, profil va ijara raqamlaringizni Telegram ID orqali o'zi topadi. Bo'lmasa, profilni ochib 10–20 soniya kutib turing."],
    ["To'lov va sovg'ani qaytarish qanday?",
     "Xizmat pul qabul qilmaydi va sovg'a uzatmaydi: bu P2P. To'lov, garov va qaytarish ijara beruvchi bilan mijoz o'rtasida profil ma'lumotlari bo'yicha to'g'ridan-to'g'ri kelishiladi. Mijozni tekshiring va garovsiz sovg'a bermang."],
    ["Hech narsa yordam bermasa qayerga yozish kerak?",
     "Xizmat asoschisi: @dostonxoja. Profilingizdagi Telegram ID ni qo'shib, nima bo'lganini yozib qoldiring."],
  ]
};

/* RU-справочник ниже (FAQ_ITEMS); en/uz выше */
const FAQ_ITEMS = [
  ["Сколько времени занимает публикация подарка?",
   "Обычно 5–15 секунд: бот сверяет подарок с твоим профилем и обновляет каталог. С запасом закладывай до 2 минут: сеть и очередь синхронизации иногда добавляют задержку. Если за 5 минут подарка в каталоге нет, нажми «Опубликовать» ещё раз (повтор безопасен) или открой приложение через кнопку «Сдать подарок» внизу чата с ботом."],
  ["Что если нажать «Опубликовать» несколько раз?",
   "Ничего страшного. Если состояние уже опубликовано, приложение ответит «Уже опубликовано» и ничего не отправит. Дублей не будет."],
  ["Как арендовать подарок? (фото)",
   "1) Нажми «Маркет» внизу. 2) Открой карточку подарка. 3) Нажми «Заказать аренду» и оставь комментарий. Бот сразу уведомит арендодателя, он напишет тебе в Telegram. Смотри фото ниже.",
   "assets/faq/market.jpg"],
  ["Как сдать подарок в аренду? (фото)",
   "1) Нажми «Сдать подарок» внизу. 2) Включи переключатель у нужного подарка. 3) Укажи цену, валюту и срок. 4) Нажми «Опубликовать». Каждый подарок настраивается отдельно, даже одинаковые. Смотри фото ниже.",
   "assets/faq/publish.jpg"],
  ["Почему моего подарка нет в списке?",
   "Подарки подтягиваются из твоего профиля Telegram. Проверь, что они видимы: Telegram → Профиль → Подарки. Новый подарок появляется в приложении за 5–60 секунд. Если нет, нажми «Подключить сканер» один раз и вернись."],
  ["Как снять подарок с аренды?",
   "Профиль → у подарка в аренде нажми «Снять». Каталог обновится так же быстро, как при публикации (до 2 минут с запасом)."],
  ["Как приходят заказы? (фото)",
   "Клиент жмёт «Заказать аренду», а бот присылает тебе уведомление: подарок, цена, клиент и комментарий (фото ниже). Дальше ты связываешься с клиентом в Telegram, договариваешься о залоге и сроках. Команды: /done №, /cancel №, /orders. Если уведомления нет в течение 2 минут, открой бота кнопкой «Маркет» внизу: заказ дойдёт автоматически.",
   "assets/faq/orders.jpg"],
  ["Бот молчит или кнопки не реагируют",
   "Бот работает 24/7, но иногда перезапускается: это занимает до 5–10 минут. Подожди и повтори. Данные не теряются: незавершённые публикация и заказ запоминаются и доставляются при следующем входе через нижние кнопки."],
  ["Слетели данные на телефоне, что делать?",
   "Ничего вводить заново не нужно. Приложение само находит твои прошлые цены, профиль и аренды по Telegram ID. Если не подтянулось, открой профиль и подожди 10–20 секунд."],
  ["Как оплатить и вернуть подарок?",
   "Сервис не принимает деньги и не передаёт подарки: это P2P. Оплата, залог и возврат обсуждаются напрямую между арендодателем и клиентом по реквизитам из профиля. Проверяй собеседника и не отдавай подарок без залога."],
  ["Куда писать, если ничего не помогло?",
   "Основатель сервиса: @dostonxoja. Приложи свой Telegram ID из профиля и опиши, что произошло."],
];
function faqItems() { return I18N[S.lang] && S.lang !== "ru" ? FAQ[S.lang] : FAQ_ITEMS; }
function faqHtml() {
  return `<div class="section-title">${t("st_faq")}</div>
    <div class="faq" id="faq">${faqItems().map((q, i) => `
      <div class="faq-i" data-fq="${i}"><button class="faq-q" type="button"><span>${esc(q[0])}</span><i>+</i></button><div class="faq-a" hidden>${esc(q[1])}${q[2] ? `<img class="faq-img" src="${esc(q[2])}" alt="${t("ab_faqimg")}" loading="lazy">` : ""}</div></div>`).join("")}</div>`;
}
function bindFaq() {
  $$("#faq .faq-q").forEach((b) => b.onclick = () => {
    const it = b.parentElement, a = $(".faq-a", it), open = a.hidden;
    a.hidden = !open; it.classList.toggle("open", open); $("i", b).textContent = open ? "−" : "+"; haptic();
  });
}

function openAbout() {
  $("#sheet").innerHTML = ABOUT_TEXTS[S.lang] + (agreed()
    ? `<div class="sheet-f"><button class="btn sec" id="abclose">Закрыть</button></div>`
    : `<div class="sheet-f"><button class="btn" id="agreebtn">\u2705 ${t("b_agree")}</button></div>`);
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  const c = $("#abclose"); if (c) c.onclick = () => ($("#overlay").hidden = true);
  const ab = $("#agreebtn"); if (ab) ab.onclick = () => {
    markAgreed();
    haptic("ok"); toast(t("t_agreed"));
    $("#overlay").hidden = true;
  };
}
async function shareShowcase() {
  const l = (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid);
  if (!l.length) return toast(t("t_nopub"));
  const link = `https://t.me/${CONFIG.botUsername}/${CONFIG.appShortName}?startapp=u_${S.uid}`;
  await copy(link); haptic("ok"); toast(t("t_showcase"));
}

/* ============================================================
 * Прямой скан профиля: getUserGifts из клиента (любой юзер, без /start)
 * ============================================================ */
let _scanBusy = false, _scanTs = 0, _fileCache = JSON.parse(localStorage.getItem("gr_filecache") || "{}");

async function tgApi(method, params) {
  const q = new URLSearchParams({ ...params }).toString();
  try {
    const r = await fetch(`https://api.telegram.org/bot${CONFIG.scanToken}/${method}?${q}`);
    const d = await r.json();
    return d && d.ok ? d.result : null;
  } catch (e) { return null; }
}

async function liveScan(uid) {
  if (!CONFIG.scanToken || uid === "0" || _scanBusy) return false;
  if (!S._forceScan && Date.now() - _scanTs < 4000) return false;
  S._forceScan = false;
  _scanBusy = true; _scanTs = Date.now();
  try {
    const gifts = []; let offset = ""; let first = true;
    for (let i = 0; i < 20; i++) {
      const res = await tgApi("getUserGifts", { user_id: uid, offset, limit: 100 });
      if (!res) { if (first) S.liveFail = true; break; }
      first = false; S.liveFail = false;
      for (const g of (res.gifts || [])) {
        if (g.is_burned) continue;
        const u = g.gift || {};
        if (g.type !== "unique") {
          const stk = u.sticker || {};
          const st = stk.thumbnail || {};
          gifts.push({ gid: u.id || "", inst: String(g.owned_gift_id || ""), name: u.title || stk.emoji || "", num: null,
            model: "", symbol: "", backdrop: "", cc: null, ec: null, mr: null, sr: null, br: null,
            th_fuid: st.file_unique_id, th_fid: st.file_id, p: g.type, stars: u.star_count });
          continue;
        }
        const model = u.model || {}, symbol = u.symbol || {}, backdrop = u.backdrop || {};
        const colors = backdrop.colors || {};
        const thumb = ((model.sticker || {}).thumbnail) || {};
        gifts.push({ gid: u.name || `${u.gift_id}#${u.number}`, inst: String(g.owned_gift_id || ""), name: u.base_name || "",
          uniq: u.name || "", num: u.number,
          model: model.name || "", symbol: symbol.name || "", backdrop: backdrop.name || "",
          cc: colors.center_color, ec: colors.edge_color,
          mr: model.rarity_per_mille, sr: symbol.rarity_per_mille, br: backdrop.rarity_per_mille,
          th_fuid: thumb.file_unique_id, th_fid: thumb.file_id, p: "unique" });
      }
      offset = res.next_offset;
      if (!offset) break;
    }
    const key = (l) => l.map((g) => g.gid + "#" + g.num).sort().join("|");
    const changed = !Array.isArray(S.liveGifts) || key(gifts) !== key(S.liveGifts);
    if (gifts.length) {
      S.liveGifts = gifts; S.liveTs = Date.now(); S.liveFail = false;
      try { localStorage.setItem("gr_filecache", JSON.stringify(_fileCache)); } catch (e) {}
    }
    return changed;
  } finally { _scanBusy = false; }
}

// прямая ссылка на стикер: getFile + file path (через скан-бот); дедупликация одновременных запросов
const _inflight = {};
async function thumbUrl(g) {
  if (g._t) return g._t;
  if (g.th_fuid && _fileCache[g.th_fuid]) return g._t = _fileCache[g.th_fuid];
  if (!CONFIG.scanToken || !g.th_fid) return null;
  if (g.th_fuid && _inflight[g.th_fuid]) return _inflight[g.th_fuid];
  const p = (async () => {
    const r = await tgApi("getFile", { file_id: g.th_fid });
    if (!r || !r.file_path) return null;
    const url = `https://api.telegram.org/file/bot${CONFIG.scanToken}/${r.file_path}`;
    if (g.th_fuid) _fileCache[g.th_fuid] = url;
    return url;
  })();
  if (g.th_fuid) { _inflight[g.th_fuid] = p; try { const u = await p; if (u) g._t = u; } finally { delete _inflight[g.th_fuid]; } return g._t || await p; }
  return p;
}

// уникальный ключ экземпляра: gid#inst. Одинаковые подарки = отдельные строки, каждый со своей ценой
function ikey(g) { return g.gid + (g.inst ? "#" + g.inst : ""); }
function mergeGifts() {
  // прямой скан приоритетнее: он свежее репо-данных
  const live = S.liveGifts;
  let src = (!Array.isArray(live) || !live.length) ? (Array.isArray(S.myGifts) ? S.myGifts : []) : (() => {
    const byIid = {};
    (Array.isArray(S.myGifts) ? S.myGifts : []).forEach((g) => { byIid[ikey(g)] = g; });
    return live.map((g) => { const repo = byIid[ikey(g)]; return repo && repo.t ? { ...g, t: repo.t } : g; });
  })();
  src = src.map((g) => ({ ...g }));  // копии, чтобы не мутировать исходники
  // у дублей без inst назначаем синтетические i1,i2,... — каждая копия отдельно, порядок стабилен
  const seen = {};
  src.forEach((g) => {
    if (!g.inst) {
      if (src.filter((x) => x.gid === g.gid).length > 1) {
        seen[g.gid] = (seen[g.gid] || 0) + 1;
        g.inst = "i" + seen[g.gid];
      } else g.inst = "";
    }
  });
  return src;
}

/* ============================================================
 * Витрина арендодателя по ссылке startapp=u_<uid>
 * ============================================================ */
async function renderShowcase() {
  const uid = S.viewShowcase;
  const lst = await getJSON(`data/listings/${uid}.json`);
  const deny = await getJSON("denylist.json");
  const blocked = deny && deny !== "404" && (deny.uids || []).map(String).includes(String(uid));
  $("#topbar").innerHTML = `<h1>Витрина</h1><div class="tb-right"><button class="btn sec sm" id="home">Все подарки</button></div>`;
  $("#home").onclick = () => { S.viewShowcase = null; setTab("market"); };
  if (blocked) { $("#view").innerHTML = `<div class="empty"><b style="color:var(--danger)">Витрина заблокирована</b>Не переводите деньги этому владельцу.</div>`; return; }
  if (!lst || lst === "404") { $("#view").innerHTML = `<div class="empty"><b>Витрина не найдена</b>Владелец ещё ничего не опубликовал.</div>`; return; }
  const owner = { uid: String(lst.uid), name: lst.name, uname: lst.uname };
  const gifts = (lst.gifts || []).map((g) => ({ ...g, owner }));
  $("#view").innerHTML = `
    <div class="p-head"><div class="avatar"><div>${esc((lst.name || "?").slice(0, 1).toUpperCase())}</div></div>
      <div class="p-stats"><div><b>${gifts.length}</b><span>подарков</span></div><div></div><div></div></div></div>
    <div class="p-body"><div class="p-name">${esc(lst.name || "Арендодатель")}</div>${lst.uname ? `<div class="p-handle">@${esc(lst.uname)}</div>` : ""}
      ${lst.about ? `<div class="p-about">${esc(lst.about)}</div>` : ""}
      <div style="margin-top:8px"><span class="vbadge ok">✓ Подарки сверены с профилем Telegram ботом @${esc(CONFIG.botUsername)}</span></div></div>
    ${lst.uname ? `<div class="btnrow"><button class="btn sec" id="wr">Написать @${esc(lst.uname)}</button></div>` : ""}
    <div style="height:10px"></div><div class="grid">${gifts.map(card).join("")}</div>
    ${lst.req && lst.req.length ? `<div class="section-title">Реквизиты</div><div class="card">${lst.req.map((r) => `<div class="req-item"><div><div class="l">${esc(r.l || "Реквизит")}</div><div class="v">${esc(r.v)}</div></div><button class="btn out sm" data-c="${esc(r.v)}">Копировать</button></div>`).join("")}</div>` : ""}
    <div class="hint" style="text-align:center;margin-top:14px"><button class="rlink" id="rep">Пожаловаться</button></div>`;
  bindCards(gifts, $("#view"));
  const wr = $("#wr"); if (wr) wr.onclick = () => openTg(`https://t.me/${lst.uname}`);
  $$("[data-c]").forEach((b) => b.onclick = async () => { await copy(b.dataset.c); haptic("ok"); toast(t("t_copied")); });
  $("#rep").onclick = () => openTg(`https://t.me/${CONFIG.botUsername}?start=rp_${encodeURIComponent(uid)}_x`);
}

/* ============================================================
 * init
 * ============================================================ */
async function applyTgUser() {
  const u = parseTgUserLive();
  if (!u || String(u.id) === S.uid) return false;
  S.user = u; S.uid = String(u.id);
  const [p, t, f] = await Promise.all([load(CONFIG.profileKey, null), load(CONFIG.termsKey, {}), load(CONFIG.favKey, {})]);
  if (p) S.profile = { ...S.profile, ...p };
  S.terms = t || S.terms; S.fav = f || S.fav;
  await Promise.all([loadMine(), loadOrders()]);
  render();
  return true;
}

async function init() {
  // ждём появления пользователя до ~3с (SDK мог не успеть)
  if (S.uid === "0") {
    for (let i = 0; i < 12 && S.uid === "0"; i++) {
      const u = parseTgUserLive();
      if (u) { S.user = u; S.uid = String(u.id); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // и дальше проверяем в фоне (если вебвью отдаст initData позже)
  setInterval(() => { if (S.uid === "0") applyTgUser(); }, 1500);
  // новый юзер: один раз показываем условия, пока он не примет их
  setTimeout(() => {
    if (S.uid === "0" || agreed()) return;
    try { if (localStorage.getItem("gr_about_seen_" + S.uid)) return; } catch (e) { return; }
    try { localStorage.setItem("gr_about_seen_" + S.uid, String(Date.now())); } catch (e) {}
    openAbout();
  }, 3000);
  $$(".tab").forEach((b) => b.addEventListener("click", () => { S.viewShowcase = null; S._userTab = b.dataset.tab; setTab(b.dataset.tab); }));
  $("#gadd").onclick = openAddRent;
  $("#pub").onclick = () => publish();
  const sp = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
  if (sp && sp.startsWith("u_")) S.viewShowcase = sp.slice(2);

  $("#view").innerHTML = `<div class="grid">${Array(6).fill(`<div class="gcard sk-card"><div class="gcanvas sk"></div><div class="ginfo"><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:45%"></div></div></div>`).join("")}</div>`;
  const [p, t, f] = await Promise.all([load(CONFIG.profileKey, null), load(CONFIG.termsKey, {}), load(CONFIG.favKey, {})]);
  if (p) S.profile = { ...S.profile, ...p };
  S.terms = t || {}; S.fav = f || {};
  S.showcase = S.viewShowcase ? { uid: S.viewShowcase } : null;
  if (!S._userTab) setTab(_pubMode ? "profile" : "market");  // не перетираем таб, выбранный юзером во время загрузки
  await Promise.all([loadCatalog(), loadMine(), loadOrders()]);
  recoverTerms();
  render();
  maybeAutoPublish();
  maybeAutoOrder();
  await recoverProfile(); if (S.tab === "profile") render();
  autoPollMine();
}

function autoPollMine() {
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  setInterval(async () => {
    if (document.hidden) return;
    // каталог: кто-то опубликовал/сменил цену -> обновляем ленту
    const c = await getJSON("data/catalog.json");
    let items = c && c !== "404" ? c.items || [] : [];
    // публикация в полёте (бот коммитит ~5-10с): не затираем свои оптимистичные записи репо-версией, где их ещё нет
    const pendingPub = S._pubWant != null && S._pubAt && Date.now() - S._pubAt < 25000;
    if (pendingPub) {
      const repoMine = items.filter((x) => x.owner && String(x.owner.uid) === S.uid)
        .map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|");
      if (repoMine !== S._pubWant) {
        items = items.filter((x) => !(x.owner && String(x.owner.uid) === S.uid))
          .concat((S.catalog || []).filter((x) => x.owner && String(x.owner.uid) === S.uid));
      }
    }
    if (items.length || (S.catalog || []).length) {
      if (!same(items, S.catalog)) {
        S.catalog = items;
        if (S.tab === "market" && !S.viewShowcase) render();
        if (S.tab === "fav") render();
        if (S.tab === "profile") { renderProfile(); confirmPublished(); }
      }
    }
    const hb = await getJSON("data/heartbeat.json"); if (hb && hb !== "404" && hb.ts) S.hb = hb.ts;
    if (S.uid === "0") return;
    const d = await getJSON(`data/gifts/${S.uid}.json`);
    const arr = d && d !== "404" ? d.gifts || [] : null;
    if (d && d !== "404" && d.updated) S.myGiftsUpd = d.updated;
    if (arr && !same(arr, S.myGifts === "pending" ? "pending" : S.myGifts)) {
      S.myGifts = arr;
      if (S.tab === "profile") { renderProfile(); }
      drawScanState();
    } else if (S.tab === "profile") drawScanState();
    const o = await getJSON(`data/orders/${S.uid}.json`);
    const orders = o && o !== "404" ? o.orders || [] : null;
    if (orders && !same(orders, S.orders)) { S.orders = orders; if (S.tab === "orders") render(); }
  }, 4000);
  // вернулся в мини-апп из бота -> сразу подтянуть свежее
  const onback = async () => {
    if (document.hidden) return;
    // вернулись из бота (нажал Start / подключил сканер): мгновенный перескан, прошлые отказы не считаются
    S._forceScan = true; S.liveFail = false; S._scanGaveUp = false; S._scanTmr = 0;
    startLiveScan();
    await Promise.all([loadCatalog(), loadMine(), loadOrders()]); render();
  };
  window.addEventListener("pageshow", onback);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) onback(); });
}
document.addEventListener("DOMContentLoaded", init);
