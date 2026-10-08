"use strict";

/* ============================================================
 * КОНФИГ
 * ============================================================ */
const CONFIG = {
  botUsername: "free_rental_bot", // бот из BotFather
  appShortName: "gifts",          // short name из BotFather /newapp
  storageKey: "gift_rental_profile_v2",
  termsKey: "gift_rental_terms_v1",
  payloadLimit: 3800,

  // публичный ключ подписи витрин (приватный лежит в GitHub Secrets бота)
  verifyKey: {"kty":"EC","crv":"P-256","x":"GQ1mE9ZzXYcYxW6yLoBD3lzMYOpQd60ntJgUPdY7nLo","y":"5JBfRbOwbZD4bb1yEutCIQeFw3eB7inih9agTkGLs3g","key_ops":["verify"],"ext":true},
  denylistUrl: "denylist.json",
};

const PERIODS = ["час", "день", "неделя", "месяц", "ед."];
const CURRENCIES = ["UZS", "RUB", "USD", "USDT", "TON"];

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }

/* ============================================================
 * Утилиты
 * ============================================================ */
const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function haptic(type) {
  try {
    if (tg && tg.HapticFeedback) {
      if (type === "success") tg.HapticFeedback.notificationOccurred("success");
      else tg.HapticFeedback.impactOccurred("light");
    }
  } catch (e) {}
}

function rgbHex(n) {
  if (typeof n !== "number" || isNaN(n)) return null;
  return "#" + n.toString(16).padStart(6, "0");
}

function rarityPct(rpm) {
  if (typeof rpm !== "number" || isNaN(rpm)) return "";
  return (rpm / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%";
}

function fmtPrice(v) {
  const n = parseFloat(String(v).replace(",", "."));
  if (isNaN(n)) return v;
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256B64url(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return bytesToB64url(new Uint8Array(d));
}

async function verifySignature(payloadStr, sigStr) {
  if (!CONFIG.verifyKey) return "off";
  if (!window.crypto || !crypto.subtle) return "nocrypto";
  try {
    const key = await crypto.subtle.importKey(
      "jwk", CONFIG.verifyKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      b64urlToBytes(sigStr), new TextEncoder().encode(payloadStr));
    return ok ? "valid" : "invalid";
  } catch (e) {
    return "nocrypto";
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function openTg(url) {
  if (tg && tg.openTelegramLink && (url.startsWith("https://t.me/") || url.startsWith("tg://"))) tg.openTelegramLink(url);
  else window.open(url, "_blank");
}

/* ============================================================
 * Хранилище: Telegram CloudStorage + фолбэк localStorage
 * ============================================================ */
function csAvailable() {
  return !!(tg && tg.CloudStorage && typeof tg.CloudStorage.getItem === "function");
}

function csGet(key) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => finish(null), 2500);
    try {
      const p = tg.CloudStorage.getItem(key, (err, val) => finish(err ? null : val));
      if (p && p.then) p.then((r) => finish(Array.isArray(r) ? (r[0] ? null : r[1]) : null)).catch(() => finish(null));
    } catch (e) { finish(null); }
  });
}

function csSet(key, val) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    setTimeout(() => finish(false), 2500);
    try {
      const p = tg.CloudStorage.setItem(key, val, (err) => finish(!err));
      if (p && p.then) p.then((r) => finish(Array.isArray(r) ? !r[0] : true)).catch(() => finish(false));
    } catch (e) { finish(false); }
  });
}

async function loadKey(key) {
  let raw = null;
  if (csAvailable()) raw = await csGet(key);
  if (!raw) raw = localStorage.getItem(key);
  try {
    const data = raw ? JSON.parse(raw) : null;
    if (data && typeof data === "object") return data;
  } catch (e) {}
  return null;
}

let saveTimer = null;
function scheduleSave(key, obj) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const raw = JSON.stringify(obj);
    try { localStorage.setItem(key, raw); } catch (e) {}
    if (csAvailable()) {
      const ok = await csSet(key, raw);
      if (!ok) toast("Не сохранилось в облако Telegram, сохранено на устройстве");
    }
  }, 400);
}

