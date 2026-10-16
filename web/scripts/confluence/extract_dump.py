"""사용: python -I extract_dump.py <Confluence_backup.sql> <confluence.sqlite>

Confluence pg_dump(.sql) 에서 필요한 표만 스트리밍으로 뽑아 SQLite 로 둔다. 덤프는 실행하지 않고 글자로만 읽는다.

1차: spaces · content · label · content_label · contentproperties · user_mapping → 대상 스페이스의 현재 페이지와 첨부를 고른다
2차: 그 페이지들의 bodycontent(현재 판) · 그 첨부들의 attachmentdata(바이너리)
"""
import re
import sqlite3
import sys
import time

DUMP = sys.argv[1]   # Confluence pg_dump(.sql)
OUT = sys.argv[2]    # 만들 SQLite 파일
SPACES = ("SB", "faq", "TRguide")

_esc = re.compile(r"\\(\\|b|f|n|r|t|v|[0-7]{1,3}|x[0-9a-fA-F]{1,2})")
_map = {"\\": "\\", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}


def unesc(s: str):
    if s == r"\N":
        return None
    if "\\" not in s:
        return s

    def rep(m):
        g = m.group(1)
        if g in _map:
            return _map[g]
        if g[0] == "x":
            return chr(int(g[1:], 16))
        return chr(int(g, 8))
    return _esc.sub(rep, s)


def copy_blocks(want):
    """want: {table: callback(cols, fields)} — 대상 COPY 블록의 행만 넘긴다."""
    t0 = time.time()
    cur = None
    cols = None
    with open(DUMP, "r", encoding="utf-8", errors="surrogateescape", newline="\n") as f:
        for line in f:
            if cur is None:
                if line.startswith("COPY public."):
                    name = line[len("COPY public."):line.index(" ", len("COPY public."))]
                    if name in want:
                        cur = name
                        cols = [c.strip() for c in line[line.index("(") + 1:line.index(")")].split(",")]
                continue
            if line == "\\.\n":
                print(f"  {cur} 끝 ({time.time() - t0:.0f}s)", flush=True)
                cur = None
                continue
            want[cur](cols, [unesc(x) for x in line.rstrip("\n").split("\t")])


db = sqlite3.connect(OUT)
db.executescript("""
DROP TABLE IF EXISTS spaces; DROP TABLE IF EXISTS content; DROP TABLE IF EXISTS label; DROP TABLE IF EXISTS content_label;
DROP TABLE IF EXISTS props; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS body; DROP TABLE IF EXISTS attdata;
CREATE TABLE spaces (spaceid INTEGER PRIMARY KEY, spacekey TEXT, spacename TEXT, homepage INTEGER);
CREATE TABLE content (contentid INTEGER PRIMARY KEY, contenttype TEXT, title TEXT, version INTEGER, creator TEXT,
  creationdate TEXT, lastmodifier TEXT, lastmoddate TEXT, prevver INTEGER, content_status TEXT, pageid INTEGER,
  spaceid INTEGER, parentid INTEGER, child_position INTEGER);
CREATE TABLE label (labelid INTEGER PRIMARY KEY, name TEXT, namespace TEXT);
CREATE TABLE content_label (labelid INTEGER, contentid INTEGER);
CREATE TABLE props (contentid INTEGER, name TEXT, stringval TEXT, longval INTEGER);
CREATE TABLE users (user_key TEXT PRIMARY KEY, username TEXT);
CREATE TABLE body (contentid INTEGER PRIMARY KEY, bodytypeid INTEGER, body TEXT);
CREATE TABLE attdata (attachmentid INTEGER PRIMARY KEY, attversion INTEGER, data BLOB);
""")


def ins(table, keep):
    def cb(cols, vals):
        row = dict(zip(cols, vals))
        db.execute(f"INSERT OR REPLACE INTO {table} ({','.join(keep)}) VALUES ({','.join('?' * len(keep))})",
                   [row.get(k) for k in keep])
    return cb


def props_cb(cols, vals):
    r = dict(zip(cols, vals))
    if r["propertyname"] in ("FILESIZE", "MEDIA_TYPE", "FILE_SIZE", "CONTENT_TYPE", "MINOR_EDIT"):
        db.execute("INSERT INTO props VALUES (?,?,?,?)", (r["contentid"], r["propertyname"], r["stringval"], r["longval"]))


print("1차", flush=True)
copy_blocks({
    "spaces": ins("spaces", ["spaceid", "spacekey", "spacename", "homepage"]),
    "content": ins("content", ["contentid", "contenttype", "title", "version", "creator", "creationdate", "lastmodifier",
                               "lastmoddate", "prevver", "content_status", "pageid", "spaceid", "parentid", "child_position"]),
    "label": ins("label", ["labelid", "name", "namespace"]),
    "content_label": ins("content_label", ["labelid", "contentid"]),
    "contentproperties": props_cb,
    "user_mapping": ins("users", ["user_key", "username"]),
})
db.commit()

# 대상: 세 스페이스의 현재 판 페이지(+블로그) · 그 페이지에 달린 현재 첨부
db.executescript(f"""
DROP TABLE IF EXISTS target_pages; DROP TABLE IF EXISTS target_atts;
CREATE TABLE target_pages AS
  SELECT c.* FROM content c JOIN spaces s ON s.spaceid = c.spaceid
  WHERE s.spacekey IN ({','.join("'" + k + "'" for k in SPACES)}) AND c.contenttype IN ('PAGE','BLOGPOST')
    AND c.prevver IS NULL AND c.content_status = 'current';
CREATE TABLE target_atts AS
  SELECT a.* FROM content a WHERE a.contenttype = 'ATTACHMENT' AND a.prevver IS NULL AND a.content_status = 'current'
    AND a.pageid IN (SELECT contentid FROM target_pages);
""")
pages = {r[0] for r in db.execute("SELECT contentid FROM target_pages")}
atts = {r[0] for r in db.execute("SELECT contentid FROM target_atts")}
print(f"대상 페이지 {len(pages)} · 첨부 {len(atts)}", flush=True)


def body_cb(cols, vals):
    r = dict(zip(cols, vals))
    if int(r["contentid"]) in pages:
        db.execute("INSERT OR REPLACE INTO body VALUES (?,?,?)", (r["contentid"], r["bodytypeid"], r["body"]))


def att_cb(cols, vals):
    r = dict(zip(cols, vals))
    aid = int(r["attachmentid"]) if r["attachmentid"] else None
    if aid in atts and r["data"]:
        raw = r["data"]
        data = bytes.fromhex(raw[2:]) if raw.startswith("\\x") else raw.encode("latin-1", "surrogateescape")
        db.execute("INSERT OR REPLACE INTO attdata VALUES (?,?,?)", (aid, r["attversion"], data))


print("2차", flush=True)
copy_blocks({"bodycontent": body_cb, "attachmentdata": att_cb})
db.commit()
for q in ["SELECT count(*) FROM body", "SELECT count(*), sum(length(data)) FROM attdata"]:
    print(q, "→", db.execute(q).fetchone())
db.close()
