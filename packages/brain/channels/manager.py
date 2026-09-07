"""Phase 6-A: ChannelManager — session_key 기반 Orchestrator 풀 관리."""

from core.orchestrator import Orchestrator


class ChannelManager:
    """session_key → Orchestrator 매핑을 관리하는 싱글턴 매니저.

    - 같은 session_key로 재연결 시 기존 Orchestrator(단기 메모리 포함)를 재사용.
    - 채널별 session_key 규칙: "{channel}:{identifier}" (예: "live2d:conn_abc")
    - in-memory 저장 — 서버 재시작 시 세션 초기화.
    - Phase 7: store 주입 시 새 Orchestrator에 _store 자동 설정.
    - Phase 6(완료): long_term 주입 시 모든 채널이 동일한 LongTermMemory 공유.
    """

    def __init__(self, store=None, long_term=None) -> None:
        self._sessions: dict[str, Orchestrator] = {}
        self._session_leases: dict[str, int] = {}
        self._store = store        # Phase 7: MemoryStore (None이면 quality_score 저장 안 함)
        self._long_term = long_term  # Phase 6: LongTermMemory 채널 간 공유

    def get_or_create(self, session_key: str) -> Orchestrator:
        """session_key에 해당하는 Orchestrator를 반환한다. 없으면 새로 생성한다."""
        if session_key not in self._sessions:
            orc = Orchestrator()
            if self._store is not None:
                orc._store = self._store
            if self._long_term is not None:
                orc._long_term = self._long_term
            self._sessions[session_key] = orc
        return self._sessions[session_key]

    def remove(self, session_key: str) -> None:
        """세션을 제거한다. 존재하지 않는 키는 무시한다."""
        self._sessions.pop(session_key, None)
        self._session_leases.pop(session_key, None)

    def acquire_session(self, session_key: str) -> Orchestrator:
        """연결 하나가 사용할 세션을 얻고 활성 lease를 하나 추가한다."""
        orchestrator = self.get_or_create(session_key)
        self._session_leases[session_key] = (
            self._session_leases.get(session_key, 0) + 1
        )
        return orchestrator

    def release_session(self, session_key: str) -> None:
        """연결 lease를 반납하고 마지막 연결일 때만 세션을 제거한다."""
        lease_count = self._session_leases.get(session_key, 0)
        if lease_count == 0:
            return
        if lease_count > 1:
            self._session_leases[session_key] = lease_count - 1
            return
        self.remove(session_key)

    def active_sessions(self) -> list[str]:
        """현재 활성 session_key 목록을 반환한다."""
        return list(self._sessions.keys())
