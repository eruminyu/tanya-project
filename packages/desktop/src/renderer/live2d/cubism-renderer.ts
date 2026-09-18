/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Framework 연동 방식은 Cubism SDK for Web 샘플을 기반으로 하며,
 * Live2D Open Software License의 적용을 받습니다.
 */
import { CubismModelSettingJson } from "../../../../client/vendor/cubism-framework/dist/cubismmodelsettingjson";
import {
  BreathParameterData,
  CubismBreath,
} from "../../../../client/vendor/cubism-framework/dist/effect/cubismbreath";
import { CubismEyeBlink } from "../../../../client/vendor/cubism-framework/dist/effect/cubismeyeblink";
import { CubismFramework } from "../../../../client/vendor/cubism-framework/dist/live2dcubismframework";
import { CubismMatrix44 } from "../../../../client/vendor/cubism-framework/dist/math/cubismmatrix44";
import { CubismUserModel } from "../../../../client/vendor/cubism-framework/dist/model/cubismusermodel";
import { ACubismMotion } from "../../../../client/vendor/cubism-framework/dist/motion/acubismmotion";
import { CubismWebGLOffscreenManager } from "../../../../client/vendor/cubism-framework/dist/rendering/cubismoffscreenmanager";
import { calculateProjectionTransform, type ModelLayoutDefaults } from "./cubism-layout";
import { DEFAULT_LIVE2D_FRAMING, type Live2DFraming } from "./live2d-framing";
import { LIVE2D_EMOTIONS, normalizeLive2DEmotion, type Live2DEmotion } from "./live2d-emotion";
import {
  finalizingLive2DLoadProgress,
  INITIAL_LIVE2D_LOAD_PROGRESS,
  MODEL_DATA_LOAD_PROGRESS,
  supportAssetLoadProgress,
  textureLoadProgress,
  type Live2DLoadProgress,
} from "./live2d-loading";
import type { Live2DModelManifest } from "./live2d-model";
import type { GazePoint } from "./gaze-tracking";
import { assetBuffer, assetImage, localAssetUrl } from './assets.js';
import { finiteClamp, safeFraming, safeGaze } from './parameters.js';
import { StageLifetime } from './lifetime.js';
import { prepareShaders, releaseShaders } from './shaders.js';

const SHADER_PATH = "/live2d/framework/Shaders/WebGL/";
let activeStages = 0;
function isEmotion(value: string): value is Live2DEmotion {
  return LIVE2D_EMOTIONS.some(emotion => emotion === value);
}

function ensureFrameworkInitialized(): void {
  if (!CubismFramework.isStarted()) CubismFramework.startUp();
  if (!CubismFramework.isInitialized()) CubismFramework.initialize();
}

function joinAssetUrl(baseUrl: string, fileName: string): string {
  return localAssetUrl(fileName, baseUrl);
}

