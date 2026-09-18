"""자동 추출 설정, 원문 스냅샷과 읽기 전용 기억의 출처를 저장한다."""
from __future__ import annotations

import copy
import json
import hashlib
import uuid

from kirian_contracts import assert_definition

from .storage import StorageError, encoded, now_ms

CATEGORIES = ("preference", "fact", "task")


def default_settings():
    return {"enabled": False, "conversations": False, "conversation_boundary": "local",
            "note_collection_ids": [], "screen_analyses": False,
            "categories": list(CATEGORIES), "retrieval_enabled": False}


def reference(source):
    return {key: source["record"][key] for key in ("source_id", "revision")}


def context_item(source):
    return reference(source) | {"text": source["text"]}


class AutoMemoryRepository:
    def __init__(self, store):
        self.store = store
        self.changed_sources = set()

    def snapshot(self):
        with self.store.transaction() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='auto_memory_settings'").fetchone()
            return json.loads(row[0]) if row else {"settings": default_settings(), "revision": 0}

    def settings(self):
        return self.snapshot()["settings"]

    def source_generation(self):
        with self.store.transaction() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='source_generation'").fetchone()
            return int(row[0]) if row else 0

    def source_epoch(self, source_id):
        with self.store.transaction() as db:
            row = db.execute("SELECT epoch FROM source_epochs WHERE source_id=?", (source_id,)).fetchone()
            return row[0] if row else 0

    def set_settings(self, settings, expected_revision=None):
        self.changed_sources = set()
        if (not isinstance(settings, dict) or set(settings) != set(default_settings())
                or any(type(settings[key]) is not bool for key in ("enabled", "conversations", "screen_analyses", "retrieval_enabled"))
                or settings["conversation_boundary"] not in ("local", "private_lan", "cloud")
                or not isinstance(settings["categories"], list) or not 1 <= len(settings["categories"]) <= 3
                or any(value not in CATEGORIES for value in settings["categories"])
                or len(set(settings["categories"])) != len(settings["categories"])
                or not isinstance(settings["note_collection_ids"], list) or len(settings["note_collection_ids"]) > 32):
            raise StorageError("invalid_request")
        for collection_id in settings["note_collection_ids"]:
            self.store._collection_id(collection_id)
        if len(set(settings["note_collection_ids"])) != len(settings["note_collection_ids"]):
            raise StorageError("invalid_request")
        if expected_revision is not None:
            self.store._revision(expected_revision)
        with self.store.transaction() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='auto_memory_settings'").fetchone()
            current = json.loads(row[0]) if row else {"settings": default_settings(), "revision": 0}
            if expected_revision is not None and expected_revision != current["revision"]:
                if settings["enabled"] or settings["retrieval_enabled"]:
                    raise StorageError("settings_changed")
                # An emergency stop changes only permissions, never stale scope fields.
                settings = current["settings"] | {"enabled": False, "retrieval_enabled": False}
            for collection_id in settings["note_collection_ids"]:
                if settings["enabled"] or settings["retrieval_enabled"] or collection_id not in current["settings"]["note_collection_ids"]:
                    self.store._collection(db, collection_id)
            # Revocation applies to previously captured text too. Never widen an
            # existing source when a later setting allows a broader destination.
            levels = {"local": 0, "private_lan": 1, "cloud": 2}
            boundary = settings["conversation_boundary"]
            roots = list(db.execute("""SELECT s.id,s.boundary FROM sources s JOIN auto_turn_sources t
                ON t.source_id=s.id WHERE s.deleted=0"""))
            affected = set()
            for root in roots:
                if levels[root["boundary"]] > levels[boundary]:
                    affected.update(self.store._descendants(db, root["id"]))
            if affected:
                expanded = set(affected)
                self.store._impact(db, expanded)
                preserved = {root["id"] for root in roots if root["id"] in expanded}
                # Raw history links survive a policy-only narrowing. A raw node
                # whose actual non-raw parent is retired cannot be kept valid.
                while True:
                    invalid = {source_id for source_id in preserved if any(
                        parent[0] in expanded and parent[0] not in preserved
                        for parent in db.execute("SELECT parent FROM source_parents WHERE child=?", (source_id,)))}
                    if not invalid:
                        break
                    preserved.difference_update(invalid)
                self.store._invalidate(db, affected, preserve=preserved)
                self.changed_sources.update(affected)
                for root in roots:
                    if root["id"] not in preserved:
                        continue
                    narrowed = boundary if levels[root["boundary"]] > levels[boundary] else root["boundary"]
                    db.execute("UPDATE sources SET boundary=?,revision=revision+1,updated_at=? WHERE id=? AND deleted=0",
                               (narrowed, now_ms(), root["id"]))
                for source_id in preserved:
                    db.execute("""UPDATE source_parents SET revision=(SELECT s.revision FROM sources s WHERE s.id=parent)
                        WHERE child=?""", (source_id,))
            saved = {"settings": settings, "revision": current["revision"] + 1}
            db.execute("""INSERT INTO metadata(key,value) VALUES('auto_memory_settings',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (encoded(saved),))
        return copy.deepcopy(settings)

    def capture_turn(self, conversation_id, turn_id, boundary, history):
        if boundary not in ("local", "private_lan", "cloud") or not isinstance(history, list) or len(history) > 100:
            raise StorageError("invalid_request")
        with self.store.transaction() as db:
            parents = {}
            for message in history:
                for ref in message.get("sources", []):
                    assert_definition("SourceRef", ref)
                    if ref["source_id"] in parents and parents[ref["source_id"]] != ref["revision"]:
                        raise StorageError("source_changed")
                    parents[ref["source_id"]] = ref["revision"]
            # Preserve each actually used historical turn's raw text, independently
            # of the conservative manual conversation anchor.
            raw_history = [message for message in history if "content" in message]
            if raw_history:
                rows = list(db.execute("""SELECT rowid,* FROM turns WHERE conversation_id=? AND response_complete=1
                    AND redacted=0 ORDER BY rowid DESC LIMIT 1000""", (conversation_id,)))
                cursor = 0
                for message in reversed(raw_history):
                    field = "user_text" if message.get("role") == "user" else "assistant_text"
                    if "_turn_id" in message:
                        matched = db.execute("""SELECT * FROM turns WHERE conversation_id=? AND id=?
                            AND response_complete=1 AND redacted=0""", (conversation_id, message["_turn_id"])).fetchone()
                        if (matched is None or matched["id"] == turn_id or matched[field] != message["content"]
                                or json.loads(matched["sources"]) != message.get("sources", [])):
                            raise StorageError("source_changed")
                    else:
                        match = next((i for i in range(cursor, len(rows)) if rows[i]["id"] != turn_id
                                      and rows[i][field] == message["content"]
                                      and json.loads(rows[i]["sources"]) == message.get("sources", [])), None)
                        if match is None:
                            raise StorageError("source_changed")
                        matched = rows[match]
                        cursor = match + (1 if field == "user_text" else 0)
                    prior = self._capture(db, conversation_id, matched["id"], boundary, [])
                    parents[prior["record"]["source_id"]] = prior["record"]["revision"]
            refs = [{"source_id": key, "revision": value} for key, value in sorted(parents.items())]
            return self._capture(db, conversation_id, turn_id, boundary, refs)

    def _capture(self, db, conversation_id, turn_id, boundary, history_refs):
        row = db.execute("SELECT * FROM turns WHERE conversation_id=? AND id=?", (conversation_id, turn_id)).fetchone()
        if row is None or not row["response_complete"] or row["redacted"] or row["status"] not in ("running", "completed"):
            raise StorageError("source_changed")
        parents = {encoded(ref): ref for ref in json.loads(row["sources"]) + history_refs}
        refs = sorted(parents.values(), key=lambda ref: ref["source_id"])
        if len(refs) > 128:
            raise StorageError("context_blocked")
        self.store._validate_parents(db, refs, boundary)
        prior = db.execute("SELECT source_id FROM auto_turn_sources WHERE conversation_id=? AND turn_id=?", (conversation_id, turn_id)).fetchone()
        if prior:
            source = self.store._source(db, prior[0])
            self.store._validate_parents(db, [reference(source)], boundary)
            return source
        source_id = "auto-turn-" + uuid.uuid4().hex
        text = "사용자: " + row["user_text"] + "\n키리안: " + row["assistant_text"]
        title = (row["user_text"].strip() or "대화 기억")[:120]
        db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'conversation',?,?,?,?)",
                   (source_id, boundary, title, text, now_ms()))
        db.execute("INSERT INTO auto_turn_sources VALUES(?,?,?)", (source_id, conversation_id, turn_id))
        db.executemany("INSERT INTO source_parents VALUES(?,?,?)", ((source_id, ref["source_id"], ref["revision"]) for ref in refs))
        return self.store._source(db, source_id)

    @staticmethod
    def validate_extraction(source, items, categories=CATEGORIES):
        if not isinstance(items, list) or len(items) > 12:
            raise StorageError("invalid_extraction")
        seen = set()
        for item in items:
            if (not isinstance(item, dict) or set(item) != {"category", "text", "quote"}
                    or item["category"] not in categories
                    or any(not isinstance(item[key], str) or not item[key].strip() or len(item[key]) > 1024 for key in ("text", "quote"))
                    or item["quote"] not in source["text"] or encoded(item) in seen):
                raise StorageError("invalid_extraction")
            seen.add(encoded(item))
        return items

    def extraction_chunks(self, source):
        """긴 대화의 전체 원본을 보존하면서 각 추출 입력도 독립 출처로 고정한다."""
        if len(source["text"]) > 131072:
            raise StorageError("source_too_large")
        result = []
        with self.store.transaction() as db:
            self.store._validate_parents(db, [reference(source)], source["record"]["boundary"])
            for offset in range(0, len(source["text"]), 8192):
                key = encoded([reference(source), offset])
                source_id = "auto-chunk-" + hashlib.sha256(key.encode()).hexdigest()
                if not db.execute("SELECT 1 FROM sources WHERE id=?", (source_id,)).fetchone():
                    db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'index',?,?,?,?)",
                               (source_id, source["record"]["boundary"], source["title"], source["text"][offset:offset+8192], now_ms()))
                    db.execute("INSERT INTO source_parents VALUES(?,?,?)", (source_id, source["record"]["source_id"], source["record"]["revision"]))
                result.append(self.store._source(db, source_id))
        return result

    def remember(self, source, items, actual_model, categories=CATEGORIES):
        assert_definition("ModelRef", actual_model)
        self.validate_extraction(source, items, categories)
        result = []
        with self.store.transaction() as db:
            self.store._validate_parents(db, [reference(source)], source["record"]["boundary"])
            current = self.store._source(db, source["record"]["source_id"])
            if current != source:
                raise StorageError("source_changed")
            for item in items:
                if db.execute("""SELECT 1 FROM auto_memory_evidence e JOIN source_parents p ON p.child=e.source_id
                    JOIN derived_memories m ON m.source_id=e.source_id JOIN sources s ON s.id=e.source_id
                    WHERE p.parent=? AND p.revision=? AND e.category=? AND e.quote=? AND m.content=? AND s.deleted=0""",
                    (source["record"]["source_id"], source["record"]["revision"], item["category"], item["quote"], item["text"])).fetchone():
                    continue
                if db.execute("SELECT count(*) FROM auto_memory_evidence").fetchone()[0] >= 10000:
                    raise StorageError("index_limit")
                source_id, stamp = "auto-memory-" + uuid.uuid4().hex, now_ms()
                title = item["text"][:120]
                db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'memory',?,?,'',?)",
                           (source_id, source["record"]["boundary"], title, stamp))
                db.execute("INSERT INTO source_parents VALUES(?,?,?)", (source_id, source["record"]["source_id"], source["record"]["revision"]))
                db.execute("INSERT INTO derived_memories VALUES(?,?)", (source_id, item["text"]))
                db.execute("INSERT INTO sources_fts VALUES(?,?,?)", (source_id, title, item["text"]))
                db.execute("INSERT INTO auto_memory_evidence VALUES(?,?,?,?,?,?)",
                           (source_id, item["category"], item["quote"], encoded(actual_model), source["title"], stamp))
                result.append(self.store._source(db, source_id))
        return result

    def evidence(self, source_ids=None):
        with self.store.transaction() as db:
            rows = list(db.execute("""SELECT e.*,s.revision,s.title,p.parent,p.revision AS parent_revision
                FROM auto_memory_evidence e JOIN sources s ON s.id=e.source_id
                JOIN source_parents p ON p.child=s.id WHERE s.deleted=0
                AND NOT EXISTS(SELECT 1 FROM unavailable_sources u WHERE u.source_id=s.id)
                ORDER BY e.created_at DESC,e.source_id DESC"""))
            return [{"source_id": row["source_id"], "revision": row["revision"], "title": row["title"],
                     "category": row["category"], "quote": row["quote"], "actual_model": json.loads(row["actual_model"]),
                     "parent": {"source_id": row["parent"], "revision": row["parent_revision"], "title": row["parent_title"]},
                     "created_at": row["created_at"]}
                    for row in rows if source_ids is None or row["source_id"] in source_ids][:50]