/* ============================================================
 * Модель
 * ============================================================ */
function defaultProfile() {
  return {
    display_name: "",
    about: "",
    username: "",
    sell_price: "",
    sell_currency: "UZS",
    requisites: [],
  };
}

function defaultTerms() {
  return {}; // { gid: {p, cur, per, av} }
}

function currentUid() {
  try {
    return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id)
      ? String(tg.initDataUnsafe.user.id) : "0";
  } catch (e) { return "0"; }
}

const state = {
  mode: "editor",
  uid: "0",
  profile: null,
  terms: null,
  myGifts: null,     // [{gid, name, num, model, symbol, cc, ec, mr, sr, br, th_fuid}]
  showcase: null,
  payloadStr: null,
  sig: null,
  giftSearch: "",
};

/* ============================================================
 * Мои подарки (реальные, от бота)
 * ============================================================ */
async function fetchMyGifts() {
  const uid = state.uid;
  if (!uid || uid === "0") return null;
  try {
    const res = await fetch(`data/gifts/${uid}.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) return "pending";
    if (!res.ok) return null;
    const d = await res.json();
    return d.gifts || [];
  } catch (e) { return null; }
}

/* ============================================================
 * Редактор
 * ============================================================ */
function renderEditor() {
  $("#btnToEditor").hidden = true;
  $("#view").innerHTML = `
    <div class="section">
      <div class="section-title">Профиль витрины</div>
      <div class="card">
        <div class="field">
          <label>Название / ваше имя</label>
          <input type="text" id="f_name" maxlength="60" placeholder="Doston Gifts" value="${esc(state.profile.display_name)}">
        </div>
        <div class="field">
          <label>О коллекции</label>
          <textarea id="f_about" maxlength="400" placeholder="Условия аренды, залог, сроки">${esc(state.profile.about)}</textarea>
        </div>
        <div class="field">
          <label>Telegram для связи (без @)</label>
          <input type="text" id="f_username" maxlength="32" placeholder="username" value="${esc(state.profile.username)}">
        </div>
        <div class="row">
          <div class="field">
            <label>Цена коллекции целиком</label>
            <input type="text" id="f_sellprice" inputmode="decimal" placeholder="1000000" value="${esc(state.profile.sell_price)}">
          </div>
          <div class="field narrow">
            <label>Валюта</label>
            <select id="f_sellcur">${CURRENCIES.map((c) => `<option value="${c}" ${c === state.profile.sell_currency ? "selected" : ""}>${c}</option>`).join("")}</select>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Реквизиты для оплаты</div>
      <div class="card" id="req_box"></div>
      <div class="hint">Увидит только тот, кому вы отправите ссылку на витрину.</div>
    </div>

    <div class="section">
      <div class="section-title">Заказы на аренду</div>
      <div id="orders_box"></div>
    </div>

    <div class="section">
      <div class="section-title">Мои подарки (реальные, из профиля Telegram)</div>
      <div id="gifts_stats"></div>
      <div class="field" id="gifts_search_box" style="margin-bottom:10px">
        <input type="text" id="giftSearch" placeholder="Поиск: название, модель, символ, №" maxlength="40">
      </div>
      <div class="gift-list" id="gift_list"></div>
      <div class="hint" id="gifts_status"></div>
    </div>

    <div class="section">
      <div class="hint" style="text-align:center">
        Кнопка внизу копирует пейлоад витрины и открывает бота: вставь его в чат,
        бот сверит подарки с твоим профилем и вернёт подписанную витрину.
      </div>
    </div>
  `;

  const bind = (id, prop) => {
    const el = $("#" + id);
    if (el) el.addEventListener("input", () => { state.profile[prop] = el.value; scheduleSave(CONFIG.storageKey, state.profile); });
  };
  bind("f_name", "display_name");
  bind("f_about", "about");
  bind("f_username", "username");
  bind("f_sellprice", "sell_price");
  const selCur = $("#f_sellcur");
  if (selCur) selCur.addEventListener("change", () => { state.profile.sell_currency = selCur.value; scheduleSave(CONFIG.storageKey, state.profile); });

  const search = $("#giftSearch");
  if (search) search.addEventListener("input", () => { state.giftSearch = search.value.trim().toLowerCase(); renderMyGifts(); });

  renderRequisites();
  renderMyGifts();
  renderOrders();

  const action = async () => {
    const payload = buildPayloadString();
    if (!payload) return;
    await copyText(payload);
    haptic("success");
    toast("Пейлоад скопирован. Вставь его в чат бота и отправь.");
    setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 700);
  };

  if (tg && tg.MainButton) {
    tg.MainButton.setText("Верифицировать витрину");
    tg.MainButton.show();
    tg.MainButton.offClick(action);
    tg.MainButton.onClick(action);
  } else {
    document.querySelectorAll(".fab").forEach((el) => el.remove());
    const fab = document.createElement("div");
    fab.className = "fab fab-row";
    fab.innerHTML = `<button class="btn">Верифицировать витрину</button>
      <button class="btn secondary" id="fabShare">Скопировать ссылку без подписи</button>`;
    fab.querySelector(".btn").addEventListener("click", action);
    $("#fabShare").addEventListener("click", shareUnsigned);
    document.body.appendChild(fab);
  }
}

/* ---------- Реквизиты ---------- */
function renderRequisites() {
  const box = $("#req_box");
  box.innerHTML = state.profile.requisites
    .map((r, i) => `
      <div class="item-row">
        <input type="text" class="req-label" data-i="${i}" maxlength="30" placeholder="Карта UZ" value="${esc(r.label || "")}">
        <input type="text" class="req-value" data-i="${i}" maxlength="120" placeholder="8600 12xx xxxx xxxx" value="${esc(r.value || "")}">
        <button class="del" data-i="${i}" title="Удалить">×</button>
      </div>`)
    .join("") + `<button class="btn ghost" id="btnAddReq" style="padding:8px 0 0">+ Добавить реквизит</button>`;

  box.querySelectorAll(".req-label").forEach((el) =>
    el.addEventListener("input", () => { state.profile.requisites[el.dataset.i].label = el.value; scheduleSave(CONFIG.storageKey, state.profile); }));
  box.querySelectorAll(".req-value").forEach((el) =>
    el.addEventListener("input", () => { state.profile.requisites[el.dataset.i].value = el.value; scheduleSave(CONFIG.storageKey, state.profile); }));
  box.querySelectorAll(".del").forEach((el) =>
    el.addEventListener("click", () => { state.profile.requisites.splice(+el.dataset.i, 1); scheduleSave(CONFIG.storageKey, state.profile); renderRequisites(); }));
  $("#btnAddReq").addEventListener("click", () => {
    state.profile.requisites.push({ label: "", value: "" });
    scheduleSave(CONFIG.storageKey, state.profile);
    renderRequisites();
    const inputs = box.querySelectorAll(".req-label");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
}

/* ---------- Мои подарки ---------- */
function editorStats(gifts) {
  const all = gifts || [];
  const active = all.filter((g) => {
    const t = state.terms[g.gid] || {};
    return t.av !== false;
  });
  let sum = 0, priced = 0;
  const curCount = {};
  active.forEach((g) => {
    const t = state.terms[g.gid] || {};
    const n = parseFloat(String(t.p || "").replace(",", "."));
    if (!isNaN(n)) { sum += n; priced++; curCount[t.cur || "UZS"] = (curCount[t.cur || "UZS"] || 0) + 1; }
  });
  const mainCur = Object.keys(curCount).sort((a, b) => curCount[b] - curCount[a])[0] || "UZS";
  return { all: all.length, active: active.length, priced, sum: sum ? fmtPrice(sum) + " " + mainCur : "" };
}

function renderMyGifts() {
  const list = $("#gift_list");
  const status = $("#gifts_status");
  const statsBox = $("#gifts_stats");
  const searchBox = $("#gifts_search_box");

  if (state.uid === "0") {
    if (statsBox) statsBox.innerHTML = "";
    if (searchBox) searchBox.hidden = true;
    list.innerHTML = `<div class="empty">Открой мини-апп из Telegram, чтобы увидеть свои подарки.</div>`;
    status.textContent = "";
    return;
  }
  if (state.myGifts === "pending") {
    if (statsBox) statsBox.innerHTML = "";
    if (searchBox) searchBox.hidden = true;
    list.innerHTML = `<div class="empty">Подарки ещё подтягиваются: нажми /start боту, бот обновляет списки каждые ~10 минут.</div>`;
    status.innerHTML = `<button class="btn ghost" id="btnReloadGifts" style="padding:4px">Обновить</button>`;
    $("#btnReloadGifts").addEventListener("click", async () => {
      state.myGifts = await fetchMyGifts();
      renderMyGifts();
    });
    return;
  }
  if (!state.myGifts || !state.myGifts.length) {
    if (statsBox) statsBox.innerHTML = "";
    if (searchBox) searchBox.hidden = true;
    list.innerHTML = `<div class="empty">Уникальных подарков в профиле не найдено.</div>`;
    status.textContent = "";
    return;
  }

  const st = editorStats(state.myGifts);
  statsBox.innerHTML = `
    <div class="stat-bar">
      <div class="stat"><b>${st.all}</b><span>подарков</span></div>
      <div class="stat"><b>${st.active}</b><span>на витрине</span></div>
      <div class="stat"><b>${st.priced}</b><span>с ценой</span></div>
      ${st.sum ? `<div class="stat"><b>${esc(st.sum)}</b><span>сумма цен</span></div>` : ""}
    </div>`;
  searchBox.hidden = false;

  const q = state.giftSearch;
  const filtered = q ? state.myGifts.filter((g) =>
    [g.name, g.model, g.symbol, g.uniq, g.num, g.backdrop].some(
      (v) => v != null && String(v).toLowerCase().includes(q))) : state.myGifts;

  status.textContent = `${state.myGifts.length} уникальных подарков · ${filtered.length} показано · цена пустая = «по договорённости»`;

  list.innerHTML = filtered.map((g) => {
    const t = state.terms[g.gid] || {};
    const av = t.av !== false;
    const thumb = g.th_fuid ? `assets/gifts/${esc(g.th_fuid)}.webp` : "";
    const c1 = rgbHex(g.cc) || "#5aa7e0";
    return `
      <div class="gift-row" data-gid="${esc(g.gid)}">
        <div class="gift-thumb" style="background: radial-gradient(circle at 50% 42%, ${c1}, var(--card))">
          ${thumb ? `<img src="${thumb}" alt="" onerror="this.remove()">` : "🎁"}
        </div>
        <div class="gift-meta">
          <div class="name">${esc(g.name || "Подарок")} #${esc(g.num ?? "")}</div>
          <div class="sub">${esc(g.model || "")}${rarityPct(g.mr) ? " · " + rarityPct(g.mr) : ""} · ${esc(g.symbol || "")}</div>
        </div>
        <div class="gift-terms">
          <input type="text" class="gt-price" inputmode="decimal" placeholder="цена" value="${esc(t.p || "")}">
          <div class="row">
            <select class="gt-cur">${CURRENCIES.map((c) => `<option value="${c}" ${c === (t.cur || "UZS") ? "selected" : ""}>${c}</option>`).join("")}</select>
            <select class="gt-per">${PERIODS.map((c) => `<option value="${c}" ${c === (t.per || "месяц") ? "selected" : ""}>${c}</option>`).join("")}</select>
          </div>
          <label class="checkline"><input type="checkbox" class="gt-av" ${av ? "checked" : ""}> на витрине</label>
        </div>
      </div>`;
  }).join("");

  list.querySelectorAll(".gift-row").forEach((row) => {
    const gid = row.dataset.gid;
    const setTerm = (prop, val) => {
      const t = state.terms[gid] || (state.terms[gid] = {});
      t[prop] = val;
      scheduleSave(CONFIG.termsKey, state.terms);
      const st2 = editorStats(state.myGifts);
      const sb = $("#gifts_stats");
      if (sb) sb.innerHTML = `
        <div class="stat-bar">
          <div class="stat"><b>${st2.all}</b><span>подарков</span></div>
          <div class="stat"><b>${st2.active}</b><span>на витрине</span></div>
          <div class="stat"><b>${st2.priced}</b><span>с ценой</span></div>
          ${st2.sum ? `<div class="stat"><b>${esc(st2.sum)}</b><span>сумма цен</span></div>` : ""}
        </div>`;
    };
    row.querySelector(".gt-price").addEventListener("input", (e) => setTerm("p", e.target.value));
    row.querySelector(".gt-cur").addEventListener("change", (e) => setTerm("cur", e.target.value));
    row.querySelector(".gt-per").addEventListener("change", (e) => setTerm("per", e.target.value));
    row.querySelector(".gt-av").addEventListener("change", (e) => setTerm("av", e.target.checked));
  });
}


/* ============================================================
 * Заказы (от бота)
 * ============================================================ */
async function fetchOrders() {
  const uid = state.uid;
  if (!uid || uid === "0") return null;
  try {
    const res = await fetch(`data/orders/${uid}.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) return { orders: [] };
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function renderOrders() {
  const box = $("#orders_box");
  if (!box) return;
  box.innerHTML = `<div class="empty">Загрузка заказов...</div>`;
  fetchOrders().then((d) => {
    const b = $("#orders_box");
    if (!b) return;
    if (!d) { b.innerHTML = `<div class="empty">Заказы недоступны прямо сейчас.</div>`; return; }
    const items = (d.orders || []).slice().reverse();
    if (!items.length) {
      b.innerHTML = `<div class="empty">Заказов пока нет. Отправь витрину клиентам: они жмут «Заказать аренду», ты получаешь уведомление от бота.</div>`;
      return;
    }
    b.innerHTML = items.map((it) => {
      const st = it.status === "done" ? `<span class="ost done">выполнен</span>`
        : it.status === "cancelled" ? `<span class="ost cancelled">отменён</span>`
        : `<span class="ost new">новый</span>`;
      const cust = it.client_username ? "@" + esc(it.client_username) : "ID " + esc(it.client_uid);
      const ts = new Date((it.ts || 0) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `
        <div class="order-card">
          <div class="order-head">
            <b>№${esc(it.id)} · ${esc(it.name || "")} #${esc(it.num ?? "")}</b>
            ${st}
          </div>
          <div class="order-sub">${esc(it.price ? fmtPrice(it.price) + " " + it.cur + " / " + it.per : "по договорённости")} · ${esc(ts)}</div>
          <div class="order-client">Клиент: ${cust}${it.comment ? ` · «${esc(it.comment)}»` : ""}</div>
        </div>`;
    }).join("") +
    `<div class="hint">Статусы меняются в боте: /orders — список, /done № — выполнен, /cancel № — отменён.</div>`;
  });
}

/* ============================================================
 * Сборка витрины
 * ============================================================ */
function buildShowcaseObject() {
  const gifts = (state.myGifts && Array.isArray(state.myGifts) ? state.myGifts : [])
    .filter((g) => {
      const t = state.terms[g.gid] || {};
      return t.av !== false;
    })
    .map((g) => {
      const t = state.terms[g.gid] || {};
      return {
        g: g.gid,
        n: g.name || "",
        m: g.model || "",
        s: g.symbol || "",
        num: g.num,
        cc: g.cc,
        ec: g.ec,
        mr: g.mr,
        sr: g.sr,
        br: g.br,
        t: g.th_fuid ? `assets/gifts/${g.th_fuid}.webp` : "",
        p: t.p || "",
        cur: t.cur || "UZS",
        per: t.per || "месяц",
      };
    });
  return {
    v: 2,
    uid: state.uid,
    name: state.profile.display_name || "",
    about: state.profile.about || "",
    uname: state.profile.username || "",
    sell: state.profile.sell_price || "",
    cur: state.profile.sell_currency || "UZS",
    req: state.profile.requisites.filter((r) => r.value),
    gifts,
  };
}

function buildPayloadString() {
  const obj = buildShowcaseObject();
  if (!obj.gifts.length) {
    toast("Витрина пуста: включи подарки в разделе «Мои подарки».");
    return null;
  }
  const payload = b64urlEncode(JSON.stringify(obj));
  if (payload.length > CONFIG.payloadLimit) {
    toast("Витрина слишком большая для ссылки (~4 КБ): сократи описания или уменьши количество подарков.");
    return null;
  }
  return payload;
}

async function shareUnsigned() {
  const payload = buildPayloadString();
  if (!payload) return;
  const link = `https://t.me/${CONFIG.botUsername}/${CONFIG.appShortName}?startapp=${payload}`;
  await copyText(link);
  toast("Ссылка скопирована (без верификации). Для зелёного значка верифицируй через бота.");
}

/* ============================================================
 * Витрина (просмотр)
 * ============================================================ */
function renderStorefront() {
  const p = state.showcase;
  const gifts = p.gifts || [];
  const initials = (p.name || "?").trim().slice(0, 1).toUpperCase();

  $("#btnToEditor").hidden = false;
  $("#view").innerHTML = `
    <div class="hero">
      <div class="avatar">${esc(initials)}</div>
      <h1>${esc(p.name || "Витрина подарков")}</h1>
      <div id="verifyBadge"></div>
      ${p.about ? `<div class="about">${esc(p.about)}</div>` : ""}
      ${p.sell ? `
        <div class="collection-price">
          <span class="val">${esc(fmtPrice(p.sell))}</span>
          <span class="cur">${esc(p.cur || "")} · вся коллекция</span>
        </div>` : ""}
    </div>

    <div class="section">
      <div class="section-title">Подарки · ${gifts.length}</div>
      <div class="grid">
        ${gifts.map((g, i) => renderGiftCard(g, i)).join("")}
      </div>
    </div>

    ${
      p.req && p.req.length
        ? `
        <div class="section">
          <div class="section-title">Реквизиты для оплаты</div>
          <div class="card">
            ${p.req.map((r) => `
              <div class="req-item">
                <div>
                  <div class="label">${esc(r.l || r.label || "Реквизит")}</div>
                  <div class="value">${esc(r.v || r.value || "")}</div>
                </div>
                <button class="copy" data-copy="${esc(r.v || r.value || "")}">Копировать</button>
              </div>`).join("")}
          </div>
        </div>`
        : ""
    }

    ${
      p.uname
        ? `<div class="section">
             <button class="btn secondary" id="btnContact">Написать @${esc(p.uname)}</button>
           </div>`
        : ""
    }

    <div class="footer-note">
      Аренда оплачивается переводом по реквизитам. Условия уточняйте у владельца.<br>
      <button class="btn ghost" id="btnReport" style="padding:4px">Пожаловаться</button>
    </div>
  `;

  document.querySelectorAll("[data-copy]").forEach((el) =>
    el.addEventListener("click", async () => {
      const ok = await copyText(el.dataset.copy);
      toast(ok ? "Скопировано" : "Не удалось скопировать");
      if (ok) haptic("success");
    }));

  document.querySelectorAll(".gift-card").forEach((el) =>
    el.addEventListener("click", () => openGiftDetail(+el.dataset.idx)));

  const contact = $("#btnContact");
  if (contact) contact.addEventListener("click", () => openTg(`https://t.me/${encodeURIComponent(p.uname)}`));

  $("#btnReport").addEventListener("click", async () => {
    const h = await sha256B64url(state.payloadStr);
    openTg(`https://t.me/${CONFIG.botUsername}?start=rp_${encodeURIComponent(String(p.uid || 0))}_${h.slice(0, 12)}`);
  });

  if (tg && tg.MainButton) tg.MainButton.hide();
  securityPass();
}

function renderGiftCard(g, idx) {
  const c1 = rgbHex(g.cc) || "#5aa7e0";
  const c2 = rgbHex(g.ec) || "#2b3f66";
  const price = g.p
    ? `${esc(fmtPrice(g.p))} ${esc(g.cur || "")} <span class="sub">/ ${esc(g.per || "")}</span>`
    : `<span class="sub">по договорённости</span>`;
  return `
    <div class="gift-card" data-idx="${idx}">
      <div class="gc-canvas" style="--c1:${c1};--c2:${c2}">
        ${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : "🎁"}
        <div class="gc-num">#${esc(g.num ?? "")}</div>
      </div>
      <div class="gc-body">
        <div class="name">${esc(g.n || g.g || "Подарок")}</div>
        <div class="attrs">${esc(g.m || "")} · ${esc(g.s || "")}</div>
        <div class="price">${price}</div>
      </div>
    </div>
  `;
}

/* ---------- Детальный просмотр подарка ---------- */
function openGiftDetail(idx) {
  const g = (state.showcase.gifts || [])[idx];
  if (!g) return;
  haptic("light");

  const c1 = rgbHex(g.cc) || "#5aa7e0";
  const c2 = rgbHex(g.ec) || "#2b3f66";
  const chips = [
    ["Модель", g.m, g.mr],
    ["Символ", g.s, g.sr],
    ["Фон", null, g.br],
  ].filter(([, label]) => label !== null);

  const sheet = $("#sheet");
  sheet.innerHTML = `
    <div class="sheet-title">
      <span>${esc(g.n || g.g || "Подарок")} · #${esc(g.num ?? "")}</span>
      <button class="sheet-close" id="detailClose">×</button>
    </div>
    <div class="detail-canvas" style="--c1:${c1};--c2:${c2}">
      ${g.t ? `<img src="${esc(g.t)}" alt="" onerror="this.remove()">` : "🎁"}
      <div class="gc-num">#${esc(g.num ?? "")}</div>
    </div>
    <div class="detail-name">${esc(g.n || g.g || "Подарок")}</div>
    <div class="detail-chips">
      ${chips.map(([label, val, rar]) => `
        <div class="dchip">
          <span>${label}</span>
          <b>${esc(val || "—")}</b>
          ${rar ? `<i>${rarityPct(rar)}</i>` : ""}
        </div>`).join("")}
    </div>
    <div class="detail-price">
      ${g.p ? `${esc(fmtPrice(g.p))} ${esc(g.cur || "")} <span class="sub">/ ${esc(g.per || "")}</span>`
             : "Цена по договорённости"}
    </div>
    <div class="field" style="margin:12px 0 4px">
      <label>Комментарий к заказу (необязательно, до 80 символов)</label>
      <input type="text" id="orderComment" maxlength="80" placeholder="На какой срок, вопросы...">
    </div>
    <div class="fab-row">
      <button class="btn" id="detailOrder">Заказать аренду</button>
      <button class="btn secondary" id="detailNft">Ссылка на NFT</button>
    </div>
    <div class="hint" style="text-align:center; margin-top:8px">
      Подарок и атрибуты сверены с профилем Telegram при верификации витрины.
    </div>
  `;
  $("#overlay").hidden = false;

  $("#detailClose").addEventListener("click", () => { $("#overlay").hidden = true; });
  $("#detailNft").addEventListener("click", async () => {
    if (!g.g) { toast("Имя подарка недоступно"); return; }
    const url = `https://t.me/nft/${encodeURIComponent(String(g.g).toLowerCase())}`;
    openTg(url);
  });
  const w = $("#detailWrite");
  if (w) w.addEventListener("click", () => openTg(`https://t.me/${encodeURIComponent(state.showcase.uname)}`));

  $("#detailOrder").addEventListener("click", async () => {
    const g2 = g;
    const comment = ($("#orderComment") && $("#orderComment").value || "").slice(0, 80);
    const orderObj = {
      o: 1,
      lu: String(state.showcase.uid || ""),
      g: g2.g || "",
      p: g2.p || "",
      cur: g2.cur || "",
      per: g2.per || "",
      c: comment,
    };
    const payload = b64urlEncode(JSON.stringify(orderObj));
    const ok = await copyText(payload);
    if (!ok) { toast("Не удалось скопировать заказ, попробуй ещё раз"); return; }
    haptic("success");
    toast("Заказ скопирован. Вставь его в чат бота и отправь.");
    setTimeout(() => openTg(`https://t.me/${CONFIG.botUsername}`), 700);
    $("#overlay").hidden = true;
  });
}

/* ---------- Проверка безопасности ---------- */
async function securityPass() {
  const badge = $("#verifyBadge");
  if (!badge) return;

  let blocked = false;
  try {
    const res = await fetch(CONFIG.denylistUrl + "?t=" + Date.now(), { cache: "no-store" });
    if (res.ok) {
      const list = await res.json();
      const uid = String(state.showcase.uid || "");
      const hash = await sha256B64url(state.payloadStr);
      if ((list.uids || []).map(String).includes(uid) ||
          (list.hashes || []).includes(hash)) blocked = true;
    }
  } catch (e) {}
  if (blocked) { renderBlocked(); return; }

  if (!state.sig) {
    badge.innerHTML = `<span class="vbadge warn">⚠ Витрина не верифицирована. Проверьте владельца у бота @${esc(CONFIG.botUsername)} перед оплатой</span>`;
    return;
  }
  const result = await verifySignature(state.payloadStr, state.sig);
  if (result === "valid") {
    badge.innerHTML = `<span class="vbadge ok">✓ Подарки сверены с профилем Telegram и подписаны ботом @${esc(CONFIG.botUsername)}</span>`;
    haptic("success");
  } else if (result === "invalid") {
    badge.innerHTML = `<span class="vbadge bad">✕ Подпись недействительна: витрина изменена после проверки</span>`;
  } else {
    badge.innerHTML = `<span class="vbadge warn">⚠ Витрина с подписью, но устройство не смогло её проверить</span>`;
  }
}

function renderBlocked() {
  $("#view").innerHTML = `
    <div class="section" style="padding-top:40px">
      <div class="card" style="text-align:center; border:1px solid var(--danger)">
        <div style="font-size:40px; margin-bottom:10px">🚫</div>
        <h2 style="color:var(--danger); margin-bottom:8px">Витрина заблокирована</h2>
        <div class="hint" style="font-size:14px">
          Эта витрина внесена в стоп-лист за нарушения или жалобы.
          Не переводите деньги её владельцу.
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
 * Инициализация
 * ============================================================ */
async function init() {
  state.uid = currentUid();

  const startParam = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
  if (startParam && startParam.startsWith("eyJ")) {
    const dot = startParam.indexOf(".");
    state.payloadStr = dot < 0 ? startParam : startParam.slice(0, dot);
    state.sig = dot < 0 ? null : startParam.slice(dot + 1);
    try {
      state.showcase = JSON.parse(b64urlDecode(state.payloadStr));
      state.mode = "storefront";
    } catch (e) { state.mode = "editor"; }
  }

  $("#btnToEditor").addEventListener("click", async () => {
    state.mode = "editor";
    state.profile = (await loadKey(CONFIG.storageKey)) || defaultProfile();
    state.terms = (await loadKey(CONFIG.termsKey)) || defaultTerms();
    state.myGifts = await fetchMyGifts();
    renderEditor();
  });

  $("#overlay").addEventListener("click", (e) => {
    if (e.target === $("#overlay")) { $("#overlay").hidden = true; }
  });

  if (state.mode === "storefront") {
    renderStorefront();
  } else {
    state.profile = (await loadKey(CONFIG.storageKey)) || defaultProfile();
    state.terms = (await loadKey(CONFIG.termsKey)) || defaultTerms();
    state.myGifts = await fetchMyGifts();
    renderEditor();
  }
}

document.addEventListener("DOMContentLoaded", init);
