#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 WorkDuo 内建 MCP 的 Rust 运行日志 (agent_get_run_logs)，用于判断 run 链路断点。"""
import json
import socket
import sys

HOST, PORT, PATH = "127.0.0.1", 18755, "/mcp"


def parse_rpc(raw):
    raw = raw.strip()
    if "data:" in raw:
        frames = []
        for line in raw.replace("\r\n", "\n").split("\n"):
            line = line.strip()
            if line.startswith("data:"):
                frames.append(line[len("data:"):].strip())
        for blob in reversed(frames):
            try:
                obj = json.loads(blob)
                if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                    return obj
            except Exception:
                pass
    idx = raw.find("\r\n\r\n")
    body = raw[idx + 4:] if idx != -1 else raw
    try:
        return json.loads(body)
    except Exception as e:
        return {"__raw__": body[:500], "__parse_error__": str(e)}


def send_recv(payload):
    body = json.dumps(payload).encode("utf-8")
    req = (f"POST {PATH} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nContent-Type: application/json\r\n"
           f"Accept: application/json, text/event-stream\r\nContent-Length: {len(body)}\r\n"
           "Connection: close\r\n\r\n").encode() + body
    s = socket.create_connection((HOST, PORT), timeout=10)
    s.sendall(req)
    data = b""
    while True:
        c = s.recv(65536)
        if not c:
            break
        data += c
    s.close()
    return parse_rpc(data.decode("utf-8", "replace"))


def call(name, args):
    return send_recv({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": name, "arguments": args}})


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    r = call("agent_get_run_logs", {"limit": limit})
    if "error" in r:
        print("ERROR:", json.dumps(r["error"], ensure_ascii=False)[:600])
        return
    if "result" not in r:
        print("NO RESULT:", json.dumps(r, ensure_ascii=False)[:600])
        return
    for c in r["result"].get("content", []):
        if c.get("type") == "text":
            try:
                obj = json.loads(c.get("text", "{}"))
            except Exception:
                obj = {"raw": c.get("text", "")}
            lines = obj.get("lines", obj.get("raw", ""))
            if isinstance(lines, str):
                print(lines)
            else:
                for ln in lines:
                    print(ln)


if __name__ == "__main__":
    main()
