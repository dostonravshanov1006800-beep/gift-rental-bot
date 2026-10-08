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

REFRESH_INTERVAL = 600  # сек, цикл обновления подарков
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
            if g.get("type") == "unique" and not g.get("is_burned"):
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
    async with session.get(f"{API}/file/{path}") as r:
        if r.status == 200:
            return await r.read()
    return None


async def refresh_all_users(session):
    """Цикл: обновить подарки всех зарегистрированных юзеров, закоммитить diff."""
    if not repo.enabled:
        log.info("GITHUB_TOKEN нет, пропускаю коммиты")
        return
    users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
    changed: dict[str, bytes] = {}
    for u in users.get("users", []):
        uid = u["id"]
        try:
            gifts = await fetch_user_gifts(session, uid)
        except Exception:
            log.exception("getUserGifts упал для %s", uid)
            continue

        # нормализация: стабильный JSON
        blob = json.dumps({"uid": uid, "updated": int(time.time()), "gifts": gifts},
                          ensure_ascii=False, sort_keys=True).encode()
        old = await repo.get_raw(session, f"data/gifts/{uid}.json")
        if old == blob:
            continue
        changed[f"data/gifts/{uid}.json"] = blob

        # стикеры, которых нет в assets
        for g in gifts:
            fuid, fid = g.get("th_fuid"), g.get("th_fid")
            if not fuid or not fid:
                continue
            path = f"assets/gifts/{fuid}.webp"
            if await repo.get_raw(session, path) is not None:
                continue
            img = await download_thumb(session, fid)
            if img:
                changed[path] = img
        await asyncio.sleep(0.3)

    if changed:
        await repo.commit_files(session, changed, "bot: обновление подарков "
                                    f"({len([k for k in changed if k.endswith('.json')])} профилей)")



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

    # регистрация
    users = await repo.get_json(session, "data/users.json", {"users": []}) or {"users": []}
    known = any(u["id"] == from_user["id"] for u in users.get("users", []))
    if not known:
        users.setdefault("users", []).append({
            "id": from_user["id"],
            "username": from_user.get("username", ""),
            "first": from_user.get("first_name", ""),
            "ts": int(time.time())})
        if repo.enabled:
            await repo.commit_files(session, {
                "data/users.json": json.dumps(users, ensure_ascii=False, indent=1).encode()},
                f"bot: регистрация {from_user['id']}")
    await send_text(session, chat_id,
        "Ты в системе. Твой ID: <code>" + str(from_user["id"]) + "</code>\n\n"
        "1. Открой мини-апп через кнопку меню или ссылку админа.\n"
        "2. Подарки подтянутся из твоего профиля автоматически "
        "(первые минуты после регистрации, потом обновляются каждые 10 минут).\n"
        "3. В мини-аппе выстави цены аренды и нажми «Верифицировать»: "
        "скопирую пейлоад в буфер, ты вставь его сюда, я проверю подарки по реальному "
        "профилю и верну подписанную витрину.\n\n"
        "Мой ID для админа смотри в /myid.")


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
    text = (msg.get("text") or "").strip()
    from_user = msg.get("from") or {}
    uid = from_user.get("id")

    if not text:
        return
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
        await tg_call(session, "deleteWebhook", {"drop_pending_updates": True})

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
                        try:
                            await process_update(session, upd)
                        except Exception:
                            log.exception("update упал")
                except asyncio.TimeoutError:
                    pass
                except Exception:
                    log.exception("poll упал, пауза 5с")
                    await asyncio.sleep(5)

        async def refresher():
            await asyncio.sleep(10)  # прогрев после старта
            while True:
                try:
                    await refresh_all_users(session)
                except Exception:
                    log.exception("refresh упал")
                await asyncio.sleep(REFRESH_INTERVAL)

        await asyncio.gather(poll(), refresher())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
