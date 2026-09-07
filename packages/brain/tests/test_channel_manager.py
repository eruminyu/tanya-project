"""Phase 6-A: ChannelManager 단위 테스트."""

import pytest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# ChannelManager 기본 동작
# ---------------------------------------------------------------------------

class TestChannelManagerBasic:
    """ChannelManager 세션 관리 기본 동작."""

    def test_import(self):
        from channels.manager import ChannelManager
        assert ChannelManager is not None

    def test_instantiate(self):
        from channels.manager import ChannelManager
        manager = ChannelManager()
        assert manager is not None

    def test_get_or_create_returns_orchestrator(self):
        """처음 get_or_create 호출 시 Orchestrator를 생성해서 반환한다."""
        from channels.manager import ChannelManager
        with patch("channels.manager.Orchestrator") as MockOrch:
            MockOrch.return_value = MagicMock()
            manager = ChannelManager()
            orch = manager.get_or_create("tauri:session_001")
            assert orch is not None

    def test_get_or_create_reuses_same_session(self):
        """같은 session_key로 두 번 호출하면 동일 Orchestrator를 반환한다."""
        from channels.manager import ChannelManager
        with patch("channels.manager.Orchestrator") as MockOrch:
            mock_orch = MagicMock()
            MockOrch.return_value = mock_orch
            manager = ChannelManager()
            orch1 = manager.get_or_create("tauri:session_001")
            orch2 = manager.get_or_create("tauri:session_001")
            assert orch1 is orch2
            assert MockOrch.call_count == 1  # 한 번만 생성

    def test_different_sessions_get_different_orchestrators(self):
        """다른 session_key는 각각 다른 Orchestrator를 받는다."""
        from channels.manager import ChannelManager
        call_count = 0

        def make_mock():
            nonlocal call_count
            call_count += 1
            m = MagicMock()
            m._id = call_count
            return m

        with patch("channels.manager.Orchestrator", side_effect=make_mock):
            manager = ChannelManager()
            orch1 = manager.get_or_create("tauri:session_001")
            orch2 = manager.get_or_create("webchat:session_002")
            assert orch1 is not orch2

    def test_remove_session(self):
        """remove() 후 get_or_create 호출 시 새 Orchestrator를 생성한다."""
        from channels.manager import ChannelManager
        instances = []

        def make_mock():
            m = MagicMock()
            instances.append(m)
            return m

        with patch("channels.manager.Orchestrator", side_effect=make_mock):
            manager = ChannelManager()
            orch1 = manager.get_or_create("tauri:session_001")
            manager.remove("tauri:session_001")
            orch2 = manager.get_or_create("tauri:session_001")
            assert orch1 is not orch2
            assert len(instances) == 2

    def test_remove_nonexistent_session_is_safe(self):
        """존재하지 않는 session_key를 remove해도 예외가 발생하지 않는다."""
        from channels.manager import ChannelManager
        manager = ChannelManager()
        manager.remove("nonexistent:session")  # 예외 없어야 함

    def test_overlapping_connection_leases_keep_mapping_until_last_release(self):
        """같은 stable key의 이전 연결 종료가 새 연결 세션을 제거하지 않는다."""
        from channels.manager import ChannelManager

        with patch("channels.manager.Orchestrator") as MockOrch:
            orchestrator = MagicMock()
            MockOrch.return_value = orchestrator
            manager = ChannelManager()

            first = manager.acquire_session("webchat:stable-session-id")
            second = manager.acquire_session("webchat:stable-session-id")
            manager.release_session("webchat:stable-session-id")

            assert first is orchestrator
            assert second is orchestrator
            assert manager.active_sessions() == ["webchat:stable-session-id"]
            manager.release_session("webchat:stable-session-id")
            assert manager.active_sessions() == []

    def test_remove_keeps_immediate_removal_semantics_with_an_active_lease(self):
        from channels.manager import ChannelManager

        with patch("channels.manager.Orchestrator"):
            manager = ChannelManager()
            manager.acquire_session("webchat:stable-session-id")

            manager.remove("webchat:stable-session-id")
            manager.release_session("webchat:stable-session-id")

            assert manager.active_sessions() == []

    def test_active_sessions_empty_initially(self):
        """초기 상태에서 active_sessions는 빈 리스트다."""
        from channels.manager import ChannelManager
        manager = ChannelManager()
        assert manager.active_sessions() == []

    def test_active_sessions_reflects_created(self):
        """get_or_create 후 active_sessions에 해당 키가 포함된다."""
        from channels.manager import ChannelManager
        with patch("channels.manager.Orchestrator"):
            manager = ChannelManager()
            manager.get_or_create("tauri:session_001")
            manager.get_or_create("webchat:session_002")
            sessions = manager.active_sessions()
            assert "tauri:session_001" in sessions
            assert "webchat:session_002" in sessions

    def test_active_sessions_after_remove(self):
        """remove 후 active_sessions에서 해당 키가 사라진다."""
        from channels.manager import ChannelManager
        with patch("channels.manager.Orchestrator"):
            manager = ChannelManager()
            manager.get_or_create("tauri:session_001")
            manager.remove("tauri:session_001")
            assert "tauri:session_001" not in manager.active_sessions()

    def test_session_count(self):
        """활성 세션 수가 정확하다."""
        from channels.manager import ChannelManager
        with patch("channels.manager.Orchestrator"):
            manager = ChannelManager()
            manager.get_or_create("tauri:a")
            manager.get_or_create("tauri:b")
            manager.get_or_create("webchat:c")
            assert len(manager.active_sessions()) == 3


