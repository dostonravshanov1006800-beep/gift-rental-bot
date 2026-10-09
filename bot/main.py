"""gift-rental-bot: поллинг-бот для аренды NFT-подарков.

Живёт в GitHub Actions (keep-alive). Данные хранит коммитами в репозиторий:
data/users.json, data/gifts/<uid>.json, denylist.json, data/complaints.json.

Функции:
  /start            регистрация, стартовое сообщение
  /myid             показать свой Telegram ID
  /verify <payload> проверка подарков юзера через getUserGifts и подпись витрины
  /block <id>       (админ) блокировка в denylist
  /complaints       (админ) список жалоб
  фоновый цикл      каждые 10 минут обновляет data/gifts/*.json и стикеры
"""
import asyncio
import base64
import itertools
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
import html
import re
from urllib.parse import quote

import aiohttp

import signing
from repo import Repo, RepoError


class GiftsFetchError(Exception):
    """getUserGifts упал (flood/сеть): список неполный, данные юзера менять НЕЛЬЗЯ."""

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bot")

BOT_TOKEN = os.environ["BOT_TOKEN"]
REPO_NAME = os.environ.get("REPO", "")
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
SIGNING_KEY_PEM = os.environ.get("SIGNING_KEY", "")
ADMIN_IDS = {x for x in os.environ.get("ADMIN_IDS", "").replace(" ", "").split(",") if x}

REFRESH_INTERVAL = 45  # сек, цикл обновления подарков
API = f"https://api.telegram.org/bot{BOT_TOKEN}"
# второй бот-сканер (@free_gifte_bot): getUserGifts работает с любым токеном,
# round-robin удваивает пропускную способность скана и даёт failover.
# Токен живёт ТОЛЬКО в secrets/env серверной части, в публичный JS не попадает.
SCAN2_TOKEN = os.environ.get("SCAN2_TOKEN", "")
_scan_apis = [API] + ([f"https://api.telegram.org/bot{SCAN2_TOKEN}"] if SCAN2_TOKEN else [])
_scan_rr = itertools.cycle(_scan_apis)

repo = Repo(GH_TOKEN or None, REPO_NAME or None)
priv_key = signing.load_private(SIGNING_KEY_PEM) if SIGNING_KEY_PEM else None
BOT_USERNAME = None


