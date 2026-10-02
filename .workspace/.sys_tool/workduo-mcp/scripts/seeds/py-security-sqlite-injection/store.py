"""用户仓储（内存 SQLite）——查询语句用字符串拼接构造，存在 SQL 注入缺陷。"""
import sqlite3


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, pwd TEXT)")
    conn.executemany(
        "INSERT INTO users (name, pwd) VALUES (?, ?)",
        [("admin", "s3cret"), ("O'Brien", "pw2"), ("bob", "hunter2")],
    )
    conn.commit()
    return conn


def authenticate(conn: sqlite3.Connection, name: str, pwd: str):
    """密码校验：命中返回 (id, name)，否则 None。"""
    sql = f"SELECT id, name FROM users WHERE name = '{name}' AND pwd = '{pwd}'"
    rows = conn.execute(sql).fetchall()
    return rows[0] if rows else None


def get_user(conn: sqlite3.Connection, name: str):
    """按名字查用户，命中返回 (id, name)，否则 None。"""
    sql = f"SELECT id, name FROM users WHERE name = '{name}'"
    rows = conn.execute(sql).fetchall()
    return rows[0] if rows else None


def user_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
