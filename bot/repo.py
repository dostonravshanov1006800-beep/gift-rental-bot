"""Тонкая обёртка GitHub API: чтение JSON-файлов и батч-коммиты через git data API."""
import asyncio
import base64
import logging

import aiohttp

log = logging.getLogger("repo")


class Repo:
    def __init__(self, token: str | None, repo: str | None):
        self.token = token
        self.repo = repo
        self.api = "https://api.github.com"
        self._sem = asyncio.Semaphore(4)

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.repo)

    def _headers(self):
        return {
            "Authorization": f"token {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def _get(self, session, url, params=None):
        async with self._sem:
            async with session.get(url, headers=self._headers(), params=params) as r:
                if r.status == 200:
                    return await r.json()
                return None

    async def get_json(self, session, path, default=None):
        d = await self._get(session, f"{self.api}/repos/{self.repo}/contents/{path}?ref=main")
        if not d or "content" not in d:
            return default
        import json
        raw = base64.b64decode(d["content"]).decode("utf-8")
        try:
            return json.loads(raw)
        except Exception:
            return default

    async def get_raw(self, session, path):
        async with self._sem:
            async with session.get(
                f"https://raw.githubusercontent.com/{self.repo}/main/{path}",
                headers=self._headers(),
            ) as r:
                if r.status == 200:
                    return await r.read()
        return None

    # --- единая очередь: все записи за ~1.5с склеиваются в один коммит ---
    async def commit_files(self, session, files: dict, message: str) -> bool:
        """Ставит файлы в очередь; возвращает True, когда они реально закоммичены."""
        if not self.enabled or not files:
            return False
        if not hasattr(self, "_pending"):
            self._pending, self._waiters, self._msgs, self._flusher = {}, [], [], None
        self._pending.update(files)
        self._msgs.append(message)
        fut = asyncio.get_event_loop().create_future()
        self._waiters.append(fut)
        if self._flusher is None or self._flusher.done():
            self._flusher = asyncio.create_task(self._flush(session))
        return await fut

    async def _flush(self, session):
        await asyncio.sleep(1.2)  # окно коалесценции
        files, waiters, msgs = self._pending, self._waiters, self._msgs
        self._pending, self._waiters, self._msgs = {}, [], []
        ok = False
        for attempt in range(5):
            ok = await self._commit_once(session, files, "; ".join(dict.fromkeys(msgs))[:200])
            if ok:
                break
            await asyncio.sleep(0.4 * (attempt + 1))
        for w in waiters:
            if not w.done():
                w.set_result(ok)
        if self._pending:  # пока коммитили, пришли новые
            self._flusher = asyncio.create_task(self._flush(session))

    async def _commit_once(self, session, files: dict, message: str) -> bool:
        try:
            head = await self._get(session, f"{self.api}/repos/{self.repo}/git/ref/heads/main")
            if not head:
                log.error("нет ветки main"); return False
            head_sha = head["object"]["sha"]
            cm = await self._get(session, f"{self.api}/repos/{self.repo}/git/commits/{head_sha}")
            base_tree = cm["tree"]["sha"] if cm else head_sha

            async def mk(path, content):
                async with self._sem:
                    async with session.post(f"{self.api}/repos/{self.repo}/git/blobs", headers=self._headers(),
                            json={"content": base64.b64encode(content).decode(), "encoding": "base64"}) as r:
                        if r.status != 201:
                            log.error("blob %s: %s", path, await r.text()); return None
                        return {"path": path, "mode": "100644", "type": "blob", "sha": (await r.json())["sha"]}
            items = await asyncio.gather(*[mk(p, c) for p, c in files.items()])
            if any(x is None for x in items):
                return False
            async with self._sem:
                async with session.post(f"{self.api}/repos/{self.repo}/git/trees", headers=self._headers(),
                        json={"base_tree": base_tree, "tree": items}) as r:
                    if r.status != 201:
                        log.error("tree: %s", await r.text()); return False
                    tree = await r.json()
            async with self._sem:
                async with session.post(f"{self.api}/repos/{self.repo}/git/commits", headers=self._headers(),
                        json={"message": message, "tree": tree["sha"], "parents": [head_sha]}) as r:
                    if r.status != 201:
                        log.error("commit: %s", await r.text()); return False
                    commit = await r.json()
            async with self._sem:
                async with session.patch(f"{self.api}/repos/{self.repo}/git/refs/heads/main", headers=self._headers(),
                        json={"sha": commit["sha"], "force": False}) as r:
                    if r.status != 200:
                        log.warning("ref update (ретрай): %s", (await r.text())[:120]); return False
            log.info("коммит: %s (%d файлов)", message, len(files))
            return True
        except Exception:
            log.exception("commit_files упал"); return False