# ---------------------------------------------------------------- helpers
def b64url_decode(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    while len(s) % 4:
        s += "="
    return base64.b64decode(s)


async def tg_call(session, method, payload=None, api=None):
    async with session.post(f"{api or API}/{method}", json=payload or {}) as r:
        data = await r.json()
        if not data.get("ok"):
            log.warning("%s -> %s", method, data)
        return data


async def send_text(session, chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return await tg_call(session, "sendMessage", payload)


# ---------------------------------------------------------------- guard
def h(s):
    """HTML-escape динамических частей сообщений (send_text шлёт parse_mode=HTML)."""
    return html.escape(str(s or ""), quote=False)


def clean(s, n):
    """Вырезать управляющие символы и HTML-знаки из пользовательской строки + лимит длины."""
    return re.sub(r"[\x00-\x1f<>]", "", str(s or ""))[:n]


_RATE: dict[str, float] = {}


def rate_limited(uid, key, sec):
    """Анти-спам: не чаще одного действия `key` на юзера за `sec` секунд."""
    k = f"{uid}:{key}"
    now = time.time()
    if now - _RATE.get(k, 0) < sec:
        return True
    _RATE[k] = now
    if len(_RATE) > 4096:
        for x in list(_RATE)[:2048]:
            _RATE.pop(x, None)
    return False


_DENY: dict = {"ts": 0.0, "uids": set()}

async def deny_blocked(session, uid) -> bool:
    """Denylist в памяти: перечитывается раз в 5 мин и сразу после /block.
    При сбое чтения работаем по кэшу и НЕ пропускаем никого лишнего."""
    if not repo.enabled:
        return False
    if time.time() - _DENY["ts"] > 300:
        _DENY["ts"] = time.time()
        try:
            deny = await repo.get_json(session, "denylist.json", {"uids": []}) or {"uids": []}
            _DENY["uids"] = {str(x) for x in deny.get("uids", [])}
        except RepoError as e:
            log.warning("denylist не прочитан, работаем по кэшу: %s", e)
    return str(uid) in _DENY["uids"]

def _h12(key) -> str:
    """Первые 12 символов base64url(SHA-256(key)) — компактный ключ подарка для диплинков."""
    return base64.urlsafe_b64encode(hashlib.sha256(str(key).encode()).digest()).decode().rstrip("=")[:12]

def _ikey(g) -> str:
    """Ключ экземпляра подарка: gid#inst (как в app.js ikey())."""
    return str(g.get("gid") or "") + (("#" + str(g.get("inst") or "")) if g.get("inst") else "")


# ---------------------------------------------------------------- gifts
async def fetch_user_gifts(session, user_id) -> list[dict]:
    """getUserGifts с пагинацией. Ошибка -> GiftsFetchError: пустой список наружу не отдаём,
    иначе build_user_files сотрёт подарки юзера, а handle_publish всю его витрину."""
    gifts, offset = [], ""
    _seen: dict[str, int] = {}
    try:
        for _ in range(20):
            api = next(_scan_rr)
            data = await tg_call(session, "getUserGifts",
                                 {"user_id": int(user_id), "offset": offset, "limit": 100},
                                 api=api)
            if not data.get("ok") and api != API:
                # failover: второй клиент сломался (токен отозван / 429 / сеть) -> сразу основной
                log.warning("scan client #2 failed (%s), fallback to main", data.get("description"))
                data = await tg_call(session, "getUserGifts",
                                     {"user_id": int(user_id), "offset": offset, "limit": 100})
            if not data.get("ok"):
                raise GiftsFetchError(f"{user_id}: {data.get('description')}")
            res = data["result"]
            for g in res.get("gifts", []):
                if g.get("is_burned"):
                    continue
                if g.get("type") != "unique":
                    # обычный / коллекционный: имя = эмодзи, без модели и фона
                    u = g.get("gift", {})
                    st = u.get("sticker", {}) or {}
                    thumb = st.get("thumbnail", {}) or {}
                    base = u.get("id") or ""
                    _seen[base] = _seen.get(base, 0) + 1
                    inst = str(g.get("owned_gift_id") or "") or f"i{_seen[base]}"
                    gifts.append({
                        "gid": base,
                        "inst": inst,
                        "name": u.get("title") or st.get("emoji") or "",
                        "uniq": "", "num": None,
                        "model": "", "symbol": "", "backdrop": "",
                        "cc": None, "ec": None, "mr": None, "sr": None, "br": None,
                        "th_fuid": thumb.get("file_unique_id"),
                        "th_fid": thumb.get("file_id"),
                        "p": g.get("type"), "stars": u.get("star_count"),
                    })
                    continue
                if True:
                    u = g.get("gift", {})
                    model = u.get("model", {})
                    symbol = u.get("symbol", {})
                    backdrop = u.get("backdrop", {})
                    colors = backdrop.get("colors", {})
                    st = model.get("sticker", {}) or {}
                    thumb = st.get("thumbnail", {}) or {}
                    base = u.get("name") or f"{u.get('gift_id')}#{u.get('number')}"
                    _seen[base] = _seen.get(base, 0) + 1
                    inst = str(g.get("owned_gift_id") or "") or f"i{_seen[base]}"
                    gifts.append({
                        "gid": base,
                        "inst": inst,
                        "name": u.get("base_name", ""),
                        "uniq": u.get("name", ""),
                        "num": u.get("number"),
                        "model": model.get("name", ""),
                        "symbol": symbol.get("name", ""),
                        "backdrop": backdrop.get("name", ""),
                        "cc": colors.get("center_color"),
                        "ec": colors.get("edge_color"),
                        "mr": model.get("rarity_per_mille"),
                        "sr": symbol.get("rarity_per_mille"),
                        "br": backdrop.get("rarity_per_mille"),
                        "th_fuid": thumb.get("file_unique_id"),
                        "th_fid": thumb.get("file_id"),
                        "p": "unique",
                    })
            offset = res.get("next_offset")
            if not offset:
                break
        return gifts
    except GiftsFetchError:
        raise
    except Exception as e:
        raise GiftsFetchError(f"{user_id}: {e!r}")


async def fetch_giftmeta(session) -> dict | None:
    """api.changes.tg (открытый API @GiftChanges, без ключей): рыночные цены аукционов Telegram.
    Ошибка -> None: data/giftmeta.json не трогаем (старые данные лучше, чем никаких)."""
    try:
        async with session.get("https://api.changes.tg/auctions",
                               timeout=aiohttp.ClientTimeout(total=25)) as r:
            aucs = await r.json(content_type=None)
        mkt = {}
        for a in aucs or []:
            name = (a.get("name") or "").strip()
            if not name:
                continue
            mkt[name.lower()] = {"avg": a.get("averagePrice"), "n": a.get("totalGifts"),
                                 "fin": bool(a.get("finished"))}
        for a in aucs or []:
            name = (a.get("name") or "").strip()
            if not name:
                continue
            try:
                async with session.get(f"https://api.changes.tg/auction/{quote(name)}/rounds",
                                       timeout=aiohttp.ClientTimeout(total=25)) as r:
                    rd = await r.json(content_type=None)
                rounds = rd.get("rounds") if isinstance(rd, dict) else None
                last = (rounds or [])[-1] if rounds else None
                if last and last.get("clearingPrice"):
                    ts = None
                    try:
                        ts = int(datetime.fromisoformat(
                            last["endedAt"].replace("Z", "+00:00")).timestamp()) if last.get("endedAt") else None
                    except Exception:
                        pass
                    mkt[name.lower()].update({"p": last.get("clearingPrice"), "t": ts})
            except Exception:
                continue
        if not mkt:
            return None
        return {"updated": int(time.time()), "mkt": mkt}
    except Exception as e:
        log.warning("giftmeta: пропускаем, %s", repr(e)[:140])
        return None

async def download_thumb(session, file_id) -> bytes | None:
    data = await tg_call(session, "getFile", {"file_id": file_id})
    if not data.get("ok"):
        return None
    path = data["result"].get("file_path")
    if not path:
        return None
    async with session.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{path}") as r:
        if r.status == 200:
            return await r.read()
    return None


_gift_hash: dict[int, str] = {}


async def build_user_files(session, uid) -> tuple:
    """Собирает изменившиеся файлы подарков. Глобальные _gift_hash/KNOWN_THUMBS НЕ трогает:
    их обновляет вызывающий код ПОСЛЕ успешного коммита (сбой коммита = повтор на следующем тике).
    Возвращает (files, hash, new_thumbs)."""
    gifts = await fetch_user_gifts(session, uid)
    body = json.dumps({"uid": uid, "gifts": gifts}, ensure_ascii=False, sort_keys=True)
    h = hashlib.md5(body.encode()).hexdigest()
    files: dict = {}
    if _gift_hash.get(uid) != h:
        files[f"data/gifts/{uid}.json"] = json.dumps(
            {"uid": uid, "updated": int(time.time()), "gifts": gifts},
            ensure_ascii=False, sort_keys=True).encode()
    new_thumbs: list = []
    async def one(g):
        fuid, fid = g.get("th_fuid"), g.get("th_fid")
        if not fuid or not fid or fuid in KNOWN_THUMBS:
            return
        img = await download_thumb(session, fid)
        if img:   # пометим известным только реально скачанный стикер
            files[f"assets/gifts/{fuid}.webp"] = img
            new_thumbs.append(fuid)
    await asyncio.gather(*[one(g) for g in gifts])
    return files, h, new_thumbs


KNOWN_THUMBS: set = set()
_last_touch: dict[int, float] = {}
_KB_SENT: set = set()


async def ensure_keyboard(session, chat_id, from_user):
    """Reply-клавиатура с web_app: единственный режим, где мини-апп может вызвать sendData (мгновенная публикация/заказ)."""
    uid = from_user.get("id")
    if not uid or uid in _KB_SENT or not REPO_NAME:
        return
    _KB_SENT.add(uid)
    base = f"https://{REPO_NAME.split('/')[0]}.github.io/{REPO_NAME.split('/')[-1]}/"
    url = f"{base}?u={uid}"
    await tg_call(session, "sendMessage", {
        "chat_id": chat_id, "text": "Кнопки обновлены: «Открыть» и «Сдать подарок» внизу.",
        "reply_markup": {"keyboard": [[{"text": "Открыть", "web_app": {"url": url + "&m=mkt"}},
                                        {"text": "Сдать подарок", "web_app": {"url": url + "&m=pub"}}]],
                         "resize_keyboard": True, "is_persistent": True}})
LAST_SEEN: dict[int, float] = {}


async def refresh_user(session, uid) -> bool:
    if not repo.enabled:
        return False
    try:
        files, h, thumbs = await build_user_files(session, uid)
    except GiftsFetchError as e:
        log.warning("скан %s пропущен (ошибка, старые данные НЕ затёрты): %s", uid, e)
        return False
    if not files:
        return False
    ok = await repo.commit_files(session, files, f"bot: подарки {uid}")
    if ok:   # только теперь запоминаем: без записи в репо хеш не трогаем
        _gift_hash[uid] = h
        KNOWN_THUMBS.update(thumbs)
    return ok


async def maybe_touch_user(session, uid, force=False):
    """При любом сообщении от юзера обновить его подарки. Троттлинг 8с, кроме явного /start (force)."""
    if not uid or not repo.enabled:
        return
    now = time.time()
    if not force and now - _last_touch.get(uid, 0) < 8:
        return
    _last_touch[uid] = now
    try:
        await refresh_user(session, uid)
    except Exception:
        log.exception("touch %s упал", uid)


_USERS_CACHE: dict = {"ts": 0.0, "users": []}


async def get_users_cached(session, max_age=300):
    """Список юзеров из памяти; GitHub API дёргаем раз в max_age с, а не на каждый тик скана."""
    now = time.time()
    if now - _USERS_CACHE["ts"] > max_age or not _USERS_CACHE["users"]:
        users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
        _USERS_CACHE["users"] = users.get("users", [])
        _USERS_CACHE["ts"] = now
    return _USERS_CACHE["users"]


async def refresh_all_users(session, hot_only=False):
    """Подарки юзеров параллельно, один коммит при изменениях (md5-skip).
    Горячие (активны за 15 мин) сканируются каждый тик, остальные — реже."""
    if not repo.enabled:
        return
    now = time.time()
    targets = []
    for u in await get_users_cached(session):
        hot = now - LAST_SEEN.get(u["id"], 0) < 900
        if hot or not hot_only:
            targets.append(u)
    if not targets:
        return
    hashes, thumbs_all = {}, {}
    async def one(u):
        try:
            files, h, thumbs = await build_user_files(session, u["id"])
            return {**files, "__h": (u["id"], h, thumbs)}
        except GiftsFetchError as e:
            log.warning("скан %s пропущен: %s", u.get("id"), e); return {}
    parts = await asyncio.gather(*[one(u) for u in targets])
    changed = {}
    for p in parts:
        meta = p.pop("__h", None)
        if meta:
            hashes[meta[0]], thumbs_all[meta[0]] = meta[1], meta[2]
        changed.update(p)
    ok = True
    if changed:
        ok = await repo.commit_files(session, changed, f"bot: подарки ({len(targets)} проф.)")
    if ok:
        for uid_, h_ in hashes.items():
            _gift_hash[uid_] = h_
        for uid_, th_ in thumbs_all.items():
            KNOWN_THUMBS.update(th_)


# ---------------------------------------------------------------- catalog
LISTINGS: dict = {}


async def rebuild_catalog(session):
    """Собирает data/catalog.json из data/listings/*.json (плоский список подарков в аренде)."""
    # RepoError наверх: при сбое чтения каталог НЕ собираем пустым и НЕ коммитим
    users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
    deny = await repo.get_json(session, "denylist.json", {"uids": [], "hashes": []}) or {}
    blocked = {str(x) for x in deny.get("uids", [])}
    items = []
    for u in users.get("users", []):
        uid = str(u["id"])
        if uid in blocked:
            continue
        lst = LISTINGS.get(uid)
        if lst is None:
            lst = await repo.get_json(session, f"data/listings/{uid}.json") or {}
            LISTINGS[uid] = lst
        if not lst:
            continue
        owner = {"uid": uid, "name": lst.get("name") or u.get("first", ""),
                 "uname": lst.get("uname") or u.get("username", "")}
        for g in lst.get("gifts", []):
            items.append({**g, "owner": owner})
    items.sort(key=lambda x: -int(x.get("ts", 0)))
    return json.dumps({"updated": int(time.time()), "items": items}, ensure_ascii=False).encode()


def find_gift(gifts, key):
    """Ключ = gid (легаси) или gid#inst (уникальный экземпляр)."""
    if "#" in str(key):
        base, inst = str(key).split("#", 1)
        for r in gifts:
            if r.get("gid") == base and str(r.get("inst") or "") == inst:
                return r
        return None
    for r in gifts:
        if r.get("gid") == key:
            return r
    return None


async def handle_publish(session, chat_id, from_id, obj):
    """Лендлорд публикует листинг (тип l=1). Сверка с getUserGifts, запись, пересборка каталога."""
    if str(obj.get("uid")) != str(from_id):
        await send_text(session, chat_id, "Отказано: uid не совпадает с твоим аккаунтом.")
        return
    if await deny_blocked(session, from_id):
        await send_text(session, chat_id, "Доступ ограничен.")
        return
    if rate_limited(from_id, "pub", 5):
        await send_text(session, chat_id, "Не так часто: предыдущая публикация ещё обрабатывается.")
        return
    try:
        real = await fetch_user_gifts(session, from_id)
    except GiftsFetchError as e:
        log.warning("publish %s: скан упал, витрину НЕ трогаем: %s", from_id, e)
        await send_text(session, chat_id, "Не удалось проверить профиль, повтори через минуту.")
        return
    out, fake = [], []
    now = int(time.time())

    def entry(r, p_, cur_, per_):
        return {
            "g": _ikey(r), "inst": r.get("inst", ""), "n": r.get("name", ""), "m": r.get("model", ""), "s": r.get("symbol", ""),
            "num": r.get("num"), "cc": r.get("cc"), "ec": r.get("ec"),
            "mr": r.get("mr"), "sr": r.get("sr"), "br": r.get("br"), "b": r.get("backdrop", ""),
            "t": f"assets/gifts/{r['th_fuid']}.webp" if r.get("th_fuid") else "",
            "p": str(p_ or "")[:20], "cur": str(cur_ or "UZS")[:5],
            "per": str(per_ or "месяц")[:10], "ts": now,
        }

    if obj.get("grp"):
        # компактный формат (>40 подарков): сгруппирован по цене, ключи = h12-хеши
        by_h = {_h12(_ikey(r)): r for r in real}
        for grp in (obj.get("grp") or [])[:200]:
            p_, cur_, per_ = clean(grp.get("p"), 20), clean(grp.get("cur") or "UZS", 5), clean(grp.get("per") or "месяц", 10)
            for h12 in (grp.get("g") or [])[:100]:
                r = by_h.get(str(h12)[:12])
                if not r:
                    fake.append(clean(h12, 24)); continue
                out.append(entry(r, p_, cur_, per_))
    else:
        for g in (obj.get("gifts") or [])[:100]:
            r = find_gift(real, g.get("g"))
            if not r:
                fake.append(clean(g.get("g"), 24)); continue
            out.append(entry(r, clean(g.get("p"), 20), str(g.get("cur") or "UZS")[:5], str(g.get("per") or "месяц")[:10]))
    if fake:
        await send_text(session, chat_id, "Этих подарков нет в профиле, пропущены: " + ", ".join(fake))
    listing = {
        "uid": str(from_id), "name": clean(obj.get("name"), 60),
        "uname": re.sub(r"[^A-Za-z0-9_]", "", str(obj.get("uname") or ""))[:32],
        "about": clean(obj.get("about"), 300),
        "req": [{"l": clean(r.get("l") or r.get("label"), 30),
                 "v": clean(r.get("v") or r.get("value"), 120)}
                for r in (obj.get("req") or [])[:6]],
        "gifts": out, "updated": now,
    }
    if not repo.enabled:
        await send_text(session, chat_id, "Репозиторий не подключён.")
        return
    try:
        cat = await rebuild_catalog(session)
    except RepoError:
        await send_text(session, chat_id, "Сервис перегружен, повтори через минуту.")
        return
    ok = await repo.commit_files(session, {
        f"data/listings/{from_id}.json": json.dumps(listing, ensure_ascii=False).encode(),
        "data/catalog.json": cat}, f"bot: листинг {from_id} ({len(out)})")
    if ok:
        LISTINGS[str(from_id)] = listing   # кэш только после успешной записи
    await send_text(session, chat_id,
        f"✅ Опубликовано: {len(out)}. Уже в каталоге." if ok else "⚠️ Не удалось сохранить, повтори через минуту.")

# ---------------------------------------------------------------- orders
async def handle_deeplink_order(session, from_user, arg):
    """Заказ по диплинку /start o_<lu>_<h12> (мини-апп открыт из меню/inline: sendData не работает).
    Цену берём из листинга арендодателя, НЕ из клиента."""
    parts = arg.split("_", 1)
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1]:
        return
    lu, h12 = parts[0], clean(parts[1], 12)
    try:
        gdata = await repo.get_json(session, f"data/gifts/{lu}.json", {"gifts": []}) or {"gifts": []}
        lst = await repo.get_json(session, f"data/listings/{lu}.json") or {}
    except RepoError:
        await send_text(session, from_user["id"], "Сервис перегружен, повтори через минуту.")
        return
    key = next((k for k in (_ikey(g) for g in gdata.get("gifts", [])) if _h12(k) == h12), None)
    if not key:
        await send_text(session, from_user["id"], "Этот подарок уже недоступен: витрина обновилась.")
        return
    lg = next((x for x in (lst.get("gifts") or []) if str(x.get("g")) == key), {})
    coid = f"dl-{from_user['id']}-{h12}-{int(time.time()) // 3600}"
    await handle_order(session, from_user, {
        "o": 1, "lu": lu, "g": key,
        "p": lg.get("p", ""), "cur": lg.get("cur", ""), "per": lg.get("per", ""),
        "c": "", "coid": coid})


async def handle_order(session, from_user, obj):
    """Клиент вставил пейлоад заказа: {o:1, lu, g, p, cur, per, c}. Или диплинк-объект от бота."""
    if await deny_blocked(session, from_user.get("id")):
        await send_text(session, from_user["id"], "Доступ ограничен.")
        return
    lu = clean(obj.get("lu"), 20)
    gid = clean(obj.get("g"), 64)
    coid = clean(obj.get("coid"), 64)
    price = clean(obj.get("p"), 20)
    cur = clean(obj.get("cur"), 5)
    per = clean(obj.get("per"), 10)
    comment = clean(obj.get("c"), 150)
    if not lu or not gid:
        await send_text(session, from_user["id"], "Заказ неполный: нет арендодателя или подарка.")
        return

    try:
        landlord = next((u for u in await get_users_cached(session) if str(u["id"]) == lu), None)
        # gifts через contents API: у raw.githubusercontent кэш до 5 минут,
        # свежий подарок отклонялся бы как «витрина устарела»
        gdata = await repo.get_json(session, f"data/gifts/{lu}.json", {"gifts": []}) or {"gifts": []}
    except RepoError:
        await send_text(session, from_user["id"], "Сервис перегружен, повтори через минуту.")
        return
    if not landlord:
        await send_text(session, from_user["id"], "Арендодатель не найден в системе.")
        return
    gift = find_gift(gdata.get("gifts", []), gid)
    if not gift:
        await send_text(session, from_user["id"],
            "Этого подарка нет в коллекции арендодателя. Витрина устарела.")
        return

    opath = f"data/orders/{lu}.json"
    mpath = f"data/my_orders/{from_user['id']}.json"
    # дедуп ДО rate-limit: легитимный повтор (двойной тап) молча проглатывается
    try:
        existing = await repo.get_json(session, opath, {"orders": [], "seq": 0}) or {"orders": [], "seq": 0}
    except RepoError:
        await send_text(session, from_user["id"], "Сервис перегружен, повтори через минуту.")
        return
    if coid and any(str(o.get("coid")) == coid for o in existing.get("orders", [])):
        return   # дубль доставки: клиент и арендодатель уже получили уведомления
    if rate_limited(from_user.get("id"), "ord", 3):
        # анти-спам: не чаще одного заказа на юзера в 3 секунды
        await send_text(session, from_user["id"], "Предыдущий заказ ещё обрабатывается, подожди пару секунд.")
        return

    state = {"dup": False, "seq": 0}
    fu, g_, lu_ = from_user, gift, lu
    def mut(d):
        orders, mine = d[opath], d[mpath]
        if coid and any(str(o.get("coid")) == coid for o in orders.get("orders", [])):
            state["dup"] = True   # параллельный дубль: под замком он уже записан
            return d
        seq = int(orders.get("seq") or 0) + 1
        orders["seq"] = seq
        state["seq"] = seq
        orders.setdefault("orders", []).append({
            "id": str(seq), "coid": coid,
            "gid": gid, "name": h(g_.get("name", "")), "num": g_.get("num"),
            "price": price, "cur": cur, "per": per, "comment": comment,
            "client_uid": fu["id"],
            "client_username": fu.get("username", ""),
            "client_first": fu.get("first_name", ""),
            "ts": int(time.time()), "status": "new",
        })
        orders["orders"] = orders["orders"][-200:]
        mine["orders"] = (mine.get("orders") or [])[-100:] + [{
            "id": str(seq), "coid": coid, "lu": lu_, "name": h(g_.get("name", "")), "num": g_.get("num"),
            "price": price, "cur": cur, "per": per,
            "ts": int(time.time()), "status": "new",
            "owner_username": landlord.get("username", "")}]
        d[opath], d[mpath] = orders, mine
        return d
    try:
        # оба файла под одним замковым набором: параллельные заказы не перезапишут друг друга
        _, saved = await repo.update_jsons(session,
            {opath: {"orders": [], "seq": 0}, mpath: {"orders": []}},
            mut, f"bot: заказ для {lu}")
    except RepoError:
        await send_text(session, from_user["id"], "Сервис перегружен, повтори через минуту.")
        return
    if state["dup"]:
        return
    seq = state["seq"]

    cust = ("@" + from_user["username"]) if from_user.get("username") \
        else f"tg://user?id={from_user['id']}"
    num_part = f" #{h(str(gift.get('num')))}" if gift.get("num") not in (None, "") else ""
    price_part = f"{price} {cur} / {per}" if price else "по договорённости"
    notified = (await send_text(session, int(lu),
        f"📦 <b>Новый заказ #{seq}</b>\n"
        f"🎁 {h(gift.get('name',''))}{num_part}\n"
        f"💰 {price_part}\n"
        f"👤 Клиент: {cust} (ID {from_user['id']})\n"
        + (f"💬 {h(comment)}\n" if comment else "")
        + f"\nЦену клиент указал сам: сверься с витриной. Ответь клиенту, договорись о залоге и сроках.\n"
          f"/done {seq} — выполнен · /cancel {seq} — отмена")).get("ok", False)

    who = ("@" + re.sub(r"[^A-Za-z0-9_]", "", str(landlord.get("username") or ""))) \
        if landlord.get("username") else "арендодатель"
    # честный ответ клиенту: успех = заказ записан И арендодатель уведомлён
    if saved and notified:
        await send_text(session, from_user["id"],
            f"✅ Заказ #{seq} отправлен {who}. Он свяжется с тобой в Telegram.")
    elif saved and not notified:
        await send_text(session, from_user["id"],
            f"⚠️ Заказ #{seq} сохранён, но уведомление {who} не доставлено (возможно, бот у него заблокирован). "
            f"Напиши ему сам: {who}.")
    else:
        await send_text(session, from_user["id"],
            "⚠️ Заказ не сохранился: проблема с хранилищем, Telegram повторит доставку через минуту. "
            "Если через 5 минут не придёт подтверждение — отправь заказ ещё раз.")


async def handle_orders_list(session, from_id):
    orders = await repo.get_json(session, f"data/orders/{from_id}.json") or {"orders": []}
    items = orders.get("orders", [])
    if not items:
        await send_text(session, from_id, "Заказов пока нет.")
        return
    lines = []
    for it in items[-10:]:
        ts = time.strftime("%d.%m %H:%M", time.gmtime(it.get("ts", 0)))
        mark = {"new": "🆕", "done": "✅", "cancelled": "✖"}.get(it.get("status"), "•")
        num_part = f" #{it.get('num')}" if it.get("num") not in (None, "") else ""
        lines.append(f"{mark} #{it['id']} {it.get('name','')}{num_part} "
                     f"— {it.get('price') or '—'} {it.get('cur','')} ({ts})")
    lines.append("\n/done <№> — выполнить, /cancel <№> — отменить")
    await send_text(session, from_id, "\n".join(lines))


async def handle_order_status(session, from_id, oid, status):
    opath = f"data/orders/{from_id}.json"
    try:
        orders = await repo.get_json(session, opath) or {"orders": []}
    except RepoError:
        await send_text(session, from_id, "Сервис перегружен, повтори через минуту.")
        return
    it = next((o for o in orders.get("orders", []) if str(o.get("id")) == str(oid)), None)
    if not it:
        await send_text(session, from_id, f"Заказ #{oid} не найден.")
        return
    cpath = f"data/my_orders/{it['client_uid']}.json" if it.get("client_uid") else None
    paths = {opath: {"orders": []}}
    if cpath:
        paths[cpath] = {"orders": []}
    def mut(d):
        o = next((x for x in d[opath].get("orders", []) if str(x.get("id")) == str(oid)), None)
        if not o:
            return d
        o["status"] = status
        if cpath:
            cit = next((x for x in (d[cpath].get("orders") or []) if str(x.get("id")) == str(oid)), None)
            if cit:
                cit["status"] = status
        return d
    try:
        # синхронно меняем файл арендодателя и копию клиента под замками обоих путей
        await repo.update_jsons(session, paths, mut, f"bot: заказ #{oid} -> {status}")
    except RepoError:
        await send_text(session, from_id, "Сервис перегружен, повтори через минуту.")
        return
    note = "выполнен" if status == "done" else "отменён"
    await send_text(session, from_id, f"Заказ #{oid}: {note}.")
    try:
        await send_text(session, int(it.get("client_uid")),
            f"Заказ #{h(str(oid))} ({h(it.get('name',''))} {h(str(it.get('num','')))}) {note} арендодателем.")
    except Exception:
        pass


# ---------------------------------------------------------------- verification
async def handle_verify(session, chat_id, from_id, text: str):
    """Юзер присылает пейлоад витрины (base64url) или ссылку с startapp=.
    Бот: 1) декодирует, 2) проверяет uid, 3) сверяет подарки с getUserGifts,
    4) подписывает и возвращает ссылку с подписью."""
    # вытащить пейлоад
    payload = ""
    for token_ in text.split():
        if "startapp=" in token_:
            payload = token_.split("startapp=")[1].split(".")[0]
            break
    if not payload and text.strip().startswith("eyJ"):
        payload = text.strip().split(".")[0]
    if not payload:
        await send_text(session, chat_id,
            "Не понял. Отправь пейлоад витрины (строка на eyJ...) или всю ссылку t.me.")
        return

    try:
        obj = json.loads(b64url_decode(payload))
    except Exception:
        await send_text(session, chat_id, "Пейлоад битый, не декодируется.")
        return

    if str(obj.get("uid")) != str(from_id):
        await send_text(session, chat_id,
            "Отказано: uid в витрине не совпадает с твоим аккаунтом.")
        return

    # сверка подарков с реальным профилем
    real = await fetch_user_gifts(session, from_id)
    real_gids = {g["gid"] for g in real}
    claimed = obj.get("gifts") or []
    fake = [g.get("g") or g.get("n") for g in claimed
            if (g.get("g") or g.get("n")) not in real_gids]
    if fake:
        await send_text(session, chat_id,
            "Отказано: этих подарков нет в твоём профиле: " + ", ".join(map(str, fake)))
        return

    if not priv_key:
        await send_text(session, chat_id,
            "SIGNING_KEY не настроен в Secrets, подписать не могу. Сообщи админу.")
        return

    sig = signing.sign_payload(priv_key, payload)
    link = f"https://t.me/{BOT_USERNAME}/{os.environ.get('APP_SHORT_NAME','gifts')}?startapp={payload}.{sig}"
    markup = {"inline_keyboard": [[
        {"text": "📎 Скопировать ссылку", "copy_text": {"text": link}},
    ]]}
    await send_text(session, chat_id,
        "✅ Проверил твой профиль: все подарки настоящие. Вот подписанная витрина:\n\n"
        f"<code>{link}</code>\n\n"
        "Открой её сам для превью и отправляй клиентам. "
        "Подпись слетит, если ты что-то поменяешь в витрине: тогда снова пришли пейлоад.",
        reply_markup=markup)


# ---------------------------------------------------------------- commands
async def handle_agree(session, cb):
    """Старые сообщения с кнопкой «Принимаю условия»: молча гасим, без ответов. Условия принимаются один раз в мини-аппе."""
    try:
        await tg_call(session, "answerCallbackQuery", {"callback_query_id": cb["id"]})
        mk = (cb.get("message") or {})
        if mk.get("chat") and mk.get("message_id"):
            await tg_call(session, "deleteMessage", {"chat_id": mk["chat"]["id"], "message_id": mk["message_id"]})
    except Exception:
        log.exception("agree упал")


async def handle_start(session, chat_id, from_user, args=""):
    if args.startswith("rp_"):
        # жалоба: rp_<uid>_<hash>
        parts = args[3:].split("_", 1)
        accused = parts[0]
        hash_part = parts[1] if len(parts) > 1 else ""
        complaint_text = f"жалоба на {accused}" + (f": {hash_part}" if hash_part else "")
        try:
            def mut(d):
                c = d["data/complaints.json"]
                c["list"] = (c.get("list") or [])[-200:] + [{
                    "uid": from_user["id"], "username": from_user.get("username", ""),
                    "first": from_user.get("first_name", ""), "text": complaint_text,
                    "ts": int(time.time())}]
                d["data/complaints.json"] = c
                return d
            await repo.update_jsons(session, {"data/complaints.json": {"list": []}},
                                    mut, f"bot: жалоба {from_user['id']}")
        except RepoError:
            await send_text(session, chat_id, "Сервис перегружен, повтори через минуту.")
            return
        await send_text(session, chat_id, "Жалоба записана, админ увидит её командой /complaints.")
        return

    # ответ СРАЗУ, без зависимости от GitHub. Один вход: нижние кнопки (только они дают sendData)
    base_url = f"https://{REPO_NAME.split('/')[0]}.github.io/{REPO_NAME.split('/')[-1]}/" if REPO_NAME else ""
    app_url = f"{base_url}?u={from_user['id']}&cb={int(time.time() // 3600)}" if base_url else ""
    kb = {"keyboard": [[{"text": "Открыть", "web_app": {"url": app_url + "&m=mkt"}},
                        {"text": "Сдать подарок", "web_app": {"url": app_url + "&m=pub"}}]],
          "resize_keyboard": True, "is_persistent": True} if app_url else None
    _KB_SENT.add(from_user["id"])
    if args.startswith("o_"):
        # заказ диплинком из мини-аппа, открытого не с reply-кнопки (sendData там не доставляется)
        asyncio.create_task(handle_deeplink_order(session, from_user, args[2:]))
    if args == "pub":
        txt = "Нажми «Сдать подарок» внизу: публикация завершится автоматически."
    elif args == "scan":
        txt = "Профиль подключён ✅ Нажми «Открыть» внизу: твои подарки будут во вкладке «Профиль»."
    elif args == "ord":
        txt = "Нажми «Открыть» внизу: твой заказ дойдёт автоматически."
    else:
        txt = ("🎁 <b>Gift Rent</b>: аренда подарков Telegram.\n"
               "Кнопки внизу: <b>Открыть</b> (арендовать) и <b>Сдать подарок</b> (разместить свой).\n"
               "Условия и FAQ с фото-инструкциями: в приложении, вкладка «Профиль». Оплата P2P напрямую между пользователями.")
        if base_url:
            try:
                r_photo = await tg_call(session, "sendPhoto", {
                    "chat_id": chat_id, "photo": base_url + "assets/banner.jpg",
                    "caption": txt, "parse_mode": "HTML", "reply_markup": kb})
                if r_photo.get("ok"):
                    asyncio.create_task(ensure_registered(session, from_user))
                    return   # ушло фото с приветствием и кнопками
                # фото не ушло (Pages не обновился/файл большой) -> текстом ниже, не молчим
            except Exception:
                pass  # фото не ушло — отправим текстом ниже
    await send_text(session, chat_id, txt, kb)
    asyncio.create_task(ensure_registered(session, from_user))


def _cache_user(from_user):
    if from_user and "id" in from_user and not any(u["id"] == from_user["id"] for u in _USERS_CACHE["users"]):
        _USERS_CACHE["users"].append({"id": from_user["id"], "username": from_user.get("username", ""),
                                      "first": from_user.get("first_name", ""), "ts": int(time.time())})


async def ensure_registered(session, from_user):
    """Любое сообщение от юзера -> он в users.json. Кэш помнит зарегистрированных:
    без чтения API на каждое сообщение. Локально в кэш кладём ТОЛЬКО после успешного коммита."""
    if not from_user or "id" not in from_user or not repo.enabled:
        return
    if any(u["id"] == from_user["id"] for u in _USERS_CACHE["users"]):
        return
    fu = from_user
    def mut(d):
        if any(u["id"] == fu["id"] for u in d["data/users.json"]["users"]):
            return d
        d["data/users.json"]["users"].append({
            "id": fu["id"], "username": fu.get("username", ""),
            "first": fu.get("first_name", ""), "ts": int(time.time())})
        return d
    try:
        _, ok = await repo.update_jsons(session, {"data/users.json": {"users": []}},
                                        mut, f"bot: регистрация {fu['id']}")
        if ok:
            _cache_user(fu)
    except RepoError as e:
        log.warning("регистрация %s отложена (сбой чтения, данные не тронуты): %s", fu["id"], e)
    except Exception:
        log.exception("регистрация упала")


async def handle_block(session, chat_id, from_id, arg):
    if str(from_id) not in ADMIN_IDS:
        await send_text(session, chat_id, "Только админ.")
        return
    if not arg:
        await send_text(session, chat_id, "Формат: /block <uid или hash>")
        return
    arg_ = arg
    def mut(d):
        dl = d["denylist.json"]
        dl.setdefault("uids", []); dl.setdefault("hashes", [])
        if arg_.isdigit():
            dl["uids"].append(int(arg_))
        else:
            dl["hashes"].append(arg_)
        dl["uids"] = sorted(set(dl["uids"])); dl["hashes"] = sorted(set(dl["hashes"]))
        d["denylist.json"] = dl
        return d
    try:
        _, ok = await repo.update_jsons(session, {"denylist.json": {"uids": [], "hashes": []}},
                                        mut, f"bot: block {arg}")
    except RepoError:
        await send_text(session, chat_id, "Сервис перегружен, повтори через минуту.")
        return
    _DENY["ts"] = 0.0   # немедленный перечит после /block
    await send_text(session, chat_id, f"Заблокирован: {arg}")


async def handle_complaints(session, chat_id, from_id):
    if str(from_id) not in ADMIN_IDS:
        await send_text(session, chat_id, "Только админ.")
        return
    c = await repo.get_json(session, "data/complaints.json", {"list": []}) or {"list": []}
    lines = [f"Жалоб: {len(c.get('list', []))}"]
    for it in c.get("list", [])[-10:]:
        lines.append(f"• на {it.get('accused')} от {it.get('from')} hash={it.get('hash','')[:16]} "
                     f"({time.strftime('%d.%m %H:%M', time.gmtime(it.get('ts', 0)))})")
    await send_text(session, chat_id, "\n".join(lines) +
                    "\n\nБлок: /block <uid> или /block <hash из жалобы>")


# ---------------------------------------------------------------- dispatch
async def process_update(session, upd):
    cb = upd.get("callback_query")
    if cb:
        await handle_agree(session, cb)
        return
    msg = upd.get("message") or upd.get("channel_post")
    if not msg:
        return
    chat_id = msg["chat"]["id"]
    wad = msg.get("web_app_data")
    if wad:  # данные из мини-аппа через sendData: без копирования и вставки
        uid = (msg.get("from") or {}).get("id")
        if uid:
            LAST_SEEN[uid] = time.time()
            asyncio.create_task(ensure_registered(session, msg.get("from") or {}))
            asyncio.create_task(maybe_touch_user(session, uid))
        try:
            obj = json.loads(wad.get("data") or "{}")
        except Exception:
            await send_text(session, chat_id, "Данные из мини-аппа битые."); return
        if obj.get("l") == 1:
            await handle_publish(session, chat_id, uid, obj)
        elif obj.get("o") == 1:
            await handle_order(session, msg.get("from") or {}, obj)
        return
    text = (msg.get("text") or "").strip()
    from_user = msg.get("from") or {}
    uid = from_user.get("id")

    if not text:
        return
    if uid:
        LAST_SEEN[uid] = time.time()
        asyncio.create_task(ensure_registered(session, from_user))
        asyncio.create_task(maybe_touch_user(session, uid, force=text.startswith("/start")))
        if not text.startswith("/start"):
            asyncio.create_task(ensure_keyboard(session, chat_id, from_user))
    if text.startswith("/start"):
        args = text.split(maxsplit=1)[1] if len(text.split()) > 1 else ""
        await handle_start(session, chat_id, from_user, args.strip())
    elif text.startswith("/myid"):
        await send_text(session, chat_id, f"Твой ID: <code>{uid}</code>")
    elif text.startswith("/verify"):
        rest = text[len("/verify"):].strip()
        await handle_verify(session, chat_id, uid, rest or text)
    elif text.startswith("eyJ"):
        try:
            obj = json.loads(b64url_decode(text.strip().split(".")[0]))
        except Exception:
            await send_text(session, chat_id, "Пейлоад битый, не декодируется.")
            return
        if obj.get("o") == 1:
            await handle_order(session, from_user, obj)
        elif obj.get("l") == 1:
            await handle_publish(session, chat_id, uid, obj)
        else:
            await handle_verify(session, chat_id, uid, text)
    elif text.startswith("/block"):
        await handle_block(session, chat_id, uid, text.split(maxsplit=1)[1] if len(text.split()) > 1 else "")
    elif text.startswith("/complaints"):
        await handle_complaints(session, chat_id, uid)
    elif text.startswith("/orders"):
        await handle_orders_list(session, uid)
    elif text.startswith("/done"):
        await handle_order_status(session, uid, text.split()[-1] if len(text.split()) > 1 else "", "done")
    elif text.startswith("/cancel"):
        await handle_order_status(session, uid, text.split()[-1] if len(text.split()) > 1 else "", "cancelled")


POLL = {"ts": 0.0}  # время последнего успешного getUpdates; watchdog по нему решает, оглох ли бот


async def safe_process(session, upd):
    try:
        await process_update(session, upd)
    except RepoError:
        log.warning("update: GitHub API сбой")
        try:
            msg = upd.get("message") or {}
            if msg.get("chat"):
                await send_text(session, msg["chat"]["id"], "Сервис перегружен, повтори через минуту.")
        except Exception:
            pass
    except Exception:
        log.exception("update упал")
        try:
            msg = upd.get("message") or {}
            if msg.get("chat"):
                await send_text(session, msg["chat"]["id"], "Ошибка обработки, попробуй ещё раз через минуту.")
        except Exception:
            pass


async def main():
    global BOT_USERNAME
    async with aiohttp.ClientSession() as session:
        me = await tg_call(session, "getMe")
        if not me.get("ok"):
            log.critical("getMe упал: %s", me)
            return
        BOT_USERNAME = me["result"]["username"]
        log.info("бот @%s стартует", BOT_USERNAME)

        # очистить хук, если был
        await tg_call(session, "deleteWebhook", {"drop_pending_updates": False})

        # кнопка мини-аппа в меню чата + команды
        app_url = f"https://{REPO_NAME.split('/')[0]}.github.io/{REPO_NAME.split('/')[-1]}/" if REPO_NAME else ""
        if app_url:
            # кнопка мини-аппа слева от поля ввода: основной быстрый вход в Маркет
            await tg_call(session, "setChatMenuButton", {"menu_button": {
                "type": "web_app", "text": "Открыть", "web_app": {"url": app_url + "?src=menu&m=mkt"}}})
        await tg_call(session, "setMyCommands", {"commands": [
            {"command": "start", "description": "Открыть маркетплейс"},
            {"command": "orders", "description": "Мои входящие заказы"},
            {"command": "myid", "description": "Мой Telegram ID"}]})
        log.info("меню и команды настроены, url=%s", app_url)

        # разогрев LISTINGS: все листинги одним параллельным заходом (8 одновременных),
        # первая публикация не ждёт последовательного чтения файлов всех юзеров
        if repo.enabled:
            try:
                sem8 = asyncio.Semaphore(8)
                async def warm(uid):
                    async with sem8:
                        LISTINGS[uid] = await repo.get_json(session, f"data/listings/{uid}.json") or {}
                uids = [str(u["id"]) for u in await get_users_cached(session)]
                res = await asyncio.gather(*[warm(u) for u in uids], return_exceptions=True)
                errs = sum(1 for r in res if isinstance(r, Exception))
                log.info("LISTINGS разогрет: %d файлов, %d ошибок", len(uids) - errs, errs)
            except Exception:
                log.exception("разогрев листингов упал (не критично)")

        async def poll():
            offset = None
            fail = 0
            while True:
                params = {"timeout": 25}
                if offset:
                    params["offset"] = offset
                try:
                    async with session.get(f"{API}/getUpdates", params=params,
                                           timeout=aiohttp.ClientTimeout(total=35)) as r:
                        data = await r.json()
                    POLL["ts"] = time.time()  # живой proof: Telegram ответил
                    fail = 0
                    tasks = []
                    for upd in data.get("result", []):
                        offset = upd["update_id"] + 1
                        tasks.append(asyncio.create_task(safe_process(session, upd)))
                    if tasks:
                        # только после обработки всей пачки подтверждаем offset:
                        # краш -> Telegram передаёт апдейты заново, заказ не теряется
                        await asyncio.gather(*tasks)
                except asyncio.TimeoutError:
                    fail += 1
                    if fail >= 3:
                        log.error("getUpdates таймаут %d подряд", fail)
                    POLL["ts"] = time.time()  # сессия жива, пробуем дальше
                except Exception:
                    log.exception("poll упал, пауза 5с")
                    await asyncio.sleep(5)
                except BaseException:
                    # CancelledError и прочие прерывания: цикл не имеет права умирать тихо
                    log.exception("poll прерван, цикл жив, пауза 2с")
                    await asyncio.sleep(2)

        async def refresher():
            await asyncio.sleep(10)  # прогрев после старта
            last_hb, last_hot, last_all, last_meta = 0.0, 0.0, 0.0, 0.0
            meta_snap = None  # снимок giftmeta: коммитим только при изменении
            try:
                meta_snap = await repo.get_json(session, "data/giftmeta.json", None)
            except Exception:
                pass
            while True:
                try:
                    # watchdog: getUpdates молчит > 5 минут -> бот «живой, но глухой».
                    # Убиваем процесс: run упадёт, cron-keep-alive поднимет свежий бот за <=5 минут.
                    if POLL["ts"] and time.time() - POLL["ts"] > 300:
                        log.critical("poll мёртв %.0fс, самоубийство для перезапуска", time.time() - POLL["ts"])
                        os._exit(7)
                    # heartbeat раз в 15 мин (6 запросов GitHub API на коммит; было 60с = 360 req/h)
                    if time.time() - last_hb > 900 and repo.enabled:
                        last_hb = time.time()
                        asyncio.create_task(repo.commit_files(session, {
                            "data/heartbeat.json": json.dumps({"ts": int(last_hb), "poll_ts": int(POLL["ts"] or 0)}).encode()}, "bot: heartbeat"))
                    # экономия Bot API: горячие (писали за 15 мин) каждые 30с, все остальные каждые 10 мин
                    if time.time() - last_hot > 30:
                        last_hot = time.time()
                        await refresh_all_users(session, hot_only=True)
                    if time.time() - last_all > 600:
                        last_all = time.time()
                        await refresh_all_users(session, hot_only=False)
                    # рыночные цены аукционов (api.changes.tg): раз в 6ч, коммит только при изменении
                    if time.time() - last_meta > 6 * 3600 and repo.enabled:
                        last_meta = time.time()
                        meta = await fetch_giftmeta(session)
                        if meta and json.dumps(meta, sort_keys=True) != (json.dumps(meta_snap, sort_keys=True) if meta_snap else None):
                            meta_snap = meta
                            asyncio.create_task(repo.commit_files(session, {
                                "data/giftmeta.json": json.dumps(meta, ensure_ascii=False, indent=1).encode()},
                                "bot: giftmeta (аукционы @GiftChanges)"))
                except Exception:
                    log.exception("refresh упал")
                await asyncio.sleep(2)

        POLL["ts"] = time.time()  # прогрев: 5 минут форы до первого watchdog-провера
        await asyncio.gather(poll(), refresher())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
