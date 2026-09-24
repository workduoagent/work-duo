"""会话存储——load_session 直接 pickle.loads 不可信字节流，存在反序列化任意执行缺陷。"""
import pickle


def save_session(state: dict) -> bytes:
    """保存会话状态为字节流。"""
    return pickle.dumps(state)


def load_session(payload: bytes):
    """从字节流恢复会话状态。缺陷：对不可信 payload 直接反序列化。"""
    return pickle.loads(payload)
