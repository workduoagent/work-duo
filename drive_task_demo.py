import json, urllib.request, urllib.error, time, sys, os

BASE = "http://127.0.0.1:18755/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json"}
HERE = os.path.dirname(os.path.abspath(__file__))

def rpc(method, params=None, sid=None, notif=False):
    body = {"jsonrpc": "2.0", "method": method}
    if not notif:
        body["id"] = int(time.time() * 1000) % 1000000
    if params is not None:
        body["params"] = params
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE, data=data, headers=H, method="POST")
    if sid:
        req.add_header("Mcp-Session-Id", sid)
    try:
        resp = urllib.request.urlopen(req, timeout=300)
        raw = resp.read().decode(errors="replace")
        sid2 = resp.headers.get("Mcp-Session-Id")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        sid2 = sid
    fn = os.path.join(HERE, f"raw_{method.replace('/', '_')}.txt")
    with open(fn, "w", encoding="utf-8") as f:
        f.write(raw)
    text = raw.strip()
    parsed = None
    try:
        parsed = json.loads(text)
    except Exception as e:
        # try to find first JSON object/array
        for ch in ("{", "["):
            i = text.find(ch)
            if i >= 0:
                try:
                    parsed = json.loads(text[i:])
                    break
                except Exception:
                    continue
        if parsed is None:
            print(f"   [rpc {method}] PARSE-ERR {e}; raw(head)={raw[:200]!r} len={len(raw)}")
    return parsed, (sid2 or sid)

def call_tool(name, args, sid):
    res, sid2 = rpc("tools/call", {"name": name, "arguments": args}, sid)
    return res, sid2

def get_text(res):
    if res and res.get("result"):
        try:
            return json.loads(res["result"]["content"][0]["text"])
        except Exception:
            return None
    return None

def main():
    res, sid = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "demo", "version": "0"}})
    print("== initialize sid:", sid)
    rpc("notifications/initialized", {}, sid, notif=True)

    agent_id = "0abb2852-1509-4d08-a05a-7b4a4f315a35"
    prompt = "请基于你绑定的 WorkDuo 方案设计知识库，用不超过 3 句话概括 WorkDuo 的核心架构，并说明它和「小队（Squad）协作」的关系。"

    print("== agent_run_task ...")
    res, sid = call_tool("agent_run_task", {"agentId": agent_id, "prompt": prompt}, sid)
    rt = get_text(res)
    print("run_task text:", json.dumps(rt, ensure_ascii=False)[:600])
    run_id = (rt or {}).get("run_id")
    if not run_id:
        print("NO run_id -> abort"); sys.exit(2)
    print("== run_id:", run_id)

    print("== agent_wait_task ...")
    t0 = time.time()
    res, sid = call_tool("agent_wait_task", {"run_id": run_id, "timeout_ms": 240000}, sid)
    print("wait elapsed %.1fs" % (time.time() - t0))
    print("wait text:", json.dumps(get_text(res), ensure_ascii=False)[:800])

    print("== agent_get_run_logs (limit 120) ...")
    res, sid = call_tool("agent_get_run_logs", {"limit": 120}, sid)
    lines = (get_text(res) or {}).get("lines", [])
    print("lines count:", len(lines))
    for ln in lines[-80:]:
        print(ln)

if __name__ == "__main__":
    main()
