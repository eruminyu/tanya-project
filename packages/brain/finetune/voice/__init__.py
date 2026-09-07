"""Fish Speech용 음성 자산 준비 도구.

- prepare.py — 기존 음성의 분할, 정규화, `.lab` 대본 템플릿 생성

Fish Speech 학습과 reference voice 등록은 버전을 고정한 뒤 별도 adapter로
구현한다. 기존 GPT-SoVITS 체크포인트와 전용 실행 코드는 사용하지 않는다.
"""
