import socket, json, time, os, sys

HOST, PORT = "127.0.0.1", 18755
HERE = os.path.dirname(os.path.abspath(__file__))

def mcp_call(method, params=None, sid=None, timeout=320):
    msg = {"jsonrpc": "2.0", "id": int(time.time() * 1000) % 1000000, "method": method}
    if params is not None:
        msg["params"] = params
    body = json.dumps(msg).encode("utf-8")
    req = (
        "POST /mcp HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        "Content-Type: application/json\r\n"
        "Accept: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
    )
    if sid:
        req += f"Mcp-Session-Id: {sid}\r\n"
    req += "Connection: close\r\n\r\n"
    req = req.encode() + body

    s = socket.create_connection((HOST, PORT), timeout=timeout)
    s.settimeout(timeout)
    s.sendall(req)
    chunks = []
    while True:
        try:
            data = s.recv(65536)
        except socket.timeout:
            break
        if not data:
            break
        chunks.append(data)
    s.close()
    raw = b"".join(chunks).decode("utf-8", errors="replace")
    idx = raw.find("\r\n\r\n")
    header = raw[:idx] if idx >= 0 else ""
    body_text = raw[idx + 4:] if idx >= 0 else raw
    cl = None
    for line in header.split("\r\n"):
        if line.lower().startswith("content-length:"):
            try:
                cl = int(line.split(":", 1)[1].strip())
            except Exception:
                pass
    parsed = None
    try:
        parsed = json.loads(body_text)
    except Exception as e:
        # body may still be valid if truncated by client; try strip
        try:
            parsed = json.loads(body_text.strip())
        except Exception:
            print(f"   [mcp_call {method}] parse-fail: {e}; CL={cl} bodlen={len(body_text)} head={body_text[:160]!r}")
    return parsed, header, body_text, cl

def call_tool(name, args, sid):
    res, h, b, cl = mcp_call("tools/call", {"name": name, "arguments": args}, sid)
    return res, h, b, cl

def get_text(res):
    if res and isinstance(res, dict) and res.get("result"):
        try:
            return json.loads(res["result"]["content"][0]["text"])
        except Exception:
            return None
    return None

def main():
    res, h, b, cl = mcp_call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "demo", "version": "0"}})
    sid = None
    for line in h.split("\r\n"):
        if line.lower().startswith("mcp-session-id:"):
            sid = line.split(":", 1)[1].strip()
    print("== initialize sid:", sid, " CL=", cl, " bodlen=", len(b))
    mcp_call("notifications/initialized", {}, sid)

    agent_id = "0abb2852-1509-4d08-a05a-7b4a4f315a35"
    prompt = "请基于你绑定的 WorkDuo 方案设计知识库，用不超过 3 句话概括 WorkDuo 的核心架构，并说明它和「小队（Squad）协作」的关系。"

    print("== agent_run_task ...")
    res, h, b, cl = call_tool("agent_run_task", {"agentId": agent_id, "prompt": prompt}, sid)
    rt = get_text(res)
    print("run_task text:", json.dumps(rt, ensure_ascii=False)[:600])
    run_id = (rt or {}).get("run_id")
    if not run_id:
        # try regex
        import re
        m = re.search(r'"run_id"\s*:\s*"([^"]+)"', b)
        run_id = m.group(1) if m else None
    if not run_id:
        print("NO run_id -> abort (likely global run-lock held)"); sys.exit(2)
    print("== run_id:", run_id)

    print("== agent_wait_task (timeout 240000ms) ...")
    t0 = time.time()
    res, h, b, cl = call_tool("agent_wait_task", {"run_id": run_id, "timeout_ms": 240000}, sid)
    print("wait elapsed %.1fs" % (time.time() - t0))
    print("wait text:", json.dumps(get_text(res), ensure_ascii=False)[:1000])

    print("== agent_get_run_logs (limit 200) ...")
    res, h, b, cl = call_tool("agent_get_run_logs", {"limit": 200}, sid)
    txt = get_text(res) or {}
    lines = txt.get("lines", [])
    print("lines count:", len(lines))
    out = os.path.join(HERE, "run_logs_dump.txt")
    with open(out, "w", encoding="utf-8") as f:
        for ln in lines:
            f.write(ln + "\n")
    print("wrote", out)
    for ln in lines[-60:]:
        print(ln)

if __name__ == "__main__":
    main()