# ---------------------------------------------------------------------------
# Channel ABC
# ---------------------------------------------------------------------------

class TestChannelBase:
    """Channel ABC 인터페이스 검증."""

    def test_import(self):
        from channels.base import Channel
        assert Channel is not None

    def test_channel_is_abstract(self):
        """Channel은 추상 클래스여서 직접 인스턴스화할 수 없다."""
        from channels.base import Channel
        with pytest.raises(TypeError):
            Channel()  # type: ignore

    def test_channel_has_handle_method(self):
        """Channel ABC에 handle 추상 메서드가 있다."""
        from channels.base import Channel
        assert hasattr(Channel, "handle")


# ---------------------------------------------------------------------------
# WebChatChannel 존재 확인
# ---------------------------------------------------------------------------

class TestChannelImports:
    def test_webchat_channel_importable(self):
        from channels.webchat import WebChatChannel
        assert WebChatChannel is not None

    def test_webchat_channel_is_channel(self):
        from channels.base import Channel
        from channels.webchat import WebChatChannel
        assert issubclass(WebChatChannel, Channel)


# ---------------------------------------------------------------------------
# 장기 기억 채널 간 공유
# ---------------------------------------------------------------------------

class TestChannelManagerLongTermMemory:
    """ChannelManager long_term 주입 — 채널 간 LongTermMemory 공유."""

    def test_long_term_injected_into_new_orchestrator(self):
        """long_term 주입 시 새 Orchestrator에 _long_term이 설정된다."""
        from channels.manager import ChannelManager

        mock_long_term = object()

        with patch("channels.manager.Orchestrator") as MockOrch:
            mock_orch = MagicMock()
            MockOrch.return_value = mock_orch

            manager = ChannelManager(long_term=mock_long_term)
            manager.get_or_create("live2d:session_001")

            assert mock_orch._long_term is mock_long_term

    def test_long_term_none_by_default(self):
        """long_term 미주입 시 Orchestrator._long_term이 None으로 유지된다."""
        from channels.manager import ChannelManager

        with patch("channels.manager.Orchestrator") as MockOrch:
            mock_orch = MagicMock()
            MockOrch.return_value = mock_orch

            manager = ChannelManager()
            manager.get_or_create("live2d:session_001")

            # _long_term 속성에 명시적으로 None을 쓰지 않아야 함
            # (이미 Orchestrator가 None으로 초기화하므로 set 안 함)
            assert "_long_term" not in mock_orch.__dict__ or mock_orch._long_term is None

    def test_long_term_shared_across_sessions(self):
        """서로 다른 세션의 Orchestrator가 동일한 LongTermMemory 인스턴스를 공유한다."""
        from channels.manager import ChannelManager

        mock_long_term = object()
        injected = []

        def make_mock():
            m = MagicMock()
            injected.append(m)
            return m

        with patch("channels.manager.Orchestrator", side_effect=make_mock):
            manager = ChannelManager(long_term=mock_long_term)
            manager.get_or_create("live2d:a")
            manager.get_or_create("webchat:b")

        assert len(injected) == 2
        assert injected[0]._long_term is mock_long_term
        assert injected[1]._long_term is mock_long_term

    def test_store_and_long_term_both_injected(self):
        """store와 long_term 모두 주입 시 둘 다 설정된다."""
        from channels.manager import ChannelManager

        mock_store = object()
        mock_long_term = object()

        with patch("channels.manager.Orchestrator") as MockOrch:
            mock_orch = MagicMock()
            MockOrch.return_value = mock_orch

            manager = ChannelManager(store=mock_store, long_term=mock_long_term)
            manager.get_or_create("live2d:session_001")

            assert mock_orch._store is mock_store
            assert mock_orch._long_term is mock_long_term

    def test_reused_session_long_term_not_overwritten(self):
        """세션 재사용 시 long_term을 다시 주입하지 않는다 (기존 Orchestrator 유지)."""
        from channels.manager import ChannelManager

        mock_long_term = object()
        call_count = [0]

        with patch("channels.manager.Orchestrator") as MockOrch:
            mock_orch = MagicMock()
            MockOrch.return_value = mock_orch

            manager = ChannelManager(long_term=mock_long_term)
            manager.get_or_create("live2d:session_001")
            manager.get_or_create("live2d:session_001")  # 재사용

            # Orchestrator는 한 번만 생성
            assert MockOrch.call_count == 1
