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
const _pubMode = new URLSearchParams(location.search).get("m") === "pub";
const _fromMenu = new URLSearchParams(location.search).get("src") === "menu";

function openAddRent() {
  if (S.uid === "0") { toast("Нужен вход через бота"); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=login`), 400); return; }
  setTab("profile");
  requestAnimationFrame(() => { const m = $("#mine"); if (m) m.scrollIntoView({ behavior: "smooth", block: "start" }); });
  toast("Включи подарки, укажи цену и нажми «Опубликовать»");
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
  $("#topbar").innerHTML = `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="q" type="search" placeholder="Поиск подарков и арендодателей" value="${esc(S.q)}"></div>`;
  const curs = ["all", ...CURRENCIES];
  $("#view").innerHTML = `
    <div class="infobanner" id="ib">
      <div class="ib-row"><span class="ib-name">\u{1F381} Gift Rent</span><span class="ib-found">основатель @dostonxoja</span></div>
      <div class="ib-text">Маркетплейс аренды подарков Telegram. Подключи профиль — подарки подхватятся автоматически.</div>
      <button class="btn out sm" id="ibmore">О сервисе и условиях</button>
    </div>
    <div class="chips">
      ${curs.map((c) => `<button class="chip ${S.cur === c ? "on" : ""}" data-cur="${c}">${c === "all" ? "Все" : c}</button>`).join("")}
      <button class="chip ${S.sort === "asc" ? "on" : ""}" data-sort="asc">Дешевле</button>
      <button class="chip ${S.sort === "desc" ? "on" : ""}" data-sort="desc">Дороже</button>
    </div>
    <div id="grid"></div>`;
  $("#ibmore").onclick = openAbout;
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
    box.innerHTML = `<div class="empty"><b>${S.catalog.length ? "Ничего не найдено" : "Пока нет подарков в аренде"}</b>${S.catalog.length ? "Измени поиск или фильтры." : "Арендодатели публикуют подарки в разделе «Профиль»."}</div>`;
    return;
  }
  box.innerHTML = `<div class="grid">${l.map(card).join("")}</div>`;
  bindCards(l, box);
}

/* ============================================================
 * FAVORITES
 * ============================================================ */
function renderFav() {
  $("#topbar").innerHTML = `<h1>Избранное</h1>`;
  const l = Object.values(S.fav);
  if (!l.length) { $("#view").innerHTML = `<div class="empty"><b>Пусто</b>Нажми на сердечко на карточке подарка.</div>`; return; }
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
  const rows = [["Модель", g.m, g.mr], ["Символ", g.s, g.sr], ["Фон", g.b || "", g.br]].filter((r) => r[1]);
  const isNft = g.num != null || !!(g.m || g.s || g.b);
  // тип подарка: NFT — уникальный (модель/узор/фон/номер/ссылка), обычный — просто эмодзи со звёздами
  const typeChip = `<div class="dchip ${isNft ? "nft" : "reg"}"><span>Тип</span><b>${isNft ? "Уникальный NFT" : "Обычный подарок"}</b></div>`;
  const starsChip = !isNft && g.stars ? `<div class="dchip"><span>Звёзды</span><b>${esc(g.stars)} ★</b></div>` : "";
  $("#sheet").innerHTML = `
    <div class="sheet-h"><span>${esc(g.dn || dname(g))}${g.num != null ? " #" + esc(g.num) : ""}</span><button class="sheet-x" id="x">×</button></div>
    <div class="dcanvas" style="--c1:${c1};--c2:${c2}">${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : "🎁"}</div>
    <div class="dchips">${typeChip}${starsChip}${rows.map((r) => `<div class="dchip"><span>${r[0]}</span><b>${esc(r[1])}</b>${r[2] ? `<i>${pct(r[2])}</i>` : ""}</div>`).join("")}</div>
    <div class="dprice">${g.p ? `${esc(money(g.p))} ${esc(g.cur || "")} <small>/ ${esc(g.per || "")}</small>` : g.stars ? `${esc(g.stars)} <small>★ в профиле</small>` : `<small>Цена по договорённости</small>`}</div>
    <div class="owner"><div class="oav">${esc((o.name || o.uname || "?").slice(0, 1).toUpperCase())}</div><div><b>${esc(o.name || "Арендодатель")}</b><span>${o.uname ? "@" + esc(o.uname) : "ID " + esc(o.uid)}</span></div></div>
    ${mine ? `<div class="hint" style="margin:0 0 10px">Это твой подарок.</div>` : `
    <div class="field"><label>Комментарий (срок, вопросы)</label><input id="oc" maxlength="80" placeholder="Например: на 3 дня"></div>
    <div class="row">
      <button class="btn" id="ord">Заказать аренду</button>
      ${g.g && isNft ? `<button class="btn out" id="nft">Открыть NFT</button>` : ""}
    </div>`}
    ${mine && g.g && isNft ? `<button class="btn out" id="nft" style="width:100%">Открыть NFT в Telegram</button>` : ""}`;
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  if ($("#nft")) $("#nft").onclick = () => openTg(`https://t.me/nft/${encodeURIComponent(String(g.g).toLowerCase())}`);
  const ord = $("#ord");
  if (ord) ord.onclick = async () => {
    const raw = JSON.stringify({ o: 1, lu: String(o.uid), g: g.g, p: g.p || "", cur: g.cur || "", per: g.per || "", c: ($("#oc").value || "").slice(0, 80) });
    // sendData: мгновенно, без копирования (доступен при входе с reply-кнопки)
    try {
      if (tg && tg.sendData) { haptic("ok"); toast("Заявка отправляется…"); $("#overlay").hidden = true; tg.sendData(raw); return; }
    } catch (e) { /* не поддержан — фолбэк ниже */ }
    const payload = b64e(raw);
    if (!(await copy(payload))) return toast("Не удалось скопировать заказ");
    haptic("ok"); toast("Заказ скопирован. Вставь его в чат бота.");
    $("#overlay").hidden = true;
    setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 600);
  };
}
document.addEventListener("click", (e) => { if (e.target === $("#overlay")) $("#overlay").hidden = true; });

