#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkDuo 自测闭环驱动：真实跑一个 Agent 任务，并采集「执行轨迹 + 思考过程 + 正文回复」。

用法:
  python mcp_trace_driver.py [agentId] [prompt]

默认 agentId = 0abb2852-1509-4d08-a05a-7b4a4f315a35 (WorkDuo方案设计助手: M3 + KB + 记忆关 + 从不审批)
默认 prompt  = 一条基于绑定 KB 的知识问答。

注意:
  - 走内建 MCP Server (127.0.0.1:18755/mcp, Streamable HTTP)。
  - 用裸 socket 读满 EOF，规避任何 Content-Length 偏差导致的 JSON 腰斩。
  - 依次: initialize -> notifications/initialized -> tools/call agent_run_task
          -> tools/call agent_wait_task -> tools/call agent_get_run_trace。
  - agent_get_run_trace 返回 events(plan/step/tool/intent/status/task_done 等结构化事件)
    + thinking(累计思考) + reply(累计正文) + counts，用于判断「整链哪里断」。
"""
import json
import socket
import sys
import time

HOST = "127.0.0.1"
PORT = 18755
PATH = "/mcp"

DEFAULT_AGENT = "0abb2852-1509-4d08-a05a-7b4a4f315a35"
DEFAULT_PROMPT = (
    "请基于你绑定的 WorkDuo 方案设计知识库，用不超过 3 句话概括 WorkDuo 的核心架构，"
    "并说明它和「小队（Squad）协作」的关系。"
)

REQ_ID = [0]


def rpc(method, params=None, notify=False):
    REQ_ID[0] += 1
    rid = None if notify else REQ_ID[0]
    return {"jsonrpc": "2.0", "method": method, "params": params or {}}, rid


def send_recv(sock, payload):
    body = json.dumps(payload).encode("utf-8")
    req = (
        f"POST {PATH} HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        "Content-Type: application/json\r\n"
        "Accept: application/json, text/event-stream\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("utf-8") + body
    sock.sendall(req)
    # 读满 EOF (服务器 Connection: close)
    data = b""
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        data += chunk
    return data.decode("utf-8", "replace")


def parse_rpc(raw):
    """把 MCP HTTP 响应解析为 JSON-RPC 信封(dict)。兼容两种形态：
    - 纯 JSON（Connection: close 的 application/json）
    - SSE 分帧（text/event-stream：'event: message\\r\\ndata: {...}'，可能多帧）
    """
    raw = raw.strip()
    # SSE 分帧：抽取所有 data: 行，逐帧 JSON 解析，取最后一个含 result/error 的。
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
        # 退路：拼起来再试一次
        if frames:
            try:
                return json.loads("\n".join(frames))
            except Exception:
                pass
    # 纯 JSON：跳过状态行 + 头部，取首个 \r\n\r\n 之后实体。
    idx = raw.find("\r\n\r\n")
    body = raw[idx + 4:] if idx != -1 else raw
    try:
        return json.loads(body)
    except Exception as e:
        return {"__raw__": body[:500], "__parse_error__": str(e)}


def call_tool(name, args, session=None, timeout=10):
    sock = socket.create_connection((HOST, PORT), timeout=timeout)
    try:
        payload, _ = rpc("tools/call", {"name": name, "arguments": args})
        if session:
            payload["_session"] = session  # 仅标记，真正 session 由 headers 携带
        raw = send_recv(sock, payload)
    finally:
        sock.close()
    return parse_rpc(raw)


def main():
    agent_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_AGENT
    prompt = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_PROMPT

    # 1) initialize
    sock = socket.create_connection((HOST, PORT), timeout=10)
    init_payload, _ = rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "self-test", "version": "1.0"},
    })
    init_raw = send_recv(sock, init_payload)
    init_json = parse_rpc(init_raw)
    sess = None
    # 提取 session id（如响应头 Mcp-Session-Id）
    hidx = init_raw.find("Mcp-Session-Id:")
    if hidx != -1:
        sess = init_raw[hidx + len("Mcp-Session-Id:"):].strip().split("\r")[0].strip()
    print(f"[init] session={sess} server={init_json.get('result', {}).get('serverInfo', '?')}")
    sock.close()

    # 2) initialized 通知
    sock = socket.create_connection((HOST, PORT), timeout=10)
    notif, _ = rpc("notifications/initialized", {}, notify=True)
    send_recv(sock, notif)
    sock.close()

    # 3) run_task (camelCase 入参，与 RunAgentTaskInput serde 一致)
    # 全局 run lock 互斥：若上一次 run 仍在跑，重试等待其释放后再起新 run（新 run 会 reset 轨迹缓冲）。
    t0 = time.time()
    run_id = None
    for attempt in range(18):  # 最多 ~90s 等待锁释放
        r = call_tool("agent_run_task", {"agentId": agent_id, "prompt": prompt})
        print(f"[run_task] -> {json.dumps(r, ensure_ascii=False)[:400]}")
        if "result" in r:
            content = r["result"].get("content", [])
            for c in content:
                if c.get("type") == "text":
                    txt = c.get("text", "")
                    print(f"[run_task.text] {txt[:300]}")
                    try:
                        run_id = json.loads(txt).get("run_id")
                    except Exception:
                        pass
            break
        elif "error" in r:
            err = json.dumps(r["error"], ensure_ascii=False)
            if "已有任务正在运行" in err:
                print(f"[run_task] 全局锁占用，第 {attempt+1} 次重试，5s 后…")
                time.sleep(5)
                continue
            print(f"[run_task.error] {err[:400]}")
            return

    if not run_id:
        print("[!] 未拿到 run_id，终止。")
        return
    print(f"[run_id] {run_id}")

    # 4) 等待终态：先 wait_task（长连接），若仍超时则用 get_status 轮询兜底（LLM 慢时 run 可能 >180s）。
    r2 = call_tool("agent_wait_task", {"run_id": run_id, "timeout_ms": 280000}, timeout=300)
    print(f"[wait_task] -> {json.dumps(r2, ensure_ascii=False)[:400]}")
    # 兜底轮询：确保 run 真正进入 done 后再取 trace（否则缓冲未满）。
    for _ in range(48):  # 最多再等 4 分钟
        rs = call_tool("agent_get_status", {"run_id": run_id}, timeout=20)
        st = None
        if "result" in rs:
            for c in rs["result"].get("content", []):
                if c.get("type") == "text":
                    try:
                        st = json.loads(c.get("text", "{}")).get("status", {})
                    except Exception:
                        pass
        if st and st.get("status") == "done":
            print(f"[status] done: {json.dumps(st, ensure_ascii=False)[:300]}")
            break
        time.sleep(5)

    # 5) get_run_trace
    r3 = call_tool("agent_get_run_trace", {})
    trace = None
    if "result" in r3:
        for c in r3["result"].get("content", []):
            if c.get("type") == "text":
                try:
                    obj = json.loads(c.get("text", "{}"))
                    # 工具返回 {"trace": {...}}，真实数据在 .trace 一层。
                    trace = obj.get("trace", obj)
                except Exception:
                    trace = {"__raw__": c.get("text", "")}
    elif "error" in r3:
        print(f"[get_run_trace.error] {json.dumps(r3['error'], ensure_ascii=False)[:400]}")
        return

    if not trace:
        print("[!] trace 为空，原始:", json.dumps(r3, ensure_ascii=False)[:500])
        return

    print("\n========== TRACE ==========")
    counts = trace.get("counts", {})
    print(f"[counts] {json.dumps(counts, ensure_ascii=False)}")
    print(f"\n[REPLY]\n{trace.get('reply', '')}")
    thinking = trace.get("thinking", "")
    print(f"\n[THINKING] (len={len(thinking)})\n{thinking[:1500]}")
    print(f"\n[EVENTS] (共 {len(trace.get('events', []))} 条):")
    for ev in trace.get("events", []):
        et = ev.get("event")
        p = ev.get("payload", {})
        etype = p.get("eventType") if isinstance(p, dict) else None
        ts = ev.get("ts_ms")
        # 关键字段抽样
        extra = ""
        if isinstance(p, dict):
            if "step" in p and p["step"]:
                extra += f" step={p['step'].get('name','?')}"
            if "message" in p and p["message"]:
                extra += f" msg={str(p['message'])[:60]}"
            if "status" in p and p["status"]:
                extra += f" status={p['status']}"
        print(f"  - {et}/{etype} ts={ts}{extra}")
    print(f"\n[总耗时] {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
