"""Phase 3.0: SQLite 기반 영속 저장소.

WAL 모드 + sqlite-vec 벡터 가상 테이블 + FTS5 전문 검색.
Phase 7 파인튜닝 대비로 conversations 테이블에 quality_score,
is_finetune_candidate 컬럼을 초기부터 포함.
"""
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

import sqlite_vec


class MemoryStore:
    def __init__(
        self, db_path: str = "tanya_memory.db", *, enable_capsule_tables: bool = False
    ):
        self._db_path = db_path
        self._capsule_enabled = enable_capsule_tables
        self._capsule_lock = threading.RLock()
        self._conn = self._connect()
        self._ensure_tables()

    # ------------------------------------------------------------------
    # 연결 관리
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def close(self) -> None:
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ------------------------------------------------------------------
    # 테이블 초기화
    # ------------------------------------------------------------------

    def _ensure_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key          TEXT    NOT NULL,
                user_msg             TEXT    NOT NULL,
                assistant_msg        TEXT    NOT NULL,
                emotion_type         TEXT,
                emotion_intensity    REAL,
                token_count          INTEGER,
                quality_score        REAL,
                is_finetune_candidate INTEGER NOT NULL DEFAULT 0,
                created_at           TEXT    NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_conv_session
                ON conversations(session_key);

            CREATE TABLE IF NOT EXISTS memories (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                content         TEXT    NOT NULL,
                category        TEXT    NOT NULL DEFAULT 'episodic',
                source_turn_ids TEXT,
                created_at      TEXT    NOT NULL,
                last_accessed   TEXT    NOT NULL,
                access_count    INTEGER NOT NULL DEFAULT 0,
                importance      REAL    NOT NULL DEFAULT 0.5
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
                USING fts5(content, content=memories, content_rowid=id);

            CREATE TABLE IF NOT EXISTS user_profile (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

        """)

        # sqlite-vec 가상 테이블은 executescript 안에서 CREATE VIRTUAL TABLE이
        # 지원되지 않을 수 있으므로 별도 실행
        self._conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
                USING vec0(embedding FLOAT[384])
        """)
        if self._capsule_enabled:
            self._ensure_capsule_tables()
        self._conn.commit()

    def _ensure_capsule_tables(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS memory_capsules (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                couchdb_doc_id      TEXT    NOT NULL UNIQUE,
                session_key_hash    TEXT    NOT NULL UNIQUE,
                preparation_minutes INTEGER NOT NULL
                    CHECK (preparation_minutes IN (10, 20, 30)),
                content             TEXT    NOT NULL,
                source_metadata     TEXT    NOT NULL,
                generation          TEXT    NOT NULL,
                couchdb_rev         TEXT    NOT NULL,
                created_at_epoch    REAL    NOT NULL,
                synced_at_epoch     REAL    NOT NULL,
                expires_at_epoch    REAL    NOT NULL,
                CHECK (created_at_epoch <= synced_at_epoch),
                CHECK (synced_at_epoch <= expires_at_epoch)
            );

            CREATE INDEX IF NOT EXISTS idx_capsule_session_expiry
                ON memory_capsules(session_key_hash, expires_at_epoch);

            CREATE INDEX IF NOT EXISTS idx_capsule_expiry
                ON memory_capsules(expires_at_epoch);

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_capsules_fts
                USING fts5(content, content=memory_capsules, content_rowid=id);

            CREATE TABLE IF NOT EXISTS memory_capsule_sync_state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        self._conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_capsules_vec
                USING vec0(embedding FLOAT[384])
        """)

    # ------------------------------------------------------------------
    # 유틸리티
    # ------------------------------------------------------------------

    def get_table_names(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow')"
        ).fetchall()
        # FTS5 shadow 테이블도 포함되므로 원본 이름만 추출
        names = [r["name"] for r in rows]
        # memories_fts는 FTS5 가상 테이블이므로 직접 확인
        fts_check = self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
        ).fetchone()
        if fts_check and "memories_fts" not in names:
            names.append("memories_fts")
        return names

    def execute_scalar(self, sql: str, params: tuple = ()) -> Any:
        row = self._conn.execute(sql, params).fetchone()
        if row is None:
            return None
        return row[0]

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # Conversations
    # ------------------------------------------------------------------

    def save_conversation(
        self,
        session_key: str,
        user_msg: str,
        assistant_msg: str,
        emotion_type: str | None = None,
        emotion_intensity: float | None = None,
        token_count: int | None = None,
    ) -> int:
        cur = self._conn.execute(
            """
            INSERT INTO conversations
                (session_key, user_msg, assistant_msg, emotion_type,
                 emotion_intensity, token_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_key, user_msg, assistant_msg, emotion_type,
             emotion_intensity, token_count, self._now()),
        )
        self._conn.commit()
        return cur.lastrowid

    def get_conversations(
        self, session_key: str, limit: int = 50
    ) -> list[dict]:
        rows = self._conn.execute(
            """
            SELECT * FROM conversations
            WHERE session_key = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (session_key, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def count_conversations(self, session_key: str) -> int:
        return self.execute_scalar(
            "SELECT COUNT(*) FROM conversations WHERE session_key = ?",
            (session_key,),
        )

    def update_quality_score(self, conv_id: int, score: float) -> None:
        self._conn.execute(
            "UPDATE conversations SET quality_score = ? WHERE id = ?",
            (score, conv_id),
        )
        self._conn.commit()

    def update_finetune_candidate(self, conv_ids: list[int], value: int = 1) -> int:
        """is_finetune_candidate 값을 일괄 업데이트한다.

        Args:
            conv_ids: 업데이트할 대화 ID 목록
            value: 1(후보 등록) 또는 0(후보 해제)

        Returns:
            변경된 행 수
        """
        if not conv_ids:
            return 0
        placeholders = ",".join("?" * len(conv_ids))
        cur = self._conn.execute(
            f"UPDATE conversations SET is_finetune_candidate = ? WHERE id IN ({placeholders})",
            [value, *conv_ids],
        )
        self._conn.commit()
        return cur.rowcount

    # ------------------------------------------------------------------
    # Memories
    # ------------------------------------------------------------------

    def save_memory(
        self,
        content: str,
        category: str = "episodic",
        importance: float = 0.5,
        source_turn_ids: str | None = None,
    ) -> int:
        now = self._now()
        cur = self._conn.execute(
            """
            INSERT INTO memories
                (content, category, source_turn_ids, created_at,
                 last_accessed, importance)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (content, category, source_turn_ids, now, now, importance),
        )
        mem_id = cur.lastrowid

        # FTS5 인덱스 동기화
        self._conn.execute(
            "INSERT INTO memories_fts(rowid, content) VALUES (?, ?)",
            (mem_id, content),
        )
        self._conn.commit()
        return mem_id

    def get_memory(self, mem_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM memories WHERE id = ?", (mem_id,)
        ).fetchone()
        return dict(row) if row else None

    def update_memory_access(self, mem_id: int) -> None:
        self._conn.execute(
            """
            UPDATE memories
            SET last_accessed = ?, access_count = access_count + 1
            WHERE id = ?
            """,
            (self._now(), mem_id),
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # 공개 체험용 기억 캡슐
    # ------------------------------------------------------------------

    def replace_memory_capsule(
        self,
        *,
        couchdb_doc_id: str,
        session_key_hash: str,
        preparation_minutes: int,
        content: str,
        source_metadata: str,
        generation: str,
        couchdb_rev: str,
        created_at_epoch: float,
        synced_at_epoch: float,
        expires_at_epoch: float,
        embedding: bytes,
    ) -> int:
        """한 세션의 캡슐과 FTS/vector 인덱스를 한 트랜잭션으로 교체한다."""
        if preparation_minutes not in {10, 20, 30}:
            raise ValueError("preparation_minutes must be one of 10, 20, 30")

        with self._capsule_lock, self._conn:
            old_rows = self._conn.execute(
                "SELECT id FROM memory_capsules WHERE session_key_hash = ?",
                (session_key_hash,),
            ).fetchall()
            for row in old_rows:
                self._conn.execute(
                    "DELETE FROM memory_capsules_fts WHERE rowid = ?", (row["id"],)
                )
                self._conn.execute(
                    "DELETE FROM memory_capsules_vec WHERE rowid = ?", (row["id"],)
                )
            self._conn.execute(
                "DELETE FROM memory_capsules WHERE session_key_hash = ?",
                (session_key_hash,),
            )

            cur = self._conn.execute(
                """
                INSERT INTO memory_capsules
                    (couchdb_doc_id, session_key_hash, preparation_minutes,
                     content, source_metadata, generation, couchdb_rev,
                     created_at_epoch, synced_at_epoch, expires_at_epoch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    couchdb_doc_id,
                    session_key_hash,
                    preparation_minutes,
                    content,
                    source_metadata,
                    generation,
                    couchdb_rev,
                    created_at_epoch,
                    synced_at_epoch,
                    expires_at_epoch,
                ),
            )
            memory_id = cur.lastrowid
            self._conn.execute(
                "INSERT INTO memory_capsules_fts(rowid, content) VALUES (?, ?)",
                (memory_id, content),
            )
            self._conn.execute(
                "INSERT INTO memory_capsules_vec(rowid, embedding) VALUES (?, ?)",
                (memory_id, embedding),
            )
        return memory_id

    def get_memory_capsule(self, session_key_hash: str) -> dict | None:
        with self._capsule_lock:
            row = self._conn.execute(
                "SELECT * FROM memory_capsules WHERE session_key_hash = ?",
                (session_key_hash,),
            ).fetchone()
        return dict(row) if row else None

    def get_memory_capsule_by_doc_id(self, couchdb_doc_id: str) -> dict | None:
        with self._capsule_lock:
            row = self._conn.execute(
                "SELECT * FROM memory_capsules WHERE couchdb_doc_id = ?",
                (couchdb_doc_id,),
            ).fetchone()
        return dict(row) if row else None

    def capsule_vector_distance(self, memory_id: int, query_embedding: bytes) -> float:
        """세션 소유권을 먼저 확인한 단일 row의 cosine 거리를 반환한다."""
        with self._capsule_lock:
            row = self._conn.execute(
                """
                SELECT vec_distance_cosine(embedding, ?) AS distance
                FROM memory_capsules_vec
                WHERE rowid = ?
                """,
                (query_embedding, memory_id),
            ).fetchone()
        if row is None:
            raise LookupError("memory capsule vector is missing")
        return float(row["distance"])

    def search_memory_capsule(
        self,
        *,
        session_key_hash: str,
        now_epoch: float,
        query_embedding: bytes,
        fts_query: str,
    ) -> dict | None:
        """소유자와 만료 조건을 후보 단계에서 강제한 hybrid 검색."""
        with self._capsule_lock:
            row = self._conn.execute(
                """
                SELECT c.*,
                       vec_distance_cosine(v.embedding, ?) AS vector_distance
                FROM memory_capsules AS c
                JOIN memory_capsules_vec AS v ON v.rowid = c.id
                WHERE c.session_key_hash = ? AND c.expires_at_epoch > ?
                ORDER BY vector_distance ASC
                LIMIT 1
                """,
                (query_embedding, session_key_hash, now_epoch),
            ).fetchone()
            if row is None:
                return None
            result = dict(row)
            fts = self._conn.execute(
                """
                SELECT bm25(memory_capsules_fts) AS score
                FROM memory_capsules_fts
                JOIN memory_capsules AS c
                    ON c.id = memory_capsules_fts.rowid
                WHERE memory_capsules_fts MATCH ?
                  AND c.session_key_hash = ?
                  AND c.expires_at_epoch > ?
                LIMIT 1
                """,
                (fts_query, session_key_hash, now_epoch),
            ).fetchone()
        result["fts_score"] = float(fts["score"]) if fts else None
        return result

    def list_expired_memory_capsules(
        self, now_epoch: float, limit: int = 100
    ) -> list[dict]:
        with self._capsule_lock:
            rows = self._conn.execute(
                """
                SELECT * FROM memory_capsules
                WHERE expires_at_epoch <= ?
                ORDER BY expires_at_epoch ASC
                LIMIT ?
                """,
                (now_epoch, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_memory_capsule(
        self,
        session_key_hash: str,
        *,
        memory_id: int | None = None,
    ) -> int | None:
        """소유 세션의 캡슐만 원본/FTS/vector에서 원자적으로 제거한다."""
        with self._capsule_lock, self._conn:
            params: list[Any] = [session_key_hash]
            where = "session_key_hash = ?"
            if memory_id is not None:
                where += " AND id = ?"
                params.append(memory_id)
            row = self._conn.execute(
                f"SELECT id FROM memory_capsules WHERE {where}", tuple(params)
            ).fetchone()
            if row is None:
                return None
            owned_id = int(row["id"])
            self._conn.execute(
                "DELETE FROM memory_capsules_fts WHERE rowid = ?", (owned_id,)
            )
            self._conn.execute(
                "DELETE FROM memory_capsules_vec WHERE rowid = ?", (owned_id,)
            )
            self._conn.execute(
                "DELETE FROM memory_capsules WHERE id = ?", (owned_id,)
            )
        return owned_id

    def delete_memory_capsule_by_doc_id(
        self, couchdb_doc_id: str, *, generation: str | None = None
    ) -> int | None:
        """CouchDB changes 삭제 이벤트를 로컬 세 인덱스에 반영한다."""
        capsule = self.get_memory_capsule_by_doc_id(couchdb_doc_id)
        if capsule is None:
            return None
        if generation is not None and capsule["generation"] != generation:
            return None
        return self.delete_memory_capsule(
            capsule["session_key_hash"], memory_id=int(capsule["id"])
        )

    def get_memory_capsule_checkpoint(self) -> Any:
        with self._capsule_lock:
            row = self._conn.execute(
                "SELECT value FROM memory_capsule_sync_state WHERE key = 'changes_since'"
            ).fetchone()
        if row is None:
            return 0
        import json

        return json.loads(row["value"])

    def set_memory_capsule_checkpoint(self, sequence: Any) -> None:
        import json

        encoded = json.dumps(sequence, ensure_ascii=True, separators=(",", ":"))
        with self._capsule_lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO memory_capsule_sync_state(key, value)
                VALUES ('changes_since', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (encoded,),
            )

    # ------------------------------------------------------------------
    # User Profile
    # ------------------------------------------------------------------

    def set_profile(self, key: str, value: str) -> None:
        self._conn.execute(
            """
            INSERT INTO user_profile (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                           updated_at = excluded.updated_at
            """,
            (key, value, self._now()),
        )
        self._conn.commit()

    def get_profile(self, key: str) -> str | None:
        row = self._conn.execute(
            "SELECT value FROM user_profile WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else None

    def get_all_profile(self) -> dict[str, str]:
        rows = self._conn.execute("SELECT key, value FROM user_profile").fetchall()
        return {r["key"]: r["value"] for r in rows}


class MemoryCapsuleIndexStore(MemoryStore):
    """공개 캡슐 전용 SQLite 파일/connection을 명시적으로 여는 저장소."""

    def __init__(self, db_path: str = "tanya_public_memory_capsules.db") -> None:
        super().__init__(db_path, enable_capsule_tables=True)
