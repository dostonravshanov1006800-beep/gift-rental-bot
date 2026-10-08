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

    async def commit_files(self, session, files: dict[str, bytes], message: str) -> bool:
        """Один коммит с несколькими файлами: blobs -> tree -> commit -> ref update."""
        if not self.enabled or not files:
            return False

        try:
            # текущий HEAD
            head = await self._get(session, f"{self.api}/repos/{self.repo}/git/ref/heads/main")
            if not head:
                log.error("нет ветки main")
                return False
            head_sha = head["object"]["sha"]

            # blobs
            tree_items = []
            for path, content in files.items():
                async with self._sem:
                    async with session.post(
                        f"{self.api}/repos/{self.repo}/git/blobs",
                        headers=self._headers(),
                        json={"content": base64.b64encode(content).decode(), "encoding": "base64"},
                    ) as r:
                        if r.status != 201:
                            log.error("blob %s: %s", path, await r.text())
                            return False
                        blob = await r.json()
                tree_items.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

            # tree на базе текущего
            async with self._sem:
                async with session.post(
                    f"{self.api}/repos/{self.repo}/git/trees",
                    headers=self._headers(),
                    json={"base_tree": head_sha, "tree": tree_items},
                ) as r:
                    if r.status != 201:
                        log.error("tree: %s", await r.text())
                        return False
                    tree = await r.json()

            # commit
            async with self._sem:
                async with session.post(
                    f"{self.api}/repos/{self.repo}/git/commits",
                    headers=self._headers(),
                    json={"message": message, "tree": tree["sha"], "parents": [head_sha]},
                ) as r:
                    if r.status != 201:
                        log.error("commit: %s", await r.text())
                        return False
                    commit = await r.json()

            # ref
            async with self._sem:
                async with session.patch(
                    f"{self.api}/repos/{self.repo}/git/refs/heads/main",
                    headers=self._headers(),
                    json={"sha": commit["sha"], "force": False},
                ) as r:
                    if r.status != 200:
                        text = await r.text()
                        log.warning("ref update: %s", text)
                        return False
            log.info("коммит: %s (%d файлов)", message, len(files))
            return True
        except Exception:
            log.exception("commit_files упал")
            return False
