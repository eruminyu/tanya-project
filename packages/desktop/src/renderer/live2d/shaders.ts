/**
 * Adapter for the existing vendored Cubism shader API. The source/registration
 * mapping follows Live2D's cubismshader_webgl.ts; its Live2D notice is preserved.
 * Copyright(c) Live2D Inc. All rights reserved.
 * https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
 */
import { CubismShaderManager_WebGL, CubismShaderSet, ShaderNames, ShaderType } from '../../../../client/vendor/cubism-framework/dist/rendering/cubismshader_webgl';
import { assetText } from './assets.js';

const sourceFiles = [
  ['_vertShaderSrc', 'vertshadersrc.vert'],
  ['_vertShaderSrcMasked', 'vertshadersrcmasked.vert'],
  ['_vertShaderSrcSetupMask', 'vertshadersrcsetupmask.vert'],
  ['_fragShaderSrcSetupMask', 'fragshadersrcsetupmask.frag'],
  ['_fragShaderSrcPremultipliedAlpha', 'fragshadersrcpremultipliedalpha.frag'],
  ['_fragShaderSrcMaskPremultipliedAlpha', 'fragshadersrcmaskpremultipliedalpha.frag'],
  ['_fragShaderSrcMaskInvertedPremultipliedAlpha', 'fragshadersrcmaskinvertedpremultipliedalpha.frag'],
  ['_vertShaderSrcCopy', 'vertshadersrccopy.vert'],
  ['_fragShaderSrcCopy', 'fragshadersrccopy.frag'],
  ['_fragShaderSrcColorBlend', 'fragshadersrccolorblend.frag'],
  ['_fragShaderSrcAlphaBlend', 'fragshadersrcalphablend.frag'],
  ['_vertShaderSrcBlend', 'vertshadersrcblend.vert'],
  ['_fragShaderSrcBlend', 'fragshadersrcpremultipliedalphablend.frag'],
] as const;

export async function prepareShaders(gl: WebGL2RenderingContext, signal: AbortSignal): Promise<void> {
  const sources = await Promise.all(sourceFiles.map(([, file]) => assetText('/live2d/framework/Shaders/WebGL/' + file, signal)));
  signal.throwIfAborted();
  const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  sourceFiles.forEach(([property], index) => { shader[property] = sources[index]; });
  shader._shaderSets = Array.from({ length: shader._shaderCount }, () => new CubismShaderSet());
  shader._isShaderLoaded = false;
  shader._isShaderLoading = true;
  try {
    shader.registerShader();
    shader.registerBlendShader();
    // Cubism reserves blend slots for Normal+Over but uses the standard shaders
    // for that combination. Validate every registered shader, not reserved slots.
    const registeredIndices = new Set(Array.from({ length: ShaderNames.ShaderNames_ShaderCount + 1 }, (_, index) => index));
    for (const base of shader._blendShaderSetMap.values()) {
      for (let offset = 0; offset < ShaderType.ShaderType_Count; offset++) registeredIndices.add(base + offset);
    }
    for (const index of registeredIndices) {
      const set = shader._shaderSets[index];
      if (!set?.shaderProgram || !gl.isProgram(set.shaderProgram) || !gl.getProgramParameter(set.shaderProgram, gl.LINK_STATUS)) {
        throw new Error('캐릭터 셰이더를 준비하지 못했어요.');
      }
    }
    shader._isShaderLoaded = true;
  } finally {
    shader._isShaderLoading = false;
  }
}

export function releaseShaders(gl: WebGL2RenderingContext): void {
  const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  if (!shader) return;
  const programs = new Set(shader._shaderSets.map(set => set?.shaderProgram).filter(Boolean));
  for (const program of programs) gl.deleteProgram(program);
  shader._shaderSets = [];
  shader._isShaderLoaded = false;
}