/* ============================================================
 * ORDERS
 * ============================================================ */
function renderOrders() {
  const inc = S.orders || [], out = S.myOrders || [];
  if (S.ordersSeg === "in" && !inc.length && out.length) S.ordersSeg = "out";
  $("#topbar").innerHTML = `<h1>Заказы</h1><div class="tb-right"><button class="btn sec sm" id="rf">Обновить</button></div>`;
  $("#rf").onclick = async () => { await loadOrders(); renderOrders(); toast("Обновлено"); };
  localStorage.setItem("gr_seen_" + S.uid, String(Math.floor(Date.now() / 1000))); $("#ordersDot").hidden = true;
  const list = S.ordersSeg === "in" ? inc.slice().reverse() : out.slice().reverse();
  const when = (t) => new Date((t || 0) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const st = (s) => `<span class="ost ${s === "done" ? "done" : s === "cancelled" ? "cancelled" : "new"}">${s === "done" ? "выполнен" : s === "cancelled" ? "отменён" : "новый"}</span>`;
  $("#view").innerHTML = `
    <div class="seg"><button data-s="in" class="${S.ordersSeg === "in" ? "on" : ""}">Входящие · ${inc.length}</button><button data-s="out" class="${S.ordersSeg === "out" ? "on" : ""}">Мои · ${out.length}</button></div>
    ${list.length ? list.map((o) => `
      <div class="ocard">
        <div class="ohead"><b>№${esc(o.id)} · ${esc(o.name || "")} #${esc(o.num ?? "")}</b>${st(o.status)}</div>
        <div class="osub">${o.price ? esc(money(o.price)) + " " + esc(o.cur || "") + " / " + esc(o.per || "") : "по договорённости"} · ${esc(when(o.ts))}</div>
        ${S.ordersSeg === "in"
          ? `<div class="ocl">Клиент: ${o.client_username ? "@" + esc(o.client_username) : "ID " + esc(o.client_uid)}${o.comment ? " · «" + esc(o.comment) + "»" : ""}</div>
             ${o.status === "new" ? `<div class="oact">
               ${o.client_username ? `<button class="btn out sm" data-w="${esc(o.client_username)}">Написать</button>` : ""}
               <button class="btn sm" data-cmd="/done ${esc(o.id)}">Выполнен</button>
               <button class="btn danger sm" data-cmd="/cancel ${esc(o.id)}">Отмена</button></div>` : ""}`
          : `<div class="ocl">Арендодатель: ${o.owner_username ? "@" + esc(o.owner_username) : "ID " + esc(o.lu)}</div>`}
      </div>`).join("") : `<div class="empty"><b>Заказов нет</b>${S.ordersSeg === "in" ? "Когда клиент закажет подарок, бот пришлёт уведомление, а заказ появится здесь." : "Твои заказы на аренду появятся здесь."}</div>`}
    ${S.ordersSeg === "in" && list.length ? `<div class="hint">Кнопки «Выполнен» и «Отмена» копируют команду: отправь её боту.</div>` : ""}`;
  $$("[data-s]").forEach((b) => b.onclick = () => { S.ordersSeg = b.dataset.s; renderOrders(); });
  $$("[data-w]").forEach((b) => b.onclick = () => openTg(`https://t.me/${b.dataset.w}`));
  $$("[data-cmd]").forEach((b) => b.onclick = async () => { await copy(b.dataset.cmd); haptic("ok"); toast("Команда скопирована. Отправь её боту."); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 500); });
}

