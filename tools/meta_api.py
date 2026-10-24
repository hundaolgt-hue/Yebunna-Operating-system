#!/usr/bin/env python3
"""Meta Graph / Marketing API from the terminal, for the bots.

The token comes from META_ACCESS_TOKEN (never printed), the version from META_API_VERSION,
the ad account from META_AD_ACCOUNT_ID. Pagination is followed. Meta's errors are shown in
full. If Meta says the version is deprecated, the version it names is used.

  python .tools/meta_api.py get  act_123/campaigns fields=id,name,status,daily_budget
  python .tools/meta_api.py get  act_123/insights  fields=spend,impressions,clicks,actions date_preset=last_7d level=ad
  python .tools/meta_api.py post act_123/campaigns name="SiteCalc Pro" objective=OUTCOME_SALES status=PAUSED special_ad_categories=[]
  python .tools/meta_api.py post 120200000000001 status=PAUSED            # update any object by id
  python .tools/meta_api.py post act_123/adimages --file ad.png            # upload an image
  python .tools/meta_api.py post act_123/advideos --file ad.mp4            # upload a video
  python .tools/meta_api.py delete 120200000000001
  python .tools/meta_api.py get  account/campaigns fields=id,name          # "account" = META_AD_ACCOUNT_ID
  python .tools/meta_api.py me                                            # who the token is

Values that start with { or [ are sent as JSON (e.g. targeting={...}). Output is JSON.
"""
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get("META_ACCESS_TOKEN", "")
VERSION = os.environ.get("META_API_VERSION", "v26.0")
ACCOUNT = os.environ.get("META_AD_ACCOUNT_ID", "")


def die(msg, code=1):
    print(json.dumps({"error": msg}, ensure_ascii=False, indent=1))
    sys.exit(code)


def parse_args(args):
    params, file = {}, None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--file":
            file = args[i + 1]
            i += 2
            continue
        if "=" not in a:
            die(f"expected key=value, got {a!r}")
        k, v = a.split("=", 1)
        if v[:1] in "{[":
            try:
                v = json.dumps(json.loads(v))
            except json.JSONDecodeError as e:
                die(f"{k}: not valid JSON ({e})")
        params[k] = v
        i += 1
    return params, file


def request(method, path, params, file=None, version=None):
    version = version or VERSION
    path = path.lstrip("/")
    if path.split("/")[0] == "account":  # "account/campaigns" = the connected ad account
        path = ACCOUNT + path[len("account"):]
    url = f"https://graph.facebook.com/{version}/{path}"
    headers = {"Authorization": f"Bearer {TOKEN}"}
    data = None
    if method == "GET":
        q = urllib.parse.urlencode({**params, "limit": params.get("limit", "100")})
        url += ("&" if "?" in url else "?") + q
    elif file:
        boundary = "----yebunna" + os.urandom(8).hex()
        body = b""
        for k, v in params.items():
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        name = os.path.basename(file)
        field = "source" if path.endswith("advideos") else "filename"
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with open(file, "rb") as fh:
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n".encode() + fh.read() + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        data = body
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    else:
        data = urllib.parse.urlencode(params).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode()).get("error", {})
        except Exception:
            err = {"message": str(e)}
        msg = err.get("message", "")
        newer = None
        if "latest version" in msg.lower():
            import re
            m = re.search(r"latest version:?\s*(v\d+\.\d+)", msg, re.I)
            newer = m and m.group(1)
        if newer and newer != version:
            return request(method, path, params, file, newer)
        hint = ""
        if err.get("code") == 200:
            hint = " The token has no ads permission for this account: in Yebunna OS → Connections → Meta, click Save & test for the exact cause (usually a token generated before the ad account was assigned to the system user)."
        elif err.get("code") == 190:
            hint = " The token has expired or was revoked: generate a new one in Business Settings → System users."
        die(f"Meta error #{err.get('code')} ({err.get('type')}): {msg}{(' — ' + err['error_user_msg']) if err.get('error_user_msg') else ''}{hint}", 2)
    except urllib.error.URLError as e:
        die(f"network error: {e.reason}", 3)


def main():
    if not TOKEN:
        die("META_ACCESS_TOKEN is not set: this run has no Meta connection (Connections → Meta, and allow this bot).")
    if len(sys.argv) < 2:
        die(__doc__)
    cmd = sys.argv[1].lower()
    if cmd == "me":
        print(json.dumps(request("GET", "me", {"fields": "id,name"}), ensure_ascii=False, indent=1))
        return
    if cmd not in ("get", "post", "delete") or len(sys.argv) < 3:
        die(__doc__)
    path = sys.argv[2]
    params, file = parse_args(sys.argv[3:])
    if cmd == "get":
        out = request("GET", path, params)
        # Follow pagination up to 20 pages.
        pages = 0
        while isinstance(out, dict) and out.get("paging", {}).get("next") and pages < 20:
            pages += 1
            nxt = out["paging"]["next"]
            req = urllib.request.Request(nxt, headers={"Authorization": f"Bearer {TOKEN}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                more = json.loads(r.read().decode())
            out["data"] = out.get("data", []) + more.get("data", [])
            out["paging"] = more.get("paging", {})
        out.pop("paging", None)
    elif cmd == "post":
        out = request("POST", path, params, file)
    else:
        out = request("DELETE", path, params)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
