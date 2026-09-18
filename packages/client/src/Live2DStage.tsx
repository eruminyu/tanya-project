import { useEffect, useRef, useState } from "react";
import { calculateCanvasSize } from "./cubism-layout";
import { createCubismStage, type CubismStageController } from "./cubism-renderer";
import type { Live2DEmotion } from "./live2d-emotion";
import { INITIAL_LIVE2D_LOAD_PROGRESS, type Live2DLoadProgress } from "./live2d-loading";
import { kirianManifest, type Live2DModelManifest } from "./live2d-model";
import { Live2DLoadingIndicator } from "./Live2DLoadingIndicator";
import type { GazePoint } from "./gaze-tracking";
import type { Live2DFraming } from "./live2d-framing";

type LoadState = "loading" | "ready" | "error";

interface Live2DStageProps {
  emotion: Live2DEmotion;
  mouthOpen: number;
  gaze: GazePoint;
  framing: Live2DFraming;
  manifest?: Live2DModelManifest;
  showFirstLoadGuidance?: boolean;
}

export function Live2DStage({ emotion, mouthOpen, gaze, framing, manifest = kirianManifest, showFirstLoadGuidance = false }: Live2DStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CubismStageController | null>(null);
  const emotionRef = useRef(emotion);
  const mouthOpenRef = useRef(mouthOpen);
  const gazeRef = useRef(gaze);
  const framingRef = useRef(framing);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Live2DLoadProgress>(INITIAL_LIVE2D_LOAD_PROGRESS);
  emotionRef.current = emotion;
  mouthOpenRef.current = mouthOpen;
  gazeRef.current = gaze;
  framingRef.current = framing;

  useEffect(() => {
    controllerRef.current?.setEmotion(emotion);
  }, [emotion]);

  useEffect(() => {
    controllerRef.current?.setMouthOpen(mouthOpen);
  }, [mouthOpen]);

  useEffect(() => {
    controllerRef.current?.setGaze(gaze);
  }, [gaze]);

  useEffect(() => {
    controllerRef.current?.setFraming(framing);
  }, [framing]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const canvasElement = canvas;

    let disposed = false;
    let controller: CubismStageController | null = null;
    setState("loading");
    setError("");
    setProgress(INITIAL_LIVE2D_LOAD_PROGRESS);

    const resize = () => {
      const size = calculateCanvasSize(
        host.clientWidth,
        host.clientHeight,
        window.devicePixelRatio,
      );
      if (canvasElement.width === size.width && canvasElement.height === size.height) return;
      canvasElement.width = size.width;
      canvasElement.height = size.height;
      controller?.resize(size.width, size.height);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    async function initialize() {
      try {
        const initializedController = await createCubismStage(canvasElement, manifest, (nextProgress) => {
          if (!disposed) setProgress(nextProgress);
        });
        if (disposed) {
          initializedController.destroy();
          return;
        }
        controller = initializedController;
        controllerRef.current = initializedController;
        initializedController.setEmotion(emotionRef.current);
        initializedController.setMouthOpen(mouthOpenRef.current);
        initializedController.setGaze(gazeRef.current);
        initializedController.setFraming(framingRef.current);
        setState("ready");
      } catch (reason) {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setState("error");
      }
    }

    void initialize();
    return () => {
      disposed = true;
      observer.disconnect();
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.destroy();
    };
  }, [manifest]);

  return (
    <div ref={hostRef} className="live2d-stage">
      <canvas ref={canvasRef} aria-label={`${manifest.displayName} Live2D 모델`} />
      {state === "loading" && (showFirstLoadGuidance
        ? <Live2DLoadingIndicator progress={progress} />
        : <p className="model-state">Live2D 모델 불러오는 중…</p>)}
      {state === "error" && (
        <div className="model-state error" role="alert">
          <strong>Live2D 모델 로딩 실패</strong>
          <small>{error}</small>
        </div>
      )}
      {state === "ready" && <span className="model-ready">Live2D ready</span>}
    </div>
  );
}