/* ============================================================
 * PROFILE (Instagram-style) + размещение подарков
 * ============================================================ */
function myListedCount() { return Array.isArray(S.myGifts) ? S.myGifts.filter((g) => (S.terms[g.gid] || {}).on).length : 0; }

async function startLiveScan() {
  if (!CONFIG.scanToken || S.uid === "0") return;
  const changed = await liveScan(S.uid);
  if (S.tab === "profile") { if (changed) renderProfile(); else drawScanState(); }
}
setInterval(() => { if (!document.hidden && S.tab === "profile") startLiveScan(); }, 5000);

function renderProfile() {
  const u = S.user || {};
  const name = S.profile.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || "Пользователь";
  const uname = S.profile.uname || u.username || "";
  const mineInCat = (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid).length;
  $("#topbar").innerHTML = `<h1>${uname ? "@" + esc(uname) : "Профиль"}</h1>`;
  $("#view").innerHTML = `
    <div class="p-head">
      <div class="avatar"><div>${u.photo_url ? `<img src="${esc(u.photo_url)}" alt="">` : esc(name.slice(0, 1).toUpperCase())}</div></div>
      <div class="p-stats">
        <div><b>${Array.isArray(S.myGifts) ? S.myGifts.length : 0}</b><span>подарков</span></div>
        <div><b>${mineInCat}</b><span>в аренде</span></div>
        <div><b>${(S.orders || []).filter((o) => o.status === "done").length}</b><span>сдач</span></div>
      </div>
    </div>
    <div class="p-body">
      <div class="p-name">${esc(name)}</div>
      ${uname ? `<div class="p-handle">@${esc(uname)}</div>` : ""}
      ${S.profile.about ? `<div class="p-about">${esc(S.profile.about)}</div>` : ""}
    </div>
    <div class="idrow"><div><small>Telegram ID</small><b>${S.uid === "0" ? "не определён" : esc(S.uid)}</b></div><button class="btn out sm" id="cid">${S.uid === "0" ? "Повторить" : "Копировать"}</button></div>
    <div class="btnrow"><button class="btn sec" id="edit">Редактировать</button><button class="btn sec" id="share">Моя витрина</button></div>

    <div class="section-title">Реквизиты для оплаты</div>
    <div class="card" id="req"></div>

    <div class="section-title">Сдать подарок в аренду</div>
    <div class="scanstate" id="scanstate"></div>
    <div id="mine"></div>
    <div class="hint">Включи переключатель, укажи цену и срок. Бот сверит подарки с твоим профилем, публикация мгновенная.</div>
    <button class="btn sec sm" id="about" style="margin:14px auto;display:block">О сервисе и условиях</button>`;
  $("#cid").onclick = async () => {
    if (S.uid === "0") { const ok = await applyTgUser(); if (!ok) { toast("Открываю бота для входа…"); setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=login`), 400); } return; }
    await copy(S.uid); haptic("ok"); toast("ID скопирован");
  };
  startLiveScan();
  $("#edit").onclick = openEdit;
  $("#share").onclick = shareShowcase;
  $("#about").onclick = openAbout;
  drawReq(); drawMine();
}

function drawReq() {
  const box = $("#req"); if (!box) return;
  box.innerHTML = S.profile.req.map((r, i) => `
    <div class="ritem"><input class="inp" data-rl="${i}" placeholder="Карта UZ" maxlength="30" value="${esc(r.l || "")}"><input class="inp" data-rv="${i}" placeholder="Номер / кошелёк" maxlength="120" value="${esc(r.v || "")}"><button class="del" data-rd="${i}">×</button></div>`).join("")
    + `<button class="rlink" id="radd">+ Добавить реквизит</button>`;
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
    if (!S.liveTs && !S.liveFail) { el.innerHTML = `<span class="spin"></span>Сканирую профиль Telegram…`; return; }
    if (S.liveTs) {
      const age = Math.max(0, Math.round((Date.now() - S.liveTs) / 1000));
      el.innerHTML = `<i class="dot-live"></i>Сканировано сейчас${age < 5 ? "" : " " + age + " с назад"}`;
      return;
    }
    // live-скан не удался (юзер не подключал скан-бота): показываем repo-статус ниже
  }
  if (S.myGifts === "pending") { el.innerHTML = `<span class="spin"></span>Сканирую профиль Telegram…`; return; }
  if (!Array.isArray(S.myGifts)) { el.innerHTML = ``; return; }
  // бот сканирует профиль каждые 2-10с; штамп подарков меняется только при изменении, поэтому живость берём из heartbeat
  const hbAge = S.hb ? Math.round(Date.now() / 1000 - S.hb) : null;
  el.innerHTML = hbAge != null && hbAge < 150
    ? `<i class="dot-live"></i>Профиль синхронизируется автоматически`
    : `<i class="dot-off"></i>Бот сейчас перезапускается, данные обновятся через минуту`;
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
      ? `<div class="empty"><b>В профиле Telegram нет подарков</b>Бот проверил твой профиль только что: подарков нет. Получишь подарок, он появится здесь сам через пару секунд.<span class="hint">Скрыты подарки? Открой Telegram → Профиль → Подарки и сделай их видимыми.</span></div>`
      : scanAsked() || S.liveTs
        ? `<div class="empty"><b>Подарки не найдены</b>Профиль подключён и синхронизируется автоматически: как только в Telegram появится подарок, он возникнет здесь сам.</div>`
        : `<div class="empty"><b>Подключи сканер один раз</b>Это нужно сделать единожды: дальше профиль обновляется сам, без вопросов.<button class="btn" id="scancta">Подключить (1 раз)</button></div>`;
    const cta = $("#scancta");
    if (cta) cta.onclick = () => { markScanAsked(); openTg(`https://t.me/${CONFIG.botUsername}?start=scan`); };
    return;
  }
  const repoIds = new Set((Array.isArray(S.myGifts) ? S.myGifts : []).map((g) => g.gid));
  const listedIds = new Set((S.catalog || []).filter((c) => c.owner && String(c.owner.uid) === S.uid).map((c) => String(c.g)));
  box.innerHTML = list.map((g) => {
    const t = S.terms[g.gid] || {};
    const listed = listedIds.has(g.gid);
    const c1 = hex(g.cc) || "#5aa7e0", c2 = hex(g.ec) || "#2b3f66";
    return `<div class="lrow ${listed ? "is-listed" : ""}" data-g="${esc(g.gid)}">
      <div class="lthumb" style="--c1:${c1};--c2:${c2}">${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : repoIds.has(g.gid) && g.th_fuid ? `<img src="assets/gifts/${esc(g.th_fuid)}.webp" alt="" onerror="this.remove()">` : g.th_fuid ? `<img data-livethumb="${esc(g.gid)}" alt="">` : "🎁"}</div>
      <div class="lmeta"><b>${esc(dname(g))}${g.num != null ? " #" + esc(g.num) : ""}${g.qty > 1 ? ` <em class="qty">×${g.qty}</em>` : ""}</b><span>${esc(g.model || (g.stars ? g.stars + " ★" : ""))}${g.mr ? " · " + pct(g.mr) : ""}</span></div>
      ${listed ? `<button class="unl" data-unl="${esc(g.gid)}">Снять</button>` : ""}
      <label class="switch"><input type="checkbox" ${t.on ? "checked" : ""}><i></i></label>
    </div>
    <div class="pform" data-pf="${esc(g.gid)}" ${t.on ? "" : "hidden"} style="padding:0 14px 12px;border-bottom:1px solid var(--line)">
      <div class="row"><input class="inp" data-p inputmode="decimal" placeholder="Цена" value="${esc(t.p || "")}">
        <select class="inp" data-c>${CURRENCIES.map((c) => `<option ${c === (t.cur || "UZS") ? "selected" : ""}>${c}</option>`).join("")}</select>
        <select class="inp" data-r>${PERIODS.map((c) => `<option ${c === (t.per || "день") ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    </div>`;
  }).join("");
  // подаркам только из live-скана: прямая ссылка на стикер через getFile
  $$("img[data-livethumb]", box).forEach(async (el) => {
    const gid = el.dataset.livethumb;
    const g = list.find((x) => x.gid === gid);
    if (!g) return;
    let u = await thumbUrl(g);
    if (!u) { await new Promise((r) => setTimeout(r, 900)); u = await thumbUrl(g); }
    // дубликат-подарки имеют один gid: ставим на сам элемент, фолбэк по DOM — на случай перерисовки
    if (u && el.isConnected) el.src = u;
    else { const cur = box.querySelector(`img[data-livethumb="${CSS.escape(gid)}"]`); if (u && cur) cur.src = u; else if (cur) cur.remove(); }
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
    $(".lmeta", row).onclick = async () => { const g = list.find((x) => x.gid === gid); if (g) openMyGiftDetail(g, repoIds.has(gid)); };
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
    <div class="sheet-h"><span>Редактировать профиль</span><button class="sheet-x" id="x">×</button></div>
    <div class="field"><label>Имя</label><input id="e1" maxlength="60" value="${esc(S.profile.name || [u.first_name, u.last_name].filter(Boolean).join(" "))}"></div>
    <div class="field"><label>Username для связи (без @)</label><input id="e2" maxlength="32" value="${esc(S.profile.uname || u.username || "")}"></div>
    <div class="field"><label>О себе / условия аренды</label><textarea id="e3" maxlength="300">${esc(S.profile.about)}</textarea></div>
    <button class="btn" id="e4" style="width:100%">Сохранить</button>`;
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  $("#e4").onclick = () => {
    S.profile.name = $("#e1").value.trim(); S.profile.uname = $("#e2").value.trim().replace(/^@/, ""); S.profile.about = $("#e3").value.trim();
    save(CONFIG.profileKey, S.profile); $("#overlay").hidden = true; renderProfile(); toast("Сохранено");
  };
}

function buildListing() {
  const gifts = mergeGifts().filter((g) => (S.terms[g.gid] || {}).on).map((g) => {
    const t = S.terms[g.gid]; return { g: g.gid, p: t.p || "", cur: t.cur || "UZS", per: t.per || "день" };
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
  savePubIntent((it.attempts || 0) + 1);
  toast("Завершаю публикацию…");
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
    toast("Данные восстановлены из каталога");
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
  if (!obj.gifts.length && !wasListed && !force) return toast("Включи хотя бы один подарок");
  // идемпотентность: локальное состояние совпадает с опубликованным -> повтор не нужен, бот не дёргаем
  if (!force) {
    const wantNow = obj.gifts.map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|");
    if (wantNow === myCatalogKey()) { haptic(); toast("Уже опубликовано"); clearPubIntent(); return; }
  }
  const raw = JSON.stringify(obj);
  const btn = $("#pub");
  const want = obj.gifts.map((g) => g.g + ":" + g.p + g.cur + g.per).sort().join("|");

  // оптимистично: у арендодателя каталог обновляется мгновенно, без ожидания бота
  const me = { uid: S.uid, name: obj.name, uname: obj.uname };
  const known = mergeGifts();
  S.catalog = (S.catalog || []).filter((c) => !(c.owner && String(c.owner.uid) === S.uid)).concat(obj.gifts.map((g) => {
    const k = known.find((x) => x.gid === g.g) || {};
    return { g: g.g, n: k.name || "", m: k.model || "", s: k.symbol || "", num: k.num, cc: k.cc, ec: k.ec, mr: k.mr, sr: k.sr, br: k.br,
      b: k.backdrop || "", t: k.th_fuid ? `assets/gifts/${k.th_fuid}.webp` : "", p: g.p, cur: g.cur, per: g.per, ts: Math.floor(Date.now() / 1000), owner: me, _local: 1 };
  }));
  S._pubWant = want; S._pubAt = Date.now(); S._pubWasEmpty = !obj.gifts.length;
  if (btn) btn.classList.add("busy");
  haptic("ok"); toast("Публикую…");
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
      toast("Откроется бот: нажми «Сдать подарок» внизу (публикация сама завершится). Или вставь скопированное и отправь.");
      setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=pub`), 900);
      return;
    }
    toast("Не удалось отправить. Нажми «Сдать подарок» внизу в чате бота и попробуй снова.");
    return;
  }
  savePubIntent();
  haptic("ok");
  toast("Откроется бот: нажми «Сдать подарок» внизу — публикация завершится сама.");
  setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}?start=pub`), 1100);
}

const ABOUT_TEXT = `
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
  </div>`;
function agreed() { try { return !!localStorage.getItem("gr_agree_" + S.uid); } catch (e) { return false; } }
function openAbout() {
  $("#sheet").innerHTML = ABOUT_TEXT + (agreed()
    ? `<div class="sheet-f"><button class="btn sec" id="abclose">Закрыть</button></div>`
    : `<div class="sheet-f"><button class="btn" id="agreebtn">\u2705 Принимаю условия</button></div>`);
  $("#overlay").hidden = false;
  $("#x").onclick = () => ($("#overlay").hidden = true);
  const c = $("#abclose"); if (c) c.onclick = () => ($("#overlay").hidden = true);
  const ab = $("#agreebtn"); if (ab) ab.onclick = () => {
    try { localStorage.setItem("gr_agree_" + S.uid, String(Date.now())); } catch (e) {}
    haptic("ok"); toast("Спасибо! Условия приняты");
    $("#overlay").hidden = true;
  };
}
async function shareShowcase() {
  const l = (S.catalog || []).filter((g) => g.owner && String(g.owner.uid) === S.uid);
  if (!l.length) return toast("Сначала опубликуй подарки в каталог");
  const link = `https://t.me/${CONFIG.botUsername}/${CONFIG.appShortName}?startapp=u_${S.uid}`;
  await copy(link); haptic("ok"); toast("Ссылка на твою витрину скопирована");
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
          gifts.push({ gid: u.id || "", name: u.title || stk.emoji || "", num: null,
            model: "", symbol: "", backdrop: "", cc: null, ec: null, mr: null, sr: null, br: null,
            th_fuid: st.file_unique_id, th_fid: st.file_id, p: g.type, stars: u.star_count });
          continue;
        }
        const model = u.model || {}, symbol = u.symbol || {}, backdrop = u.backdrop || {};
        const colors = backdrop.colors || {};
        const thumb = ((model.sticker || {}).thumbnail) || {};
        gifts.push({ gid: u.name || `${u.gift_id}#${u.number}`, name: u.base_name || "",
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

// одинаковые обычные подарки (общий gid типа) = одна строка с количеством; NFT уникальны по имени
function groupGifts(list) {
  const m = new Map();
  for (const g of list) {
    const k = g.gid;
    if (m.has(k)) m.get(k).qty += 1; else m.set(k, { ...g, qty: 1 });
  }
  return [...m.values()];
}
function mergeGifts() {
  // прямой скан приоритетнее: он свежее репо-данных
  const live = S.liveGifts;
  const src = (!Array.isArray(live) || !live.length) ? (Array.isArray(S.myGifts) ? S.myGifts : []) : (() => {
    const byGid = {};
    (Array.isArray(S.myGifts) ? S.myGifts : []).forEach((g) => { byGid[g.gid] = g; });
    return live.map((g) => { const repo = byGid[g.gid]; return repo && repo.t ? { ...g, t: repo.t } : g; });
  })();
  return groupGifts(src);
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
  $$("[data-c]").forEach((b) => b.onclick = async () => { await copy(b.dataset.c); haptic("ok"); toast("Скопировано"); });
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
  }, 2500);
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
