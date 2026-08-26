#!/usr/bin/env python3
"""Send the optional first prompt to a local OpenCode serve."""
import json, os, sys, urllib.error, urllib.request

p = os.environ.get("FIRST_PROMPT") or ""
if not p:
    sys.exit(0)


def req(method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        "http://127.0.0.1:4096" + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


s = req("POST", "/session", {"title": "zen-panel"})
sid = s.get("id") or s.get("sessionID")
if not sid:
    raise SystemExit("no session id: " + json.dumps(s)[:200])
body = {"parts": [{"type": "text", "text": p}]}
try:
    req("POST", f"/session/{sid}/prompt_async", body)
except Exception:
    req("POST", f"/session/{sid}/message", body)
print("first prompt sent to", sid)