function createTexture(
  gl: WebGL2RenderingContext,
  image: ImageBitmap,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Live2D WebGL 텍스처 생성 실패");

  try {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

class KirianCubismModel extends CubismUserModel {
  private readonly textures: WebGLTexture[] = [];
  private readonly expressions = new Map<Live2DEmotion, ACubismMotion>();
  private activeEmotion: Live2DEmotion | null = null;
  private mouthOpen = 0;
  private mouthOpenParameterId = CubismFramework.getIdManager().getId("ParamMouthOpenY");
  private eyeBallXParameterId = CubismFramework.getIdManager().getId("ParamEyeBallX");
  private eyeBallYParameterId = CubismFramework.getIdManager().getId("ParamEyeBallY");
  private angleXParameterId = CubismFramework.getIdManager().getId("ParamAngleX");
  private angleYParameterId = CubismFramework.getIdManager().getId("ParamAngleY");
  private gazeTarget: GazePoint = { x: 0, y: 0 };
  private gazeCurrent: GazePoint = { x: 0, y: 0 };
  private framing: Live2DFraming = { ...DEFAULT_LIVE2D_FRAMING };
  private modelLayout: ModelLayoutDefaults = {
    defaultScale: 1,
    defaultOffsetX: 0,
    defaultOffsetY: 0,
  };

  public async load(
    gl: WebGL2RenderingContext,
    manifest: Live2DModelManifest,
    width: number,
    height: number,
    onProgress: (progress: Live2DLoadProgress) => void,
    lifetime: StageLifetime,
  ): Promise<void> {
    const modelUrl = manifest.modelUrl;
    onProgress(INITIAL_LIVE2D_LOAD_PROGRESS);
    const settingBuffer = await assetBuffer(modelUrl, lifetime.signal);
    lifetime.check();
    const setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);
    const modelFileName = setting.getModelFileName();
    if (!modelFileName) throw new Error("model3.json에 Moc 파일이 지정되지 않았습니다.");

    const modelHomeUrl = new URL(".", new URL(modelUrl, window.location.href)).toString();
    onProgress(MODEL_DATA_LOAD_PROGRESS);
    const mocBuffer = await assetBuffer(joinAssetUrl(modelHomeUrl, modelFileName), lifetime.signal);
    lifetime.check();
    this.loadModel(mocBuffer, true);
    if (!this._model || !this._modelMatrix) throw new Error("Cubism Moc 모델 생성 실패");
    this.modelLayout = { ...manifest.layout };

    const layout = new Map<string, number>();
    setting.getLayoutMap(layout);
    this._modelMatrix.setupFromLayout(layout);

    const physicsFileName = setting.getPhysicsFileName();
    const poseFileName = setting.getPoseFileName();
    const supportAssetTotal = (physicsFileName ? 1 : 0) + (poseFileName ? 1 : 0) + Object.keys(manifest.expressions).length;
    let completedSupportAssets = 0;
    onProgress(supportAssetLoadProgress(completedSupportAssets, supportAssetTotal));
    if (physicsFileName) {
      const physicsBuffer = await assetBuffer(joinAssetUrl(modelHomeUrl, physicsFileName), lifetime.signal);
      lifetime.check();
      this.loadPhysics(physicsBuffer, physicsBuffer.byteLength);
      completedSupportAssets += 1;
      onProgress(supportAssetLoadProgress(completedSupportAssets, supportAssetTotal));
    }

    // Sample models such as Mao switch exclusive part groups (arm A/B) through a pose file; without it both
    // groups render at once.
    if (poseFileName) {
      const poseBuffer = await assetBuffer(joinAssetUrl(modelHomeUrl, poseFileName), lifetime.signal);
      lifetime.check();
      this.loadPose(poseBuffer, poseBuffer.byteLength);
      completedSupportAssets += 1;
      onProgress(supportAssetLoadProgress(completedSupportAssets, supportAssetTotal));
    }

    for (const emotion of Object.keys(manifest.expressions)) {
      if (!isEmotion(emotion)) continue;
      const expressionBuffer = await assetBuffer(manifest.expressions[emotion], lifetime.signal);
      lifetime.check();
      const expression = this.loadExpression(
        expressionBuffer,
        expressionBuffer.byteLength,
        emotion,
      );
      if (!expression) throw new Error('캐릭터 표정을 불러오지 못했어요.');
      this.expressions.set(emotion, expression);
      completedSupportAssets += 1;
      onProgress(supportAssetLoadProgress(completedSupportAssets, supportAssetTotal));
    }

    const idManager = CubismFramework.getIdManager();
    this.mouthOpenParameterId = idManager.getId(manifest.parameters.mouthOpen);
    this.eyeBallXParameterId = idManager.getId(manifest.parameters.eyeBallX);
    this.eyeBallYParameterId = idManager.getId(manifest.parameters.eyeBallY);
    this.angleXParameterId = idManager.getId(manifest.parameters.angleX);
    this.angleYParameterId = idManager.getId(manifest.parameters.angleY);
    this._eyeBlink = CubismEyeBlink.create();
    this._eyeBlink.setParameterIds([
      idManager.getId(manifest.parameters.eyeLeftOpen),
      idManager.getId(manifest.parameters.eyeRightOpen),
    ]);
    this._eyeBlink.setBlinkingInterval(4.2);

    this._breath = CubismBreath.create();
    this._breath.setParameters([
      new BreathParameterData(idManager.getId("ParamAngleX"), 0, 2.0, 6.5, 0.25),
      new BreathParameterData(idManager.getId("ParamAngleY"), 0, 1.2, 7.2, 0.2),
      new BreathParameterData(idManager.getId("ParamAngleZ"), 0, 1.0, 8.0, 0.2),
      new BreathParameterData(idManager.getId("ParamBreath"), 0.5, 0.5, 3.8, 1.0),
    ]);

    this.createRenderer(width, height);
    const renderer = this.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    await prepareShaders(gl, lifetime.signal);
    lifetime.check();

    const textureCount = setting.getTextureCount();
    onProgress(textureLoadProgress(0, textureCount));
    for (let index = 0; index < textureCount; index += 1) {
      const fileName = setting.getTextureFileName(index);
      if (!fileName) throw new Error(`Live2D 텍스처 ${index} 경로가 비어 있습니다.`);
      const image = await assetImage(joinAssetUrl(modelHomeUrl, fileName), lifetime.signal);
      try {
        lifetime.check();
        const texture = createTexture(gl, image);
        this.textures.push(texture);
        renderer.bindTexture(index, texture);
      } finally {
        image.close();
      }
      onProgress(textureLoadProgress(index + 1, textureCount));
    }

    this._model.saveParameters();
    this.setEmotion("neutral");
    onProgress(finalizingLive2DLoadProgress(manifest.displayName));
  }

  public setEmotion(emotion: Live2DEmotion): void {
    if (emotion === this.activeEmotion) return;
    const expression = this.expressions.get(emotion) ?? this.expressions.get("neutral");
    if (!expression) return;
    this._expressionManager.startMotion(expression, false);
    this.activeEmotion = emotion;
  }

  public resize(width: number, height: number): void {
    this.setRenderTargetSize(width, height);
  }

  public setMouthOpen(level: number): void {
    this.mouthOpen = finiteClamp(level, 0, 1);
  }

  public setGaze(point: GazePoint): void {
    this.gazeTarget = safeGaze(point);
  }

  public setFraming(framing: Live2DFraming): void {
    this.framing = safeFraming(framing);
  }

  public draw(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    deltaTimeSeconds: number,
  ): void {
    if (!this._model || !this._modelMatrix || !this.getRenderer()) return;

    this._model.loadParameters();
    this._expressionManager.updateMotion(this._model, deltaTimeSeconds);
    this._model.saveParameters();
    this._eyeBlink?.updateParameters(this._model, deltaTimeSeconds);
    this._breath?.updateParameters(this._model, deltaTimeSeconds);
    this._physics?.evaluate(this._model, deltaTimeSeconds);
    this._pose?.updateParameters(this._model, deltaTimeSeconds);
    const gazeBlend = 1 - Math.exp(-10 * deltaTimeSeconds);
    this.gazeCurrent.x += (this.gazeTarget.x - this.gazeCurrent.x) * gazeBlend;
    this.gazeCurrent.y += (this.gazeTarget.y - this.gazeCurrent.y) * gazeBlend;
    this._model.setParameterValueById(this.eyeBallXParameterId, this.gazeCurrent.x);
    this._model.setParameterValueById(this.eyeBallYParameterId, this.gazeCurrent.y);
    this._model.addParameterValueById(this.angleXParameterId, this.gazeCurrent.x * 8);
    this._model.addParameterValueById(this.angleYParameterId, this.gazeCurrent.y * 5);
    this._model.setParameterValueById(this.mouthOpenParameterId, this.mouthOpen);
    this._model.update();

    const projection = new CubismMatrix44();
    const transform = calculateProjectionTransform(
      width,
      height,
      this._model.getCanvasWidth(),
      this.framing,
      this.modelLayout,
    );
    projection.scale(transform.x, transform.y);
    projection.translate(transform.offsetX, transform.offsetY);
    projection.multiplyByMatrix(this._modelMatrix);

    const renderer = this.getRenderer();
    renderer.setMvpMatrix(projection);
    const frameBuffer: WebGLFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    renderer.setRenderState(frameBuffer, [0, 0, width, height]);
    renderer.drawModel(SHADER_PATH);
  }

  public releaseWithContext(gl: WebGL2RenderingContext): void {
    for (const texture of this.textures) gl.deleteTexture(texture);
    this.textures.length = 0;
    try {
      this._expressionManager?.stopAllMotions();
      for (const expression of this.expressions.values()) ACubismMotion.delete(expression);
      this.expressions.clear();
    } finally {
      this.release();
    }
  }
}

export interface CubismStageController {
  resize(width: number, height: number): void;
  setEmotion(emotion: Live2DEmotion): void;
  setMouthOpen(level: number): void;
  setGaze(point: GazePoint): void;
  setFraming(framing: Live2DFraming): void;
  destroy(): void;
}

export async function createCubismStage(
  canvas: HTMLCanvasElement,
  manifest: Live2DModelManifest,
  onProgress: (progress: Live2DLoadProgress) => void = () => undefined,
  options: { signal?: AbortSignal; onError?: (message: string) => void } = {},
): Promise<CubismStageController> {
  const lifetime = new StageLifetime();
  try {
    options.signal?.throwIfAborted();
    const abort = () => lifetime.dispose();
    options.signal?.addEventListener('abort', abort, { once: true });
    lifetime.add(() => options.signal?.removeEventListener('abort', abort));
    ensureFrameworkInitialized();
    activeStages += 1;
    lifetime.add(() => {
      activeStages -= 1;
      if (activeStages === 0) {
        CubismWebGLOffscreenManager.getInstance().release();
        CubismFramework.dispose();
      }
    });
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('캐릭터 그래픽을 사용할 수 없어요.');
    lifetime.add(() => CubismWebGLOffscreenManager.getInstance().removeContext(gl));
    lifetime.add(() => releaseShaders(gl));
    const model = new KirianCubismModel();
    lifetime.add(() => model.releaseWithContext(gl));
    await model.load(gl, manifest, canvas.width, canvas.height, progress => {
      if (!lifetime.disposed) onProgress(progress);
    }, lifetime);
    lifetime.check();
    model.resize(canvas.width, canvas.height);
    let animationFrame = 0;
    let previousTime = performance.now();
    lifetime.add(() => cancelAnimationFrame(animationFrame));
    const fail = () => {
      if (lifetime.disposed) return;
      lifetime.dispose();
      options.onError?.('캐릭터 화면을 표시하지 못했어요. 다시 불러와 주세요.');
    };
    const lost = (event: Event) => { event.preventDefault(); fail(); };
    canvas.addEventListener('webglcontextlost', lost);
    lifetime.add(() => canvas.removeEventListener('webglcontextlost', lost));
    const render = (time: number) => {
      if (lifetime.disposed) return;
      try {
        if (gl.isContextLost()) throw new Error('context_lost');
        const delta = Math.min(Math.max((time - previousTime) / 1000, 0), 0.1);
        previousTime = time;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const offscreen = CubismWebGLOffscreenManager.getInstance();
        offscreen.beginFrameProcess(gl);
        try { model.draw(gl, canvas.width, canvas.height, delta); }
        finally { offscreen.endFrameProcess(gl); }
        animationFrame = requestAnimationFrame(render);
      } catch { fail(); }
    };
    render(previousTime);
    lifetime.check();
    return {
      resize(width, height) { if (!lifetime.disposed) model.resize(width, height); },
      setEmotion(emotion) { if (!lifetime.disposed) model.setEmotion(normalizeLive2DEmotion(emotion)); },
      setMouthOpen(level) { if (!lifetime.disposed) model.setMouthOpen(level); },
      setGaze(point) { if (!lifetime.disposed) model.setGaze(point); },
      setFraming(framing) { if (!lifetime.disposed) model.setFraming(framing); },
      destroy() { lifetime.dispose(); },
    };
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}
