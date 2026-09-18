# Third-party notices and source attribution

이 파일은 Kirian에 확인된 외부 구성물과 보존된 고지를 안내한다. 프로젝트 전체에 새 라이선스를 부여하지 않으며, 모든 전이 dependency와 에셋의 재배포 조건을 검사한 SBOM/릴리스 승인 문서도 아니다.

참고만 한 프로젝트와 실제 소스 편입은 [참고·재사용 원장](archive/pre-rearchitecture-2026-09-08/docs/reference-projects.md)에서 구분한다. 과거 출처 확인 범위는 [감사 보고서](archive/pre-rearchitecture-2026-09-08/docs/research/reference-audit-2026-09-07.md)에 기록한다.

## Project AIRI — desktop runtime reuse

- Project: [moeru-ai/airi](https://github.com/moeru-ai/airi), upstream revision `9a4e1da5a17c98af1bc7e1bebed2c4ab5022e1af`.
- Copyright (c) 2024-PRESENT Neko Ayaka. MIT; [complete preserved license](packages/desktop/src/vendor/airi-audio/LICENSE).
- Runtime copies: [playback-manager.ts](packages/desktop/src/vendor/airi-audio/playback-manager.ts), [types.ts](packages/desktop/src/vendor/airi-audio/types.ts). Imports are local; the external error-string helper is replaced with a small local helper.
- Adapted runtime: [tts-chunker.ts](packages/desktop/src/vendor/airi-audio/tts-chunker.ts), from AIRI's punctuation/word segmentation and initial latency boost. Kirian adds lossless streamed grapheme handling, bounded chunks and numeric boundary preservation. The Electron client owns segmentation and ordered actual playback; Python performs individual synthesis jobs.
- Exact upstream file paths, hashes and changes: [provenance.json](packages/desktop/src/vendor/airi-audio/provenance.json). Every build that carries this code ships the original license and provenance: desktop `dist/licenses/`, web `dist/licenses/` (playback manager via `speech-player.ts`), gateway `release/` and its `THIRD_PARTY_LICENSES.md` (chunker via `speech-coordinator.ts`).
- No AIRI voice, model, speaker preset, character artwork or reference recording is included. Kirian's existing temporary voice remains host configured.

## Project AIRI — historical isolated evaluation source

- Project: [moeru-ai/airi](https://github.com/moeru-ai/airi)
- Upstream revision: `0fd71bc1abed585955c1df18a40b95ef3b5276bf`
- Copyright (c) 2024-PRESENT Neko Ayaka
- License: MIT. **Complete, unchanged notice:** [experiments/airi-audio/upstream/LICENSE](experiments/airi-audio/upstream/LICENSE)
- Upstream file: `packages/pipelines-audio/src/transcript-buffer.ts`
- Local copy: [experiments/airi-audio/upstream/transcript-buffer.ts](experiments/airi-audio/upstream/transcript-buffer.ts)
- Modifications: none. Original bytes are preserved; Kirian-authored probes and documentation are separate.
- Scope: compatibility experiment only, not an application/runtime dependency.
- Provenance, hashes, checks and update policy: [provenance.json](experiments/airi-audio/provenance.json), [experiment notes](experiments/airi-audio/README.md).

The preserved MIT notice must accompany copies or substantial portions of this source, including adapted versions. AIRI's name, character artwork, models, voices and other assets were not included by this change. This notice does not grant rights to those separate materials.

## Live2D Cubism — existing integration

Copyright (c) Live2D Inc. All rights reserved, as stated in the included source headers.

| Included material | Local location / notice | Scope |
| --- | --- | --- |
| Cubism Web Framework sources | [vendor/cubism-framework](packages/client/vendor/cubism-framework), [preserved Framework notice](packages/client/model-licenses/live2d-cubism-framework-license.md) | Live2D Open Software License terms; source headers retained |
| Sample-based renderer | [cubism-renderer.ts](packages/client/src/cubism-renderer.ts) | Existing file explicitly identifies the Cubism SDK for Web samples as its basis; exact historical upstream revision/change mapping remains unverified |
| Framework WebGL shaders | [framework/Shaders/WebGL](packages/client/public/live2d/framework/Shaders/WebGL) | Existing Live2D source headers apply |
| Cubism Core and declarations | [Core](packages/client/public/live2d/core), [preserved Core notice](packages/client/model-licenses/live2d-cubism-core-license.md) | Separate proprietary SDK terms; not covered by AIRI MIT |
| Kirian runtime model | [runtime files](packages/client/public/live2d/kirian), [provenance and hashes](packages/client/model-licenses/kirian-model-provenance.md) | User-provided private-development asset; public release rights are not established by this record |

Official projects: [CubismWebFramework](https://github.com/Live2D/CubismWebFramework), [CubismWebSamples](https://github.com/Live2D/CubismWebSamples). SDK distribution/publication terms and model rights must be assessed separately for an actual release. Existing files are not relicensed by this document.

T-063 reuses the existing renderer and supporting code from Tanya baseline `9715600` in [desktop/live2d](packages/desktop/src/renderer/live2d). It adds a Vue lifecycle wrapper, abortable local asset loading, explicit shader preparation, failure/disposal cleanup and manifest parameter mapping. Historical upstream attribution remains as described above; no new exact upstream origin is claimed. [prepare-live2d.mjs](packages/desktop/scripts/prepare-live2d.mjs) copies the existing Core, shaders, Kirian runtime model and preserved notices into the local desktop build. Existing sample-based source headers remain intact. This private development integration does not establish new public redistribution rights.

## Qwen3-TTS — runtime speech synthesis (deploy/qwen3-tts)

- Code: [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), PyPI package `qwen-tts` 0.1.1. License: Apache-2.0 (repository LICENSE; PyPI metadata `Apache-2.0`).
- Weights: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` (snapshot `85e237c12c027371202489a0ec509ded67b5e4b5`) and `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (snapshot `0c0e3051f131929182e2c023b9537f8b1c68adfe`). Each model card declares `license: apache-2.0`; the speech tokenizer (Qwen3-TTS-Tokenizer-12Hz) ships inside each snapshot's `speech_tokenizer/` and is declared Apache-2.0 on its own card. Copyright Alibaba Cloud / Qwen team.
- Runtime dependencies added by the service venv: torch/torchaudio 2.11.0 (BSD-3), transformers 4.57.3 and accelerate 1.12.0 (Apache-2.0), numpy (BSD-3), soundfile (BSD-3), librosa (ISC). Exact pins: [deploy/qwen3-tts/requirements.txt](deploy/qwen3-tts/requirements.txt).
- What Kirian uses: the preset speaker `Sohee` selected by name through `generate_custom_voice`. No fine-tuning, no reference audio and no voice cloning path exists in [deploy/qwen3-tts/server.py](deploy/qwen3-tts/server.py); the Brain binding ([config.py `SpeechBinding`](packages/brain/rearchitecture/config.py)) has no reference-audio fields.
- Where the notice ships: the service runs on the server only; browser and desktop builds do not embed Qwen3-TTS code or weights. This section is the project-level notice. Apache-2.0 requires that redistributions of the weights or code carry the license and NOTICE text — keep the HF snapshot's license file with any copy of the weights.

## Conversation model — Gemma 4 (server Ollama, not redistributed)

- Runtime (public web demo, from 2026-09-18): `hf.co/unsloth/gemma-4-E4B-it-GGUF:Q5_K_M` — Google's official `google/gemma-4-e4b-it` weights (safety-tuned instruction model) quantized to GGUF by Unsloth. The official model card declares **Apache-2.0** and links Google's Gemma 4 license page, which also carries a prohibited-use policy and an intended-use statement (checked 2026-09-17/18). Pulled by the server's Ollama; nothing from it is included in this repository, the desktop installer, the web build or the gateway bundle.
- Retired derivative: `hf.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q5_K_M` was the earlier runtime. Its model card declares `license: gemma` rather than Apache-2.0 and does not reproduce either Google text; the discrepancy was never resolved and the "Uncensored" modification was not reviewed against Google's prohibited-use policy. It is no longer used by the public demo; if it is used again privately, treat it under the stricter reading (Gemma Terms of Use plus the prohibited-use policy) and do not describe it as Apache-2.0.

## Character and voice materials

### Original character

The original character under private development, its artwork and its Live2D model are not part of this public snapshot; the public web demo shows a Live2D Inc. sample character (Free Material License, not redistributed here).

### Live2D Cubism SDK components — distribution position per item

Locations and preserved notices are in the Live2D table above; this adds the condition checked for each item (2026-09-17) and where it may go.

- **Cubism Core** (`live2dcubismcore.min.js`): Live2D Proprietary Software License — redistributable only inside a derivative application, unmodified, with notices retained and under no other license; end users must accept equivalent protective terms. The SDK release-license page exempts individuals and small businesses from the publication agreement except for "expandable" applications. Shipped in desktop/web builds; **excluded from the public source snapshot**.
- **Cubism Web Framework, WebGL shaders and Core type declarations**: Live2D Open Software License, source headers retained. Shipped in builds; excluded from the public snapshot together with Core.
- **Kirian model files** (`.moc3`, textures, `.model3.json`, physics, motions): the user's private development asset (table above). Shipped in builds as one fixed character — visitors cannot add or upload models, so the app is not "expandable" — and **excluded from the public snapshot**.

Web page notice: the public demo serves [notices.html](packages/web/public/notices.html) with these terms and the Live2D user-protection wording, and its build copies the Live2D, Kirian and AIRI notices into `dist/licenses/`.

### Voice materials — historical, excluded

- Retired runtime: GPT-SoVITS (v2Pro) with the user's fine-tuned weights (`tanya-e25.ckpt`, `tanya_e15_s315.pth`) and reference recording `ref_affection.wav`. The training list (`raw_data/tanya_train.list`, 42 WAVs, SHA-256 identical to `C:\Project\Tanya-Project\voicesample`) was generated by the user in Supertone Play in March 2026 and was used for training, not only as a reference.
- Position: these recordings, the derived weights and audio generated with them are **not reused** for Qwen3-TTS (no reference, no training, no cloning), are not read by any current default path, and are excluded from public distribution and the public source snapshot. The files are kept in place (`deploy/gpt-sovits/*`, `deploy/voice/*`, server `~/tts/gpt-sovits-*`) as history only; Supertone Play's terms for its generated audio were not re-verified and nothing here claims a license for them.
- Historical adapters (GPT-SoVITS/Fish Speech/AivisSpeech) in the pre-rearchitecture snapshot remain covered by [the source audit](archive/pre-rearchitecture-2026-09-08/docs/research/reference-audit-2026-09-07.md); they are not runtime dependencies.

## Public snapshot exclusion list

The public portfolio repository receives a squashed snapshot of the working tree, never the development history (which contains a third-party Live2D model that was later removed). Excluded from that snapshot: `packages/client/public/live2d/core`, `packages/client/vendor/cubism-framework`, `packages/client/public/live2d/framework`, `packages/client/public/live2d/kirian`, `deploy/gpt-sovits`, `deploy/voice` GPT-SoVITS runtime inputs, `archive/`, `experiments/`, `CURRENT_PLAN.md`, `.cache/`, and any file naming the private server address, SSH identities or account names. Attribution lines in this file do not substitute for the permissions those excluded materials would need.

## Historical references and compatibility work

Open-LLM-VTuber and OpenClaw are acknowledged as historical technical references in [the reference register](archive/pre-rearchitecture-2026-09-08/docs/reference-projects.md). A protocol compatibility adapter is not, by itself, evidence of copied upstream code. Do not attach the separate Open-LLM-VTuber-Web license to Kirian code without evidence that the applicable source was used. Newly copied upstream material must receive its exact revision's notice alongside its local files.
