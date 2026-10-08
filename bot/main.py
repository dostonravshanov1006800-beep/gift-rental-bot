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
import hashlib
import json
import logging
import os
import time

import aiohttp

import signing
from repo import Repo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bot")

BOT_TOKEN = os.environ["BOT_TOKEN"]
REPO_NAME = os.environ.get("REPO", "")
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
SIGNING_KEY_PEM = os.environ.get("SIGNING_KEY", "")
ADMIN_IDS = {x for x in os.environ.get("ADMIN_IDS", "").replace(" ", "").split(",") if x}

REFRESH_INTERVAL = 45  # сек, цикл обновления подарков
API = f"https://api.telegram.org/bot{BOT_TOKEN}"

repo = Repo(GH_TOKEN or None, REPO_NAME or None)
priv_key = signing.load_private(SIGNING_KEY_PEM) if SIGNING_KEY_PEM else None
BOT_USERNAME = None


# ---------------------------------------------------------------- helpers
def b64url_decode(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    while len(s) % 4:
        s += "="
    return base64.b64decode(s)


async def tg_call(session, method, payload=None):
    async with session.post(f"{API}/{method}", json=payload or {}) as r:
        data = await r.json()
        if not data.get("ok"):
            log.warning("%s -> %s", method, data)
        return data


async def send_text(session, chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return await tg_call(session, "sendMessage", payload)


# ---------------------------------------------------------------- gifts
async def fetch_user_gifts(session, user_id) -> list[dict]:
    """getUserGifts с пагинацией, только unique (NFT)."""
    gifts, offset = [], ""
    for _ in range(20):
        data = await tg_call(session, "getUserGifts",
                             {"user_id": int(user_id), "offset": offset, "limit": 100})
        if not data.get("ok"):
            return gifts
        res = data["result"]
        for g in res.get("gifts", []):
            if g.get("is_burned"):
                continue
            if g.get("type") != "unique":
                # обычный / коллекционный: имя = эмодзи, без модели и фона
                u = g.get("gift", {})
                st = u.get("sticker", {}) or {}
                thumb = st.get("thumbnail", {}) or {}
                gifts.append({
                    "gid": u.get("id") or "",
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
                gifts.append({
                    "gid": u.get("name") or f"{u.get('gift_id')}#{u.get('number')}",
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


async def build_user_files(session, uid) -> dict:
    """Скачивает подарки и недостающие стикеры, возвращает только изменившиеся файлы."""
    gifts = await fetch_user_gifts(session, uid)
    body = json.dumps({"uid": uid, "gifts": gifts}, ensure_ascii=False, sort_keys=True)
    h = hashlib.md5(body.encode()).hexdigest()
    files: dict = {}
    if _gift_hash.get(uid) != h:
        _gift_hash[uid] = h
        files[f"data/gifts/{uid}.json"] = json.dumps(
            {"uid": uid, "updated": int(time.time()), "gifts": gifts},
            ensure_ascii=False, sort_keys=True).encode()
    async def one(g):
        fuid, fid = g.get("th_fuid"), g.get("th_fid")
        if not fuid or not fid or fuid in KNOWN_THUMBS:
            return
        KNOWN_THUMBS.add(fuid)
        img = await download_thumb(session, fid)
        if img:
            files[f"assets/gifts/{fuid}.webp"] = img
    await asyncio.gather(*[one(g) for g in gifts])
    return files


KNOWN_THUMBS: set = set()
_last_touch: dict[int, float] = {}
LAST_SEEN: dict[int, float] = {}


async def refresh_user(session, uid) -> bool:
    if not repo.enabled:
        return False
    files = await build_user_files(session, uid)
    if not files:
        return False
    return await repo.commit_files(session, files, f"bot: подарки {uid}")


async def maybe_touch_user(session, uid):
    """При любом сообщении от юзера обновить его подарки, но не чаще раза в минуту."""
    if not uid or not repo.enabled:
        return
    now = time.time()
    if now - _last_touch.get(uid, 0) < 8:
        return
    _last_touch[uid] = now
    try:
        await refresh_user(session, uid)
    except Exception:
        log.exception("touch %s упал", uid)


async def refresh_all_users(session, hot_only=False):
    """Подарки юзеров параллельно, один коммит при изменениях.
    Горячие (писали боту за 15 мин) сканируются каждый тик, холодные — каждый 4-й."""
    if not repo.enabled:
        return
    users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
    now = time.time()
    targets = []
    for u in users.get("users", []):
        hot = now - LAST_SEEN.get(u["id"], 0) < 900
        if hot or not hot_only:
            targets.append(u)
    if not targets:
        return
    async def one(u):
        try:
            return await build_user_files(session, u["id"])
        except Exception:
            log.exception("getUserGifts упал для %s", u.get("id")); return {}
    parts = await asyncio.gather(*[one(u) for u in targets])
    changed = {}
    for p in parts:
        changed.update(p)
    if changed:
        await repo.commit_files(session, changed, f"bot: подарки ({len(targets)} проф.)")


# ---------------------------------------------------------------- catalog
LISTINGS: dict = {}


async def rebuild_catalog(session):
    """Собирает data/catalog.json из data/listings/*.json (плоский список подарков в аренде)."""
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


async def handle_publish(session, chat_id, from_id, obj):
    """Лендлорд публикует листинг (тип l=1). Сверка с getUserGifts, запись, пересборка каталога."""
    if str(obj.get("uid")) != str(from_id):
        await send_text(session, chat_id, "Отказано: uid не совпадает с твоим аккаунтом.")
        return
    real = {g["gid"]: g for g in await fetch_user_gifts(session, from_id)}
    out, fake = [], []
    now = int(time.time())
    for g in obj.get("gifts", []):
        r = real.get(g.get("g"))
        if not r:
            fake.append(str(g.get("g")))
            continue
        out.append({
            "g": r["gid"], "n": r.get("name", ""), "m": r.get("model", ""), "s": r.get("symbol", ""),
            "num": r.get("num"), "cc": r.get("cc"), "ec": r.get("ec"),
            "mr": r.get("mr"), "sr": r.get("sr"), "br": r.get("br"), "b": r.get("backdrop", ""),
            "t": f"assets/gifts/{r['th_fuid']}.webp" if r.get("th_fuid") else "",
            "p": str(g.get("p") or "")[:20], "cur": str(g.get("cur") or "UZS")[:5],
            "per": str(g.get("per") or "месяц")[:10], "ts": now,
        })
    if fake:
        await send_text(session, chat_id, "Этих подарков нет в профиле, пропущены: " + ", ".join(fake))
    listing = {
        "uid": str(from_id), "name": str(obj.get("name") or "")[:60],
        "uname": str(obj.get("uname") or "")[:32],
        "about": str(obj.get("about") or "")[:300],
        "req": [{"l": str(r.get("l") or r.get("label") or "")[:30],
                 "v": str(r.get("v") or r.get("value") or "")[:120]}
                for r in (obj.get("req") or [])[:6]],
        "gifts": out, "updated": now,
    }
    if not repo.enabled:
        await send_text(session, chat_id, "Репозиторий не подключён.")
        return
    LISTINGS[str(from_id)] = listing
    cat = await rebuild_catalog(session)
    ok = await repo.commit_files(session, {
        f"data/listings/{from_id}.json": json.dumps(listing, ensure_ascii=False).encode(),
        "data/catalog.json": cat}, f"bot: листинг {from_id} ({len(out)})")
    await send_text(session, chat_id,
        f"✅ Опубликовано: {len(out)}. Уже в каталоге." if ok else "⚠️ Не удалось сохранить, повтори через минуту.")

# ---------------------------------------------------------------- orders
async def handle_order(session, from_user, obj):
    """Клиент вставил пейлоад заказа: {o:1, lu, g, p, cur, per, c}."""
    lu = str(obj.get("lu") or "")
    gid = str(obj.get("g") or "")
    if not lu or not gid:
        await send_text(session, from_user["id"], "Заказ неполный: нет арендодателя или подарка.")
        return

    users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
    landlord = next((u for u in users.get("users", []) if str(u["id"]) == lu), None)
    if not landlord:
        await send_text(session, from_user["id"], "Арендодатель не найден в системе.")
        return

    raw = await repo.get_raw(session, f"data/gifts/{lu}.json")
    gifts = json.loads(raw).get("gifts", []) if raw else []
    gift = next((g for g in gifts if g.get("gid") == gid), None)
    if not gift:
        await send_text(session, from_user["id"],
            "Этого подарка нет в коллекции арендодателя. Витрина устарела.")
        return

    orders = await repo.get_json(session, f"data/orders/{lu}.json", {"orders": [], "seq": 0}) \
        or {"orders": [], "seq": 0}
    seq = int(orders.get("seq") or 0) + 1
    orders["seq"] = seq
    orders.setdefault("orders", []).append({
        "id": str(seq),
        "gid": gid, "name": gift.get("name", ""), "num": gift.get("num"),
        "price": str(obj.get("p") or ""), "cur": obj.get("cur") or "",
        "per": obj.get("per") or "",
        "comment": (obj.get("c") or "")[:150],
        "client_uid": from_user["id"],
        "client_username": from_user.get("username", ""),
        "client_first": from_user.get("first_name", ""),
        "ts": int(time.time()), "status": "new",
    })
    orders["orders"] = orders["orders"][-200:]
    if repo.enabled:
        await repo.commit_files(session, {
            f"data/orders/{lu}.json": json.dumps(orders, ensure_ascii=False, indent=1).encode()},
            f"bot: заказ #{seq} для {lu}")

    if repo.enabled:
        mine = await repo.get_json(session, f"data/my_orders/{from_user['id']}.json", {"orders": []}) \
            or {"orders": []}
        mine["orders"] = (mine.get("orders") or [])[-100:] + [{
            "id": str(seq), "lu": lu, "name": gift.get("name", ""), "num": gift.get("num"),
            "price": str(obj.get("p") or ""), "cur": obj.get("cur") or "", "per": obj.get("per") or "",
            "ts": int(time.time()), "status": "new",
            "owner_username": landlord.get("username", "")}]
        await repo.commit_files(session, {
            f"data/my_orders/{from_user['id']}.json": json.dumps(mine, ensure_ascii=False).encode()},
            f"bot: мой заказ {from_user['id']}")

    cust = ("@" + from_user["username"]) if from_user.get("username") \
        else f"tg://user?id={from_user['id']}"
    await send_text(session, int(lu),
        f"📦 <b>Новый заказ #{seq}</b>\n"
        f"🎁 {gift.get('name','')} #{gift.get('num','')}\n"
        f"💰 {obj.get('p') or 'по договорённости'} {obj.get('cur','')} / {obj.get('per','')}\n"
        f"👤 Клиент: {cust} (ID {from_user['id']})\n"
        + (f"💬 {obj.get('c','')[:150]}\n" if obj.get("c") else "")
        + f"\nЦену client указал сам: сверься с витриной. Ответь клиенту, договорись о залоге и сроках.\n"
          f"/done {seq} — выполнен · /cancel {seq} — отмена")

    who = ("@" + landlord["username"]) if landlord.get("username") else "арендодатель"
    await send_text(session, from_user["id"],
        f"✅ Заказ #{seq} отправлен {who}. Он свяжется с тобой в Telegram.")


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
        lines.append(f"{mark} #{it['id']} {it.get('name','')} #{it.get('num','')} "
                     f"— {it.get('price') or '—'} {it.get('cur','')} ({ts})")
    lines.append("\n/done <№> — выполнить, /cancel <№> — отменить")
    await send_text(session, from_id, "\n".join(lines))


async def handle_order_status(session, from_id, oid, status):
    path = f"data/orders/{from_id}.json"
    orders = await repo.get_json(session, path) or {"orders": []}
    items = orders.get("orders", [])
    it = next((o for o in items if str(o.get("id")) == str(oid)), None)
    if not it:
        await send_text(session, from_id, f"Заказ #{oid} не найден.")
        return
    it["status"] = status
    if repo.enabled:
        await repo.commit_files(session, {path: json.dumps(orders, ensure_ascii=False, indent=1).encode()},
                                f"bot: заказ #{oid} -> {status}")
    note = "выполнен" if status == "done" else "отменён"
    await send_text(session, from_id, f"Заказ #{oid}: {note}.")
    try:
        await send_text(session, int(it.get("client_uid")),
            f"Заказ #{oid} ({it.get('name','')} #{it.get('num','')}) {note} арендодателем.")
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
async def handle_start(session, chat_id, from_user, args=""):
    if args.startswith("rp_"):
        # жалоба: rp_<uid>_<hash>
        parts = args[3:].split("_", 1)
        accused = parts[0]
        hash_part = parts[1] if len(parts) > 1 else ""
        complaints = await repo.get_json(session, "data/complaints.json", {"list": []}) or {"list": []}
        complaints["list"] = (complaints.get("list") or [])[-200:] + [{
            "from": from_user["id"], "accused": accused, "hash": hash_part,
            "ts": int(time.time())}]
        if repo.enabled:
            await repo.commit_files(session, {
                "data/complaints.json": json.dumps(complaints, ensure_ascii=False, indent=1).encode()},
                f"bot: жалоба на {accused}")
        await send_text(session, chat_id, "Жалоба записана, админ увидит её командой /complaints.")
        return

    # ответ СРАЗУ, без зависимости от GitHub
    app_url = f"https://{REPO_NAME.split('/')[0]}.github.io/{REPO_NAME.split('/')[-1]}/" if REPO_NAME else ""
    markup = {"inline_keyboard": [[{"text": "Открыть маркетплейс", "web_app": {"url": app_url}}]]} if app_url else None
    if app_url:
        # reply-клавиатура: только из неё мини-апп может вызвать sendData (публикация без копирования)
        await tg_call(session, "sendMessage", {
            "chat_id": chat_id, "text": "Кнопка снизу: сдать подарок в аренду в один тап.",
            "reply_markup": {"keyboard": [[{"text": "Сдать подарок", "web_app": {"url": app_url + "?m=pub"}}]],
                             "resize_keyboard": True, "is_persistent": True}})
    await send_text(session, chat_id,
        "<b>Gift Rent</b>: маркетплейс аренды NFT-подарков.\n\n"
        "Арендуй подарки или сдавай свои. Всё внутри мини-аппа, заявки приходят сюда.\n"
        f"Твой ID: <code>{from_user['id']}</code>",
        markup)

    register = lambda: asyncio.create_task(ensure_registered(session, from_user))

    # регистрация + подарки + фото: один коммит, сразу
    async def _register():
        try:
            uid = from_user["id"]
            users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
            files = {}
            if not any(u["id"] == uid for u in users.get("users", [])):
                users.setdefault("users", []).append({
                    "id": uid, "username": from_user.get("username", ""),
                    "first": from_user.get("first_name", ""), "ts": int(time.time())})
                files["data/users.json"] = json.dumps(users, ensure_ascii=False, indent=1).encode()
            files.update(await build_user_files(session, uid))
            if files and repo.enabled:
                await repo.commit_files(session, files, f"bot: старт {uid}")
        except Exception:
            log.exception("регистрация упала")
    asyncio.create_task(_register())


async def ensure_registered(session, from_user):
    """Любое сообщение от юзера -> он в users.json (каталог его увидит)."""
    if not from_user or "id" not in from_user or not repo.enabled:
        return
    try:
        users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
        if any(u["id"] == from_user["id"] for u in users.get("users", [])):
            return
        users.setdefault("users", []).append({
            "id": from_user["id"], "username": from_user.get("username", ""),
            "first": from_user.get("first_name", ""), "ts": int(time.time())})
        await repo.commit_files(session, {
            "data/users.json": json.dumps(users, ensure_ascii=False, indent=1).encode()},
            f"bot: регистрация {from_user['id']}")
    except Exception:
        log.exception("регистрация упала")


async def handle_block(session, chat_id, from_id, arg):
    if str(from_id) not in ADMIN_IDS:
        await send_text(session, chat_id, "Только админ.")
        return
    if not arg:
        await send_text(session, chat_id, "Формат: /block <uid или hash>")
        return
    dl = await repo.get_json(session, "denylist.json", {"uids": [], "hashes": []}) or {"uids": [], "hashes": []}
    dl.setdefault("uids", []); dl.setdefault("hashes", [])
    if arg.isdigit():
        dl["uids"].append(int(arg))
    else:
        dl["hashes"].append(arg)
    dl["uids"] = sorted(set(dl["uids"])); dl["hashes"] = sorted(set(dl["hashes"]))
    if repo.enabled:
        await repo.commit_files(session, {
            "denylist.json": json.dumps(dl, indent=1).encode()}, f"bot: block {arg}")
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
    msg = upd.get("message") or upd.get("channel_post")
    if not msg:
        return
    chat_id = msg["chat"]["id"]
    wad = msg.get("web_app_data")
    if wad:  # данные из мини-аппа через sendData: без копирования и вставки
        uid = (msg.get("from") or {}).get("id")
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
        asyncio.create_task(maybe_touch_user(session, uid))
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


async def safe_process(session, upd):
    try:
        await process_update(session, upd)
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
            await tg_call(session, "setChatMenuButton", {"menu_button": {
                "type": "web_app", "text": "Аренда", "web_app": {"url": app_url}}})
        await tg_call(session, "setMyCommands", {"commands": [
            {"command": "start", "description": "Открыть маркетплейс"},
            {"command": "orders", "description": "Мои входящие заказы"},
            {"command": "myid", "description": "Мой Telegram ID"}]})
        log.info("меню и команды настроены, url=%s", app_url)

        async def poll():
            offset = None
            while True:
                params = {"timeout": 25}
                if offset:
                    params["offset"] = offset
                try:
                    async with session.get(f"{API}/getUpdates", params=params,
                                           timeout=aiohttp.ClientTimeout(total=35)) as r:
                        data = await r.json()
                    for upd in data.get("result", []):
                        offset = upd["update_id"] + 1
                        asyncio.create_task(safe_process(session, upd))
                except asyncio.TimeoutError:
                    pass
                except Exception:
                    log.exception("poll упал, пауза 5с")
                    await asyncio.sleep(5)

        async def refresher():
            await asyncio.sleep(10)  # прогрев после старта
            tick = 0
            while True:
                try:
                    # горячие (юзер в мини-аппе / писал недавно): каждые 12с
                    await refresh_all_users(session, hot_only=True)
                    # холодные: каждый 4-й тик (~48с)
                    if tick % 4 == 0:
                        await refresh_all_users(session, hot_only=False)
                except Exception:
                    log.exception("refresh упал")
                tick += 1
                await asyncio.sleep(12)

        await asyncio.gather(poll(), refresher())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
