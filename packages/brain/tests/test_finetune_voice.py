"""Fish Speech 음성 자산 전처리 테스트."""

from pathlib import Path

from finetune.voice.prepare import VoicePreparer


class TestVoicePreparer:
    def test_generate_transcript_template_lists_wav_files(self, tmp_path):
        (tmp_path / "b.wav").write_bytes(b"")
        (tmp_path / "a.wav").write_bytes(b"")
        (tmp_path / "ignore.txt").write_text("x", encoding="utf-8")

        csv_path = VoicePreparer().generate_transcript_template(str(tmp_path))

        content = Path(csv_path).read_text(encoding="utf-8")
        assert content.splitlines() == ["filename,text", "a.wav,", "b.wav,"]

    def test_generate_lab_templates_for_supported_audio(self, tmp_path):
        for name in ("a.wav", "b.mp3", "c.flac"):
            (tmp_path / name).write_bytes(b"")
        (tmp_path / "ignore.txt").write_text("x", encoding="utf-8")

        paths = VoicePreparer().generate_lab_templates(str(tmp_path))

        assert {Path(path).name for path in paths} == {"a.lab", "b.lab", "c.lab"}
        assert all(Path(path).read_text(encoding="utf-8") == "" for path in paths)

    def test_existing_lab_transcript_is_not_overwritten(self, tmp_path):
        (tmp_path / "sample.wav").write_bytes(b"")
        lab_path = tmp_path / "sample.lab"
        lab_path.write_text("기존 대본", encoding="utf-8")

        VoicePreparer().generate_lab_templates(str(tmp_path))

        assert lab_path.read_text(encoding="utf-8") == "기존 대본"
