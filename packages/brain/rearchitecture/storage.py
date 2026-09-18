"""Identity-bound SQLite domain records. Wire sessions and credentials are not persisted."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from kirian_contracts import assert_definition

from .policy import ContextSource


class StorageError(RuntimeError):
    def __init__(self, code="storage_unavailable"):
        self.code = code
        super().__init__(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def now_ms():
    return time.time_ns() // 1_000_000


class SourceCatalog:
    """Read current records on demand; durable sources do not accumulate in a cache."""
    def __init__(self, store, fallback):
        self.store, self.fallback = store, fallback

    def get(self, source_id, default=None):
        try:
            source = self.store.catalog_entry(source_id)
            return ContextSource(source["record"], source["text"])
        except StorageError as error:
            if error.code != "not_found":
                raise
            return self.fallback.get(source_id, default)

    def __getitem__(self, source_id):
        value = self.get(source_id)
        if value is None:
            raise KeyError(source_id)
        return value


class SQLiteStore:
    """One database per complete Identity, with atomic original/index invalidation."""
    def __init__(self, data_dir: str, identity: dict):
        assert_definition("Identity", identity)
        self.identity = copy.deepcopy(identity)
        owner = encoded(identity)
        directory = Path(data_dir).expanduser().resolve() / hashlib.sha256(owner.encode()).hexdigest()[:24]
        self.lock = threading.RLock()
        self.connection = None
        self._lock_file = None
        try:
            directory.mkdir(parents=True, exist_ok=True)
            self.path = directory / "brain.sqlite3"
            self._lock_file = open(directory / "writer.lock", "a+b")
            if os.fstat(self._lock_file.fileno()).st_size == 0:
                self._lock_file.write(b"\0")
                self._lock_file.flush()
            self._lock_file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.connection = sqlite3.connect(self.path, timeout=0.5, check_same_thread=False)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS conversations(
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, model TEXT
                );
                CREATE TABLE IF NOT EXISTS turns(
                    id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    user_text TEXT NOT NULL, assistant_text TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL, response_complete INTEGER NOT NULL DEFAULT 0,
                    actual_model TEXT, error_code TEXT, sources TEXT NOT NULL DEFAULT '[]',
                    redacted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
                    PRIMARY KEY(conversation_id,id)
                );
                CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id,created_at,id);
                CREATE TABLE IF NOT EXISTS sources(
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, kind TEXT NOT NULL,
                    boundary TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                    title TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_parents(
                    child TEXT NOT NULL REFERENCES sources(id), parent TEXT NOT NULL REFERENCES sources(id),
                    revision INTEGER NOT NULL, PRIMARY KEY(child,parent)
                );
                CREATE INDEX IF NOT EXISTS source_children ON source_parents(parent);
                CREATE TABLE IF NOT EXISTS derived_memories(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id), content TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(source_id UNINDEXED,title,text);
                CREATE TABLE IF NOT EXISTS collections(
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, boundary TEXT NOT NULL,
                    revision INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 0,
                    deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS collection_documents(
                    collection_id TEXT NOT NULL REFERENCES collections(id), path TEXT NOT NULL,
                    title TEXT NOT NULL, content_hash TEXT NOT NULL, chunk_count INTEGER NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection_id,path)
                );
                CREATE TABLE IF NOT EXISTS collection_chunks(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id), collection_id TEXT NOT NULL,
                    path TEXT NOT NULL, chunk_index INTEGER NOT NULL,
                    FOREIGN KEY(collection_id,path) REFERENCES collection_documents(collection_id,path),
                    UNIQUE(collection_id,path,chunk_index)
                );
                CREATE TABLE IF NOT EXISTS unavailable_sources(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id)
                );
                CREATE TABLE IF NOT EXISTS screen_captures(
                    capture_id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
                    captured_at INTEGER NOT NULL, analysis_source_id TEXT REFERENCES sources(id),
                    actual_model TEXT, prompt_hash TEXT
                );
                CREATE TABLE IF NOT EXISTS auto_turn_sources(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id),
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    turn_id TEXT NOT NULL, UNIQUE(conversation_id,turn_id)
                );
                CREATE TABLE IF NOT EXISTS auto_memory_evidence(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id), category TEXT NOT NULL,
                    quote TEXT NOT NULL, actual_model TEXT NOT NULL, parent_title TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_vectors(
                    source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL,
                    model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector TEXT NOT NULL,
                    PRIMARY KEY(source_id,model)
                );
                CREATE TABLE IF NOT EXISTS auto_memory_attempts(
                    source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL,
                    settings_revision INTEGER NOT NULL, status TEXT NOT NULL,
                    PRIMARY KEY(source_id,revision,settings_revision)
                );
                CREATE TABLE IF NOT EXISTS source_epochs(
                    source_id TEXT PRIMARY KEY REFERENCES sources(id), epoch INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS external_tool_results(
                    execution_id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
                    draft_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
                    proposal_id TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
                    registration_hash TEXT NOT NULL,
                    provenance TEXT NOT NULL, receipt TEXT NOT NULL,
                    UNIQUE(session_id,turn_id,proposal_id)
                );
            """)
            with self.transaction() as db:
                for table in ("turns", "screen_captures"):
                    if not any(row[1] == "routing_reason" for row in db.execute("PRAGMA table_info(" + table + ")")):
                        db.execute("ALTER TABLE " + table + " ADD COLUMN routing_reason TEXT")
                previous = db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
                if previous is not None and previous["value"] != owner:
                    raise StorageError()
                db.execute("INSERT OR IGNORE INTO metadata(key,value) VALUES ('identity',?)", (owner,))
                # Process interruption is visible and never retries inference or execution.
                db.execute("UPDATE turns SET status='cancelled' WHERE status IN ('input','running')")
                interrupted_memory = {row[0] for row in db.execute("""SELECT a.source_id FROM auto_turn_sources a
                    JOIN turns t ON t.conversation_id=a.conversation_id AND t.id=a.turn_id
                    JOIN sources s ON s.id=a.source_id WHERE s.deleted=0 AND t.status!='completed'""")}
                if interrupted_memory:
                    self._invalidate(db, interrupted_memory)
                # The owner must confirm a complete scan after every Brain restart.
                db.execute("UPDATE collections SET available=0")
                # Images are RAM-only. Unfinished captures cannot survive a process restart.
                staged = {row[0] for row in db.execute("""SELECT c.source_id FROM screen_captures c
                    JOIN sources s ON s.id=c.source_id WHERE s.deleted=0 AND c.analysis_source_id IS NULL""")}
                if staged:
                    self._invalidate(db, staged)
                self._refresh_unavailable(db)
        except StorageError:
            self.close()
            raise
        except (OSError, sqlite3.Error):
            self.close()
            raise StorageError() from None

    @contextmanager
    def transaction(self):
        with self.lock:
            try:
                with self.connection:
                    self.connection.execute("BEGIN IMMEDIATE")
                    yield self.connection
            except sqlite3.Error:
                raise StorageError() from None

    def close(self):
        with self.lock:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
            if self._lock_file is not None:
                # Closing releases OS ownership, including after constructor failure.
                self._lock_file.close()
                self._lock_file = None

    def saved_default(self):
        with self.transaction() as db:
            row = db.execute("SELECT value FROM metadata WHERE key='default_model'").fetchone()
            return json.loads(row["value"]) if row else None

    def set_default(self, model):
        assert_definition("ModelRef", model)
        with self.transaction() as db:
            db.execute("INSERT INTO metadata(key,value) VALUES('default_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encoded(model),))
        return {"model": copy.deepcopy(model), "source": "saved_default"}

    @staticmethod
    def conversation_dto(row):
        return {"id": row["id"], "title": row["title"], "updated_at": row["updated_at"], "model": json.loads(row["model"]) if row["model"] else None}

    def get_conversation(self, conversation_id):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            if row is None:
                raise StorageError("not_found")
            return self.conversation_dto(row)

    def create_conversation(self):
        conversation_id, stamp = uuid.uuid4().hex, now_ms()
        with self.transaction() as db:
            db.execute("INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)", (conversation_id, "새 대화", stamp))
            # A stable, conservative provenance anchor for explicitly derived memories.
            db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'conversation','local',?,'',?)",
                       ("conversation-" + conversation_id, "대화 기록", stamp))
        return self.get_conversation(conversation_id)

    def list_conversations(self):
        with self.transaction() as db:
            return [self.conversation_dto(row) for row in db.execute("SELECT * FROM conversations ORDER BY updated_at DESC,id DESC LIMIT 50")]

    def set_conversation_model(self, conversation_id, model):
        self.get_conversation(conversation_id)
        if model is not None:
            assert_definition("ModelRef", model)
        with self.transaction() as db:
            db.execute("UPDATE conversations SET model=?,updated_at=? WHERE id=?", (encoded(model) if model is not None else None, now_ms(), conversation_id))
        return self.get_conversation(conversation_id)

    def begin_turn(self, conversation_id, turn_id, text):
        self.get_conversation(conversation_id)
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM turns WHERE id=? AND conversation_id=?", (turn_id, conversation_id)).fetchone():
                raise StorageError("invalid_request")
            stamp = now_ms()
            db.execute("INSERT INTO turns(id,conversation_id,user_text,status,created_at) VALUES(?,?,?,'input',?)", (turn_id, conversation_id, text, stamp))
            db.execute("UPDATE conversations SET updated_at=?,title=CASE WHEN title='새 대화' THEN ? ELSE title END WHERE id=?", (stamp, text.strip()[:120] or "새 대화", conversation_id))

    def start_turn(self, conversation_id, turn_id, sources):
        with self.transaction() as db:
            cursor = db.execute("UPDATE turns SET status='running',sources=? WHERE id=? AND conversation_id=? AND redacted=0",
                                (encoded(sources), turn_id, conversation_id))
            if cursor.rowcount != 1:
                raise StorageError("source_changed")

    def complete_response(self, conversation_id, turn_id, text, actual_model, sources, routing_reason=None):
        assert_definition("ModelRef", actual_model)
        if routing_reason is not None:
            assert_definition("RoutingReason", routing_reason)
        with self.transaction() as db:
            cursor = db.execute("""UPDATE turns SET assistant_text=?,response_complete=1,actual_model=?,sources=?,routing_reason=?
                WHERE id=? AND conversation_id=? AND status='running' AND redacted=0""",
                                (text, encoded(actual_model), encoded(sources), routing_reason, turn_id, conversation_id))
            if cursor.rowcount != 1:
                raise StorageError("source_changed")
            db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now_ms(), conversation_id))

    def end_turn(self, conversation_id, turn_id, status, text="", error_code=None, actual_model=None, routing_reason=None):
        if status not in ("completed", "cancelled", "failed"):
            raise StorageError("invalid_request")
        if routing_reason is not None:
            assert_definition("RoutingReason", routing_reason)
        with self.transaction() as db:
            if status != "completed":
                roots = {row[0] for row in db.execute("SELECT source_id FROM auto_turn_sources WHERE conversation_id=? AND turn_id=?", (conversation_id, turn_id))}
                if roots:
                    self._invalidate(db, roots)
            # Redaction wins over late cancellation/completion callbacks.
            db.execute("""UPDATE turns SET status=?, assistant_text=CASE WHEN response_complete=1 THEN assistant_text ELSE ? END,
                       actual_model=COALESCE(actual_model,?),error_code=?,routing_reason=COALESCE(routing_reason,?)
                       WHERE id=? AND conversation_id=? AND redacted=0""",
                       (status, text, encoded(actual_model) if actual_model else None, error_code, routing_reason, turn_id, conversation_id))
            db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now_ms(), conversation_id))

    def messages(self, conversation_id):
        self.get_conversation(conversation_id)
        with self.transaction() as db:
            rows = list(db.execute("SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100", (conversation_id,)))
        messages, characters = [], 0
        # Keep complete bodies. Omit older rows instead of labelling truncated text completed.
        for row in rows:
            turn_messages = []
            status = row["status"] if row["status"] in ("completed", "cancelled", "failed") else "cancelled"
            for role, key in (("user", "user_text"), ("assistant", "assistant_text")):
                if role == "assistant" and not row[key]:
                    continue
                item = {"id": role + "-" + hashlib.sha256(row["id"].encode()).hexdigest()[:32], "turn_id": row["id"], "role": role, "text": row[key], "status": status}
                if row["error_code"] and status == "failed":
                    item["error_code"] = row["error_code"]
                if role == "assistant" and row["actual_model"]:
                    item["actual_model"] = json.loads(row["actual_model"])
                    if row["routing_reason"] is not None:
                        item["routing_reason"] = row["routing_reason"]
                turn_messages.append(item)
            count = sum(len(item["text"]) for item in turn_messages)
            if characters + count > 32768 or len(messages) + len(turn_messages) > 100:
                # An individually large turn can still expose one whole message.
                for item in reversed(turn_messages):
                    if len(messages) < 100 and characters + len(item["text"]) <= 32768:
                        messages.insert(0, item)
                        characters += len(item["text"])
                break
            messages = turn_messages + messages
            characters += count
        return messages

    def history(self, conversation_id, max_messages=20, max_characters=32768):
        self.get_conversation(conversation_id)
        with self.transaction() as db:
            rows = list(db.execute("""SELECT * FROM turns WHERE conversation_id=? AND response_complete=1 AND redacted=0
                ORDER BY created_at DESC,rowid DESC LIMIT ?""", (conversation_id, max_messages)))
        history, count = [], 0
        for row in rows:
            pair_size = len(row["user_text"]) + len(row["assistant_text"])
            if len(history) + 2 > max_messages or count + pair_size > max_characters:
                break
            refs = json.loads(row["sources"])
            history = [{"role": "user", "content": row["user_text"], "sources": refs, "_turn_id": row["id"]},
                       {"role": "assistant", "content": row["assistant_text"], "sources": refs, "_turn_id": row["id"]}] + history
            count += pair_size
        return history

    def _source(self, db, source_id, include_deleted=False):
        row = db.execute("""SELECT s.*,m.content AS memory_text FROM sources s
            LEFT JOIN derived_memories m ON m.source_id=s.id WHERE s.id=?""", (source_id,)).fetchone()
        if row is None or row["deleted"] and not include_deleted:
            raise StorageError("not_found")
        parents = [{"source_id": parent["parent"], "revision": parent["revision"]} for parent in db.execute(
            "SELECT parent,revision FROM source_parents WHERE child=? ORDER BY parent", (source_id,))]
        record = {"source_id": row["id"], "revision": row["revision"], "identity": copy.deepcopy(self.identity),
                  "kind": row["kind"], "boundary": row["boundary"], "deleted": bool(row["deleted"]), "parents": parents}
        result = {"record": record, "title": row["title"], "text": row["memory_text"] if row["kind"] == "memory" and row["memory_text"] is not None else row["text"]}
        origin = db.execute("""SELECT c.id,c.label,ch.path,ch.chunk_index,d.chunk_count FROM collection_chunks ch
            JOIN collections c ON c.id=ch.collection_id
            JOIN collection_documents d ON d.collection_id=ch.collection_id AND d.path=ch.path
            WHERE ch.source_id=?""", (source_id,)).fetchone()
        if origin:
            result["origin"] = {"collection_id": origin["id"], "collection_label": origin["label"], "path": origin["path"],
                                "chunk_index": origin["chunk_index"], "chunk_count": origin["chunk_count"]}
        return result

    def catalog(self):
        with self.transaction() as db:
            result = {}
            for row in db.execute("SELECT id FROM sources"):
                source = self._source(db, row["id"], include_deleted=True)
                if db.execute("SELECT 1 FROM unavailable_sources WHERE source_id=?", (row["id"],)).fetchone():
                    source["record"]["deleted"], source["text"] = True, ""
                result[row["id"]] = ContextSource(source["record"], source["text"])
            return result

    def catalog_entry(self, source_id):
        with self.transaction() as db:
            source = self._source(db, source_id, include_deleted=True)
            if db.execute("SELECT 1 FROM unavailable_sources WHERE source_id=?", (source_id,)).fetchone():
                source["record"]["deleted"], source["text"] = True, ""
            return source

    def effective_source_records(self, refs):
        """Return current ancestor records, retaining deletion/availability overlays.

        This is evidence for a host validator, not an authorization decision: stale
        requested revisions are deliberately returned as the current revision.
        """
        if not isinstance(refs, list) or len(refs) > 128:
            raise StorageError("invalid_request")
        seen_refs = set()
        for ref in refs:
            try:
                assert_definition("SourceRef", ref)
            except (ValueError, TypeError):
                raise StorageError("invalid_request") from None
            if ref["source_id"] in seen_refs:
                raise StorageError("invalid_request")
            seen_refs.add(ref["source_id"])
        with self.transaction() as db:
            records, visiting = {}, set()
            def visit(source_id):
                if source_id in visiting or len(visiting) >= 64:
                    raise StorageError("source_changed")
                if source_id in records:
                    return
                if len(records) + len(visiting) >= 512:
                    raise StorageError("source_changed")
                source = self._source(db, source_id, include_deleted=True)
                record = source["record"]
                if db.execute("SELECT 1 FROM unavailable_sources WHERE source_id=?", (source_id,)).fetchone():
                    record["deleted"] = True
                visiting.add(source_id)
                for parent in record["parents"]:
                    visit(parent["source_id"])
                visiting.remove(source_id)
                records[source_id] = record
            for ref in refs:
                visit(ref["source_id"])
            return list(records.values())

    def register_tool_result(self, value, conversation_id=None):
        """Store authenticated, observed success evidence without creating authority.

        The app must additionally validate the live proposal before this synchronous
        commit. The durable execution claim survives source deletion to prevent replay.
        """
        from .tool_results import validate_registration, registered_result
        value = validate_registration(value, self.identity)
        provenance, receipt = value["provenance"], value["receipt"]
        fingerprint = hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()
        parents, boundary = provenance["parents"], provenance["boundary"]
        with self.transaction() as db:
            if conversation_id is not None and not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
                raise StorageError("source_changed")
            previous = db.execute("SELECT * FROM external_tool_results WHERE execution_id=?", (provenance["executionId"],)).fetchone()
            if previous:
                if previous["registration_hash"] != fingerprint or previous["conversation_id"] != conversation_id:
                    raise StorageError("source_changed")
                source = self._source(db, previous["source_id"], include_deleted=True)
                record = source["record"]
                if record["deleted"] or db.execute("SELECT 1 FROM unavailable_sources WHERE source_id=?", (record["source_id"],)).fetchone():
                    raise StorageError("source_changed")
                self._validate_parents(db, parents, boundary)
                return registered_result(source, provenance)
            if db.execute("""SELECT 1 FROM external_tool_results WHERE draft_id=? OR
                (session_id=? AND turn_id=? AND proposal_id=?)""", (provenance["draftId"], provenance["scope"]["session_id"],
                provenance["turnId"], provenance["proposalId"])).fetchone():
                raise StorageError("source_changed")
            self._validate_parents(db, parents, boundary)
            source_id, title = "tool-result-" + uuid.uuid4().hex, "도구 결과: " + provenance["toolName"][:100]
            db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'tool_result',?,?,?,?)",
                       (source_id, boundary, title, value["canonicalResultJson"], now_ms()))
            for ref in parents:
                db.execute("INSERT INTO source_parents(child,parent,revision) VALUES(?,?,?)", (source_id, ref["source_id"], ref["revision"]))
            db.execute("""INSERT INTO external_tool_results(execution_id,source_id,draft_id,session_id,turn_id,proposal_id,
                conversation_id,registration_hash,provenance,receipt) VALUES(?,?,?,?,?,?,?,?,?,?)""", (provenance["executionId"], source_id,
                provenance["draftId"], provenance["scope"]["session_id"], provenance["turnId"], provenance["proposalId"],
                conversation_id, fingerprint, encoded(provenance), encoded(receipt)))
            return registered_result(self._source(db, source_id), provenance)

    def get_source(self, source_id):
        with self.transaction() as db:
            return self._source(db, source_id)

    def list_sources(self, query=""):
        with self.transaction() as db:
            if query.strip():
                # Quote user terms: search syntax never becomes a caller-supplied FTS program.
                terms = query.split()[:16]
                match = " AND ".join('"' + term.replace('"', '""') + '"' for term in terms)
                rows = db.execute("""SELECT s.id FROM sources_fts f JOIN sources s ON s.id=f.source_id
                    WHERE sources_fts MATCH ? AND s.deleted=0
                    AND NOT EXISTS(SELECT 1 FROM unavailable_sources u WHERE u.source_id=s.id)
                    ORDER BY bm25(sources_fts),s.updated_at DESC LIMIT 50""", (match,))
            else:
                rows = db.execute("""SELECT id FROM sources s WHERE deleted=0 AND kind IN ('note','memory')
                    AND NOT EXISTS(SELECT 1 FROM unavailable_sources u WHERE u.source_id=s.id)
                    ORDER BY updated_at DESC,id DESC LIMIT 50""")
            return [self._source(db, row["id"]) for row in rows]

    def _validate_parents(self, db, parents, boundary):
        visited, visiting = {}, set()
        def visit(ref):
            source_id, revision = ref["source_id"], ref["revision"]
            if source_id in visiting or len(visiting) >= 64 or len(visited) + len(visiting) >= 512:
                raise StorageError("source_changed")
            if source_id in visited:
                if visited[source_id] != revision:
                    raise StorageError("source_changed")
                return
            parent = self._source(db, source_id)
            if db.execute("SELECT 1 FROM unavailable_sources WHERE source_id=?", (source_id,)).fetchone():
                raise StorageError("source_changed")
            record = parent["record"]
            if record["revision"] != revision:
                raise StorageError("source_changed")
            level = "private_lan" if record["kind"] == "screen" and record["boundary"] == "cloud" else record["boundary"]
            if level == "local" and boundary != "local" or level == "private_lan" and boundary == "cloud":
                raise StorageError("context_blocked")
            visiting.add(source_id)
            for ancestor in record["parents"]:
                visit(ancestor)
            visiting.remove(source_id)
            visited[source_id] = revision
        for ref in parents:
            assert_definition("SourceRef", ref)
            visit(ref)

    @staticmethod
    def _validate_source_fields(title, text, boundary):
        if not isinstance(title, str) or not title.strip() or len(title) > 120 or not isinstance(text, str) or not text.strip() or len(text) > 8192 or boundary not in ("local", "private_lan", "cloud"):
            raise StorageError("invalid_request")

    def create_source(self, title, text, boundary, kind, parents):
        self._validate_source_fields(title, text, boundary)
        if kind not in ("note", "memory") or not isinstance(parents, list) or len(parents) > 128 or len({encoded(ref) for ref in parents}) != len(parents):
            raise StorageError("invalid_request")
        source_id = uuid.uuid4().hex
        with self.transaction() as db:
            self._validate_parents(db, parents, boundary)
            db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,?,?,?,?,?)",
                       (source_id, kind, boundary, title, text if kind == "note" else "", now_ms()))
            if kind == "memory":
                db.execute("INSERT INTO derived_memories(source_id,content) VALUES(?,?)", (source_id, text))
            for ref in parents:
                db.execute("INSERT INTO source_parents(child,parent,revision) VALUES(?,?,?)", (source_id, ref["source_id"], ref["revision"]))
            db.execute("INSERT INTO sources_fts(source_id,title,text) VALUES(?,?,?)", (source_id, title, text))
            return self._source(db, source_id)

    def _descendants(self, db, source_id):
        return {row["id"] for row in db.execute("""WITH RECURSIVE children(id) AS (
            SELECT ? UNION SELECT p.child FROM source_parents p JOIN children c ON p.parent=c.id)
            SELECT id FROM children""", (source_id,))}

    def _impact(self, db, affected):
        # Conversation-derived memories have an implicit dependency through turns:
        # source -> turn -> conversation anchor -> memory. Expand that graph before
        # clearing any rows so another conversation cannot revive the same content.
        for source_id in list(affected):
            affected.update(self._descendants(db, source_id))
        original_affected = set(affected)
        pending = [(row, {ref["source_id"] for ref in json.loads(row["sources"])})
                   for row in db.execute("SELECT id,conversation_id,sources FROM turns WHERE redacted=0")]
        redacted, changed_anchors = [], set()
        while True:
            remaining, expanded = [], False
            for row, references in pending:
                if not references.intersection(affected):
                    remaining.append((row, references))
                    continue
                redacted.append(row)
                anchor = "conversation-" + row["conversation_id"]
                if anchor not in original_affected:
                    changed_anchors.add(anchor)
                descendants = self._descendants(db, anchor)
                for mapped in db.execute("SELECT source_id FROM auto_turn_sources WHERE conversation_id=? AND turn_id=?", (row["conversation_id"], row["id"])):
                    descendants.update(self._descendants(db, mapped[0]))
                expanded = expanded or not descendants.issubset(affected)
                affected.update(descendants)
            pending = remaining
            if not expanded:
                break
        return redacted, changed_anchors

    def _invalidate(self, db, affected, preserve=None):
        preserved = preserve if isinstance(preserve, set) else ({preserve} if preserve is not None else set())
        redacted, changed_anchors = self._impact(db, affected)
        if affected:
            self._advance_source_generation(db)
            self._advance_source_epochs(db, affected)
        for source_id in affected:
            db.execute("DELETE FROM source_vectors WHERE source_id=?", (source_id,))
            db.execute("DELETE FROM auto_memory_evidence WHERE source_id=?", (source_id,))
            db.execute("DELETE FROM sources_fts WHERE source_id=?", (source_id,))
            if source_id in changed_anchors:
                # The conversation survives; stale derived requests must use a new revision.
                db.execute("UPDATE sources SET revision=revision+1,updated_at=? WHERE id=? AND deleted=0", (now_ms(), source_id))
            elif source_id not in preserved:
                db.execute("UPDATE sources SET deleted=1,revision=revision+1,title='',text='',updated_at=? WHERE id=? AND deleted=0", (now_ms(), source_id))
                db.execute("DELETE FROM derived_memories WHERE source_id=?", (source_id,))
        # Never let a restored or currently cached derived answer revive removed source text.
        for row in redacted:
            db.execute("""UPDATE turns SET user_text='',assistant_text='',status='failed',error_code='source_changed',
                redacted=1,response_complete=0,actual_model=NULL,routing_reason=NULL WHERE id=? AND conversation_id=?""", (row["id"], row["conversation_id"]))
            db.execute("UPDATE conversations SET title='대화 기록',updated_at=? WHERE id=?", (now_ms(), row["conversation_id"]))

    def update_source(self, source_id, expected_revision, title, text, boundary):
        self._validate_source_fields(title, text, boundary)
        if type(expected_revision) is not int or expected_revision < 1:
            raise StorageError("invalid_request")
        with self.transaction() as db:
            old = self._source(db, source_id)
            if old["record"]["kind"] not in ("note", "memory") or "origin" in old:
                raise StorageError("invalid_request")
            if db.execute("SELECT 1 FROM screen_captures WHERE analysis_source_id=?", (source_id,)).fetchone():
                # Provider-attributed analysis is immutable; an edited copy is a new memory.
                raise StorageError("invalid_request")
            if db.execute("SELECT 1 FROM auto_memory_evidence WHERE source_id=?", (source_id,)).fetchone():
                raise StorageError("invalid_request")
            if old["record"]["revision"] != expected_revision:
                raise StorageError("source_changed")
            self._validate_parents(db, old["record"]["parents"], boundary)
            affected = self._descendants(db, source_id)
            self._invalidate(db, affected, preserve=source_id)
            # Reusing this memory in its parent conversation may invalidate that
            # parent during propagation. Never commit a replacement with stale ancestry.
            self._validate_parents(db, old["record"]["parents"], boundary)
            db.execute("UPDATE sources SET revision=revision+1,title=?,text=?,boundary=?,updated_at=? WHERE id=?",
                       (title, text if old["record"]["kind"] == "note" else "", boundary, now_ms(), source_id))
            if old["record"]["kind"] == "memory":
                db.execute("UPDATE derived_memories SET content=? WHERE source_id=?", (text, source_id))
            db.execute("INSERT INTO sources_fts(source_id,title,text) VALUES(?,?,?)", (source_id, title, text))
            return self._source(db, source_id), affected

    def delete_source(self, source_id, expected_revision):
        if type(expected_revision) is not int or expected_revision < 1:
            raise StorageError("invalid_request")
        with self.transaction() as db:
            old = self._source(db, source_id)
            if old["record"]["kind"] not in ("note", "memory", "tool_result") or "origin" in old:
                raise StorageError("invalid_request")
            if old["record"]["revision"] != expected_revision:
                raise StorageError("source_changed")
            affected = self._descendants(db, source_id)
            self._invalidate(db, affected)
            return affected

    def delete_conversation(self, conversation_id):
        self.get_conversation(conversation_id)
        with self.transaction() as db:
            affected = self._descendants(db, "conversation-" + conversation_id)
            for row in db.execute("SELECT source_id FROM auto_turn_sources WHERE conversation_id=?", (conversation_id,)):
                affected.update(self._descendants(db, row[0]))
            for row in db.execute("SELECT source_id FROM external_tool_results WHERE conversation_id=?", (conversation_id,)):
                affected.update(self._descendants(db, row[0]))
            self._invalidate(db, affected)
            db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
            return affected

    @staticmethod
    def _collection_id(collection_id):
        if not isinstance(collection_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", collection_id):
            raise StorageError("invalid_request")

    @staticmethod
    def _revision(revision, minimum=0):
        if type(revision) is not int or not minimum <= revision < 9007199254740991:
            raise StorageError("invalid_request")

    def _collection(self, db, collection_id, include_deleted=False):
        self._collection_id(collection_id)
        row = db.execute("SELECT * FROM collections WHERE id=?", (collection_id,)).fetchone()
        if row is None or row["deleted"] and not include_deleted:
            raise StorageError("not_found")
        return row

    @staticmethod
    def _collection_dto(db, row):
        count = db.execute("""SELECT count(*) FROM collection_chunks ch JOIN sources s ON s.id=ch.source_id
            WHERE ch.collection_id=? AND s.deleted=0""", (row["id"],)).fetchone()[0]
        return {"id": row["id"], "label": row["label"], "boundary": row["boundary"], "revision": row["revision"],
                "available": bool(row["available"]), "source_count": count}

    def list_collections(self):
        with self.transaction() as db:
            return [self._collection_dto(db, row) for row in db.execute("SELECT * FROM collections WHERE deleted=0 ORDER BY id")]

    def _refresh_unavailable(self, db):
        # Availability is a reversible overlay, including implicit conversation ancestry.
        affected = {row[0] for row in db.execute("""SELECT ch.source_id FROM collection_chunks ch
            JOIN collections c ON c.id=ch.collection_id JOIN sources s ON s.id=ch.source_id
            WHERE c.available=0 AND c.deleted=0 AND s.deleted=0""")}
        if affected:
            self._impact(db, affected)
        previous = {row[0] for row in db.execute("SELECT source_id FROM unavailable_sources")}
        if affected != previous:
            self._advance_source_generation(db)
            self._advance_source_epochs(db, affected ^ previous)
        # Existing evidence survives a normal restart/read outage behind the
        # availability overlay. A generation change still rejects late work,
        # even if an unchanged full scan restores availability before it finishes.
        db.execute("DELETE FROM unavailable_sources")
        db.executemany("INSERT INTO unavailable_sources(source_id) VALUES(?)", ((source_id,) for source_id in affected))
        return affected

    @staticmethod
    def _advance_source_generation(db):
        db.execute("""INSERT INTO metadata(key,value) VALUES('source_generation','1')
            ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1""")

    @staticmethod
    def _advance_source_epochs(db, affected):
        db.executemany("""INSERT INTO source_epochs(source_id,epoch) SELECT id,1 FROM sources WHERE id=?
            ON CONFLICT(source_id) DO UPDATE SET epoch=epoch+1""", ((source_id,) for source_id in affected))

    @staticmethod
    def _documents(documents):
        if not isinstance(documents, list) or len(documents) > 1000:
            raise StorageError("invalid_request")
        prepared, total = {}, 0
        for item in documents:
            if not isinstance(item, dict) or set(item) != {"path", "title", "text"}:
                raise StorageError("invalid_request")
            path, title, text = item["path"], item["title"], item["text"]
            if (not isinstance(path, str) or not 1 <= len(path) <= 1024 or "\\" in path or ":" in path
                    or any(ord(char) < 32 or ord(char) == 127 for char in path)
                    or any(part in ("", ".", "..") for part in path.split("/")) or not path.lower().endswith(".md")
                    or path in prepared or not isinstance(title, str) or not title.strip() or len(title) > 120
                    or not isinstance(text, str)):
                raise StorageError("invalid_request")
            try:
                raw = text.encode("utf-8")
                path.encode("utf-8")
                title.encode("utf-8")
            except UnicodeError:
                raise StorageError("invalid_request") from None
            total += len(raw)
            if len(raw) > 256 * 1024 or total > 16 * 1024 * 1024:
                raise StorageError("invalid_request")
            prepared[path] = {"title": title, "hash": hashlib.sha256(raw).hexdigest(),
                              "chunks": [text[index:index + 8192] for index in range(0, len(text), 8192)]}
        return prepared

    def sync_collection(self, collection_id, expected_revision, label, boundary, documents):
        self._collection_id(collection_id)
        self._revision(expected_revision)
        if not isinstance(label, str) or not label.strip() or len(label) > 120 or boundary not in ("local", "private_lan"):
            raise StorageError("invalid_request")
        try:
            label.encode("utf-8")
        except UnicodeError:
            raise StorageError("invalid_request") from None
        prepared = self._documents(documents)
        with self.transaction() as db:
            old = db.execute("SELECT * FROM collections WHERE id=?", (collection_id,)).fetchone()
            if old is None:
                if expected_revision != 0:
                    raise StorageError("source_changed")
                if db.execute("SELECT count(*) FROM collections WHERE deleted=0").fetchone()[0] >= 32:
                    raise StorageError("invalid_request")
                db.execute("INSERT INTO collections(id,label,boundary,revision,updated_at) VALUES(?,?,?,0,?)",
                           (collection_id, label, boundary, now_ms()))
            elif old["revision"] != expected_revision or old["deleted"]:
                raise StorageError("source_changed")
            previous = {row["path"]: row for row in db.execute("SELECT * FROM collection_documents WHERE collection_id=?", (collection_id,))}
            changed = {path for path, item in prepared.items() if path not in previous or previous[path]["deleted"]
                       or previous[path]["content_hash"] != item["hash"] or previous[path]["title"] != item["title"]
                       or old is not None and old["boundary"] != boundary}
            removed = {path for path, row in previous.items() if not row["deleted"] and path not in prepared}
            existing = {row["source_id"]: row for row in db.execute("""SELECT ch.*,s.deleted,s.revision FROM collection_chunks ch
                JOIN sources s ON s.id=ch.source_id WHERE ch.collection_id=?""", (collection_id,))}
            affected = set()
            for source_id, row in existing.items():
                if row["path"] in changed or row["path"] in removed:
                    affected.update(self._descendants(db, source_id))
            if affected:
                self._invalidate(db, affected)
            for path in removed:
                db.execute("UPDATE collection_documents SET deleted=1 WHERE collection_id=? AND path=?", (collection_id, path))
            for path in changed:
                item = prepared[path]
                db.execute("""INSERT INTO collection_documents(collection_id,path,title,content_hash,chunk_count) VALUES(?,?,?,?,?)
                    ON CONFLICT(collection_id,path) DO UPDATE SET title=excluded.title,content_hash=excluded.content_hash,
                    chunk_count=excluded.chunk_count,deleted=0""", (collection_id, path, item["title"], item["hash"], len(item["chunks"])))
                for index, text in enumerate(item["chunks"]):
                    source_id = "managed-" + hashlib.sha256(encoded([collection_id, path, index]).encode("utf-8")).hexdigest()
                    before = existing.get(source_id)
                    if before is None:
                        db.execute("""INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at)
                            VALUES(?,1,'note',?,?,?,?)""", (source_id, boundary, item["title"], text, now_ms()))
                        db.execute("INSERT INTO collection_chunks(source_id,collection_id,path,chunk_index) VALUES(?,?,?,?)", (source_id, collection_id, path, index))
                    else:
                        # Previously active roots were already bumped by invalidation.
                        db.execute("""UPDATE sources SET deleted=0,revision=revision+?,boundary=?,title=?,text=?,updated_at=? WHERE id=?""",
                                   (int(bool(before["deleted"])), boundary, item["title"], text, now_ms(), source_id))
                    db.execute("DELETE FROM sources_fts WHERE source_id=?", (source_id,))
                    db.execute("INSERT INTO sources_fts(source_id,title,text) VALUES(?,?,?)", (source_id, item["title"], text))
            previously_blocked = {row[0] for row in db.execute("SELECT source_id FROM unavailable_sources")}
            db.execute("UPDATE collections SET label=?,boundary=?,revision=revision+1,available=1,updated_at=? WHERE id=?",
                       (label, boundary, now_ms(), collection_id))
            current_blocked = self._refresh_unavailable(db)
            affected.update(previously_blocked - current_blocked)
            return self._collection_dto(db, self._collection(db, collection_id)), affected

    def collection_unavailable(self, collection_id):
        with self.transaction() as db:
            self._collection(db, collection_id)
            db.execute("UPDATE collections SET available=0 WHERE id=?", (collection_id,))
            affected = {item[0] for item in db.execute("""SELECT ch.source_id FROM collection_chunks ch
                JOIN sources s ON s.id=ch.source_id WHERE ch.collection_id=? AND s.deleted=0""", (collection_id,))}
            self._impact(db, affected)
            self._refresh_unavailable(db)
            return self._collection_dto(db, self._collection(db, collection_id)), affected

    def delete_collection(self, collection_id, expected_revision):
        self._revision(expected_revision, minimum=1)
        with self.transaction() as db:
            row = self._collection(db, collection_id)
            if row["revision"] != expected_revision:
                raise StorageError("source_changed")
            affected = set()
            for item in db.execute("""SELECT ch.source_id FROM collection_chunks ch JOIN sources s ON s.id=ch.source_id
                WHERE ch.collection_id=? AND s.deleted=0""", (collection_id,)):
                affected.update(self._descendants(db, item[0]))
            self._invalidate(db, affected)
            db.execute("UPDATE collections SET deleted=1,available=0,revision=revision+1,updated_at=? WHERE id=?", (now_ms(), collection_id))
            db.execute("UPDATE collection_documents SET deleted=1 WHERE collection_id=?", (collection_id,))
            self._refresh_unavailable(db)
            return affected

    def _screen(self, db, capture_id):
        self._collection_id(capture_id)
        row = db.execute("SELECT * FROM screen_captures WHERE capture_id=?", (capture_id,)).fetchone()
        if row is None:
            raise StorageError("not_found")
        source = self._source(db, row["source_id"], include_deleted=True)
        analysis = self._source(db, row["analysis_source_id"], include_deleted=True) if row["analysis_source_id"] else None
        if analysis is not None and analysis["record"]["deleted"]:
            analysis = None
        return {"capture_id": capture_id, "source": source, "captured_at": row["captured_at"],
                "analysis_source_id": analysis["record"]["source_id"] if analysis else None,
                "actual_model": json.loads(row["actual_model"]) if analysis and row["actual_model"] else None,
                **({"routing_reason":row["routing_reason"]} if analysis and row["routing_reason"] is not None else {})}

    def get_screen(self, capture_id):
        with self.transaction() as db:
            return self._screen(db, capture_id)

    def list_screens(self):
        with self.transaction() as db:
            return [self._screen(db, row[0]) for row in db.execute("""SELECT c.capture_id FROM screen_captures c
                JOIN sources s ON s.id=c.source_id WHERE s.deleted=0 ORDER BY s.updated_at DESC,c.capture_id""")]

    def put_screen(self, capture_id, expected_revision, title, boundary, captured_at):
        self._collection_id(capture_id)
        self._revision(expected_revision)
        if not isinstance(title, str) or not title.strip() or len(title) > 120 or boundary not in ("local", "private_lan"):
            raise StorageError("invalid_request")
        try:
            title.encode("utf-8")
        except UnicodeError:
            raise StorageError("invalid_request") from None
        if type(captured_at) is not int or not 0 <= captured_at <= 9007199254740991:
            raise StorageError("invalid_request")
        source_id = "screen-" + hashlib.sha256(capture_id.encode("ascii")).hexdigest()
        with self.transaction() as db:
            row = db.execute("SELECT source_id FROM screen_captures WHERE capture_id=?", (capture_id,)).fetchone()
            affected = set()
            if row:
                old = self._source(db, row["source_id"], include_deleted=True)
                if old["record"]["deleted"] or old["record"]["revision"] != expected_revision:
                    raise StorageError("source_changed")
                if expected_revision >= 9007199254740990:
                    raise StorageError("source_changed")
                affected = self._descendants(db, source_id)
                self._invalidate(db, affected, preserve=source_id)
                db.execute("UPDATE sources SET revision=revision+1,title=?,boundary=?,updated_at=? WHERE id=?",
                           (title, boundary, now_ms(), source_id))
                db.execute("""UPDATE screen_captures SET captured_at=?,analysis_source_id=NULL,actual_model=NULL,prompt_hash=NULL,routing_reason=NULL
                    WHERE capture_id=?""", (captured_at, capture_id))
            else:
                if expected_revision != 0:
                    raise StorageError("source_changed")
                count = db.execute("""SELECT count(*) FROM screen_captures c JOIN sources s ON s.id=c.source_id
                    WHERE s.deleted=0""").fetchone()[0]
                if count >= 32:
                    raise StorageError("screen_limit")
                db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'screen',?,?,'',?)",
                           (source_id, boundary, title, now_ms()))
                db.execute("INSERT INTO screen_captures(capture_id,source_id,captured_at) VALUES(?,?,?)", (capture_id, source_id, captured_at))
            return self._source(db, source_id), affected

    def completed_screen(self, capture_id, revision, model, prompt_hash):
        with self.transaction() as db:
            screen = self._screen(db, capture_id)
            if screen["source"]["record"]["deleted"] or screen["source"]["record"]["revision"] != revision:
                raise StorageError("source_changed")
            row = db.execute("SELECT * FROM screen_captures WHERE capture_id=?", (capture_id,)).fetchone()
            if row["analysis_source_id"] is None:
                return None
            if screen["analysis_source_id"] is None or row["actual_model"] != encoded(model) or row["prompt_hash"] != prompt_hash:
                raise StorageError("source_changed")
            return {"source": self._source(db, row["analysis_source_id"]), "screen_source": screen["source"], "actual_model": model,
                    **({"routing_reason":row["routing_reason"]} if row["routing_reason"] is not None else {})}

    def complete_screen(self, capture_id, revision, text, model, prompt_hash, routing_reason=None):
        assert_definition("ModelRef", model)
        if routing_reason is not None:
            assert_definition("RoutingReason", routing_reason)
        with self.transaction() as db:
            screen = self._screen(db, capture_id)
            record = screen["source"]["record"]
            if record["deleted"] or record["revision"] != revision:
                raise StorageError("source_changed")
            row = db.execute("SELECT analysis_source_id FROM screen_captures WHERE capture_id=?", (capture_id,)).fetchone()
            if row[0] is not None:
                raise StorageError("source_changed")
            self._validate_source_fields(screen["source"]["title"], text, record["boundary"])
            source_id = "screen-analysis-" + uuid.uuid4().hex
            title = screen["source"]["title"]
            db.execute("INSERT INTO sources(id,revision,kind,boundary,title,text,updated_at) VALUES(?,1,'memory',?,?,'',?)",
                       (source_id, record["boundary"], title, now_ms()))
            db.execute("INSERT INTO derived_memories(source_id,content) VALUES(?,?)", (source_id, text))
            db.execute("INSERT INTO source_parents(child,parent,revision) VALUES(?,?,?)", (source_id, record["source_id"], revision))
            db.execute("INSERT INTO sources_fts(source_id,title,text) VALUES(?,?,?)", (source_id, title, text))
            db.execute("UPDATE screen_captures SET analysis_source_id=?,actual_model=?,prompt_hash=?,routing_reason=? WHERE capture_id=?",
                       (source_id, encoded(model), prompt_hash, routing_reason, capture_id))
            return {"source": self._source(db, source_id), "screen_source": screen["source"], "actual_model": model,
                    **({"routing_reason":routing_reason} if routing_reason is not None else {})}

    def delete_screen(self, capture_id, revision):
        self._collection_id(capture_id)
        self._revision(revision, minimum=1)
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM screen_captures WHERE capture_id=?", (capture_id,)).fetchone() is None:
                if revision != 1:
                    raise StorageError("source_changed")
                # The cancellation may beat an in-flight upload. Persist the fence first.
                source_id = "screen-" + hashlib.sha256(capture_id.encode("ascii")).hexdigest()
                db.execute("INSERT INTO sources(id,revision,kind,boundary,deleted,title,text,updated_at) VALUES(?,2,'screen','local',1,'','',?)",
                           (source_id, now_ms()))
                db.execute("INSERT INTO screen_captures(capture_id,source_id,captured_at) VALUES(?,?,0)", (capture_id, source_id))
                return set()
            screen = self._screen(db, capture_id)
            record = screen["source"]["record"]
            if record["deleted"] and record["revision"] == revision + 1:
                return set()  # Retry of the exact committed deletion.
            if record["deleted"] or record["revision"] != revision:
                raise StorageError("source_changed")
            affected = self._descendants(db, record["source_id"])
            self._invalidate(db, affected)
            db.execute("UPDATE screen_captures SET analysis_source_id=NULL,actual_model=NULL,prompt_hash=NULL WHERE capture_id=?", (capture_id,))
            self._refresh_unavailable(db)
            return affected
