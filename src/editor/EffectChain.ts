// ── WebGL2 Effect Chain ────────────────────────────────────────────────────────
// Each enabled Effect on a Clip is run as a fragment shader pass over the
// previous result (FBO ping-pong). The final image is blitted to the display
// canvas via Canvas2D drawImage().
//
// Usage:
//   const chain = new EffectChain(1920, 1080);
//   const bitmap = await chain.process(videoFrame, clip.effects);
//   ctx2d.drawImage(bitmap, 0, 0);
//   bitmap.close();
//   chain.dispose();

import type {
  Effect, ColorCorrectParams, BlurParams, SharpenParams, VignetteParams, CropParams,
  TransformParams, LutParams,
} from './types.ts';

// ── Pure-logic helpers (exported for unit testing) ────────────────────────────

/**
 * Convert TransformParams (pixel offsets, degrees) to normalized shader uniforms.
 * Translation is normalized to UV space (0..1). Rotation is converted to radians.
 * Scale and anchor pass through unchanged.
 */
export function normalizeTransformUniforms(
  params: TransformParams,
  width: number,
  height: number,
): { u_tx: number; u_ty: number; u_sx: number; u_sy: number; u_rot: number; u_ax: number; u_ay: number } {
  return {
    u_tx: params.x / width,
    u_ty: params.y / height,
    u_sx: params.scaleX,
    u_sy: params.scaleY,
    u_rot: params.rotation * (Math.PI / 180),
    u_ax: params.anchorX,
    u_ay: params.anchorY,
  };
}

/**
 * Scale a LUT coordinate to avoid clamping artifacts at edges.
 * Returns: value * ((lutSize - 1) / lutSize) + 0.5 / lutSize
 */
export function computeLutCoord(value: number, lutSize: number): number {
  return value * ((lutSize - 1) / lutSize) + 0.5 / lutSize;
}

/**
 * Select the FBO internal format and pixel type based on float16 extension availability.
 */
export function selectFboFormat(hasFloat16: boolean): { internalFormat: string; type: string } {
  return hasFloat16
    ? { internalFormat: 'RGBA16F', type: 'HALF_FLOAT' }
    : { internalFormat: 'RGBA8', type: 'UNSIGNED_BYTE' };
}

/**
 * Return only the effects with enabled === true.
 */
export function filterEnabledEffects(effects: Effect[]): Effect[] {
  return effects.filter(e => e.enabled);
}

/**
 * Move an effect from fromIndex to toIndex, returning a new array.
 * The original array is not mutated.
 */
export function reorderEffects(effects: Effect[], fromIndex: number, toIndex: number): Effect[] {
  const arr = effects.slice();
  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, moved);
  return arr;
}

// ── GLSL sources ──────────────────────────────────────────────────────────────

const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_IDENTITY = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = texture(u_tex, v_uv); }`;

const FRAG_COLOR_CORRECT = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue;
uniform float u_temperature;
uniform float u_tint;
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;
in vec2 v_uv;
out vec4 o_color;

vec3 rgb2hsl(vec3 c) {
  float hi = max(max(c.r, c.g), c.b);
  float lo = min(min(c.r, c.g), c.b);
  float l = (hi + lo) * 0.5;
  float d = hi - lo;
  if (d < 0.0001) return vec3(0.0, 0.0, l);
  float s = d / (1.0 - abs(2.0 * l - 1.0));
  float h;
  if (hi == c.r)      h = mod((c.g - c.b) / d, 6.0);
  else if (hi == c.g) h = (c.b - c.r) / d + 2.0;
  else                h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

vec3 hsl2rgb(vec3 c) {
  float h6 = c.x * 6.0;
  float s  = c.y;
  float l  = c.z;
  float ch = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x  = ch * (1.0 - abs(mod(h6, 2.0) - 1.0));
  vec3 rgb;
  if      (h6 < 1.0) rgb = vec3(ch, x,  0.0);
  else if (h6 < 2.0) rgb = vec3(x,  ch, 0.0);
  else if (h6 < 3.0) rgb = vec3(0.0, ch, x);
  else if (h6 < 4.0) rgb = vec3(0.0, x,  ch);
  else if (h6 < 5.0) rgb = vec3(x,  0.0, ch);
  else               rgb = vec3(ch, 0.0, x);
  return rgb + vec3(l - ch * 0.5);
}

void main() {
  vec4 col = texture(u_tex, v_uv);
  vec3 c = col.rgb;

  // Brightness (additive shift) then contrast (scale around 0.5) — applied
  // independently so a non-zero contrast does not amplify the brightness offset.
  c = c + u_brightness;
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;

  // Temperature (blue ↔ orange) and tint (green ↔ magenta)
  c.r += u_temperature * 0.15;
  c.b -= u_temperature * 0.15;
  c.g -= u_tint * 0.10;

  // Hue shift and saturation (in HSL)
  vec3 hsl = rgb2hsl(max(c, vec3(0.0)));  // don't clamp upper — preserve highlights through hue/sat
  hsl.x = fract(hsl.x + u_hue / 360.0);
  hsl.y = clamp(hsl.y * (1.0 + u_saturation), 0.0, 1.0);
  c = hsl2rgb(hsl);

  // Lift / Gamma / Gain (applied per-channel)
  c = max(c + u_lift, 0.0);
  c = pow(max(c, 0.0001), 1.0 / max(u_gamma, 0.0001));
  c *= u_gain;

  o_color = vec4(clamp(c, 0.0, 1.0), col.a);
}`;

// Separable Gaussian blur — horizontal pass
const FRAG_BLUR_H = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_radius;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  int r = int(u_radius);
  float sigma2 = max(u_radius * u_radius / 9.0, 1.0);
  for (int i = -r; i <= r; i++) {
    float w = exp(-float(i * i) / (2.0 * sigma2));
    sum  += texture(u_tex, v_uv + vec2(float(i) * u_texel.x, 0.0)) * w;
    wsum += w;
  }
  o_color = sum / wsum;
}`;

// Separable Gaussian blur — vertical pass
const FRAG_BLUR_V = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_radius;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  int r = int(u_radius);
  float sigma2 = max(u_radius * u_radius / 9.0, 1.0);
  for (int i = -r; i <= r; i++) {
    float w = exp(-float(i * i) / (2.0 * sigma2));
    sum  += texture(u_tex, v_uv + vec2(0.0, float(i) * u_texel.y)) * w;
    wsum += w;
  }
  o_color = sum / wsum;
}`;

// Laplacian sharpening
const FRAG_SHARPEN = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_amount;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 c  = texture(u_tex, v_uv);
  vec4 n  = texture(u_tex, v_uv + vec2( 0.0,          u_texel.y));
  vec4 s  = texture(u_tex, v_uv + vec2( 0.0,         -u_texel.y));
  vec4 e  = texture(u_tex, v_uv + vec2( u_texel.x,    0.0));
  vec4 w  = texture(u_tex, v_uv + vec2(-u_texel.x,    0.0));
  vec4 lap = c * 4.0 - n - s - e - w;
  o_color = vec4(clamp(c.rgb + lap.rgb * u_amount, 0.0, 1.0), c.a);
}`;

// Vignette — aspect-ratio-corrected, with configurable roundness
const FRAG_VIGNETTE = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_strength;
uniform float u_midpoint;
uniform float u_roundness;   // 0 = rectangle, 1 = circle
uniform float u_feather;
uniform float u_aspect;      // canvas width / height
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 col = texture(u_tex, v_uv);
  vec2 uv2 = v_uv * 2.0 - 1.0;
  uv2.x *= u_aspect;         // correct for aspect ratio → true circle
  // Blend between L-inf norm (square) and L2 norm (circle) via roundness
  float r = max(u_roundness, 0.001);
  float p = 2.0 / r;         // p=2 → circle; p→∞ → square
  float dist = pow(pow(abs(uv2.x), p) + pow(abs(uv2.y), p), 1.0 / p);
  float lo = max(u_midpoint - u_feather * 0.5, 0.0);
  float hi = max(u_midpoint + u_feather * 0.5, lo + 0.001);
  float vig = 1.0 - smoothstep(lo, hi, dist) * u_strength;
  o_color = vec4(col.rgb * vig, col.a);
}`;

// Crop — masks edges to black using normalized 0-1 fractions per side
const FRAG_CROP = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_left;
uniform float u_right;
uniform float u_top;
uniform float u_bottom;
in vec2 v_uv;
out vec4 o_color;
void main() {
  if (v_uv.x < u_left || v_uv.x > 1.0 - u_right ||
      v_uv.y < u_top  || v_uv.y > 1.0 - u_bottom) {
    o_color = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    o_color = texture(u_tex, v_uv);
  }
}`;

// 2D Transform — inverse-affine UV remapping in the fragment shader.
// Uniforms are in normalized UV space (0..1); use normalizeTransformUniforms()
// before calling runPass to convert from TransformParams pixel/degree values.
const FRAG_TRANSFORM = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_tx;        // translation X in normalized coords
uniform float u_ty;        // translation Y in normalized coords
uniform float u_sx;        // scale X
uniform float u_sy;        // scale Y
uniform float u_rot;       // rotation in radians
uniform float u_ax;        // anchor X (normalized, 0..1)
uniform float u_ay;        // anchor Y (normalized, 0..1)
in vec2 v_uv;
out vec4 o_color;
void main() {
  // Move origin to anchor point
  vec2 uv = v_uv - vec2(u_ax, u_ay);
  // Inverse rotation
  float c = cos(-u_rot);
  float s = sin(-u_rot);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
  // Inverse scale
  uv = uv / vec2(u_sx, u_sy);
  // Inverse translation (translate is applied in screen space, not texture space)
  uv = uv + vec2(u_ax, u_ay) - vec2(u_tx, u_ty);
  // Out-of-bounds → transparent black
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    o_color = vec4(0.0);
    return;
  }
  o_color = texture(u_tex, uv);
}`;

// 3D LUT — samples a TEXTURE_3D with GPU trilinear interpolation.
// The coordinate scaling avoids clamping artifacts at LUT edges.
const FRAG_LUT = /* glsl */ `#version 300 es
precision mediump float;
precision mediump sampler3D;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform float u_opacity;
uniform float u_lut_size;  // LUT dimension N
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 col = texture(u_tex, v_uv);
  // Scale input to account for LUT edge interpolation (avoids clamping artifacts)
  float scale = (u_lut_size - 1.0) / u_lut_size;
  float offset = 0.5 / u_lut_size;
  vec3 lutCoord = col.rgb * scale + offset;
  vec3 graded = texture(u_lut, lutCoord).rgb;
  o_color = vec4(mix(col.rgb, graded, u_opacity), col.a);
}`;

// ── Internal types ────────────────────────────────────────────────────────────

interface Program {
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;      // quad VBO — must be deleted in dispose()
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface FBOPair {
  fbo: [WebGLFramebuffer, WebGLFramebuffer];
  tex: [WebGLTexture,     WebGLTexture    ];
}

interface FBOEntry {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

// ── EffectChain class ─────────────────────────────────────────────────────────

export class EffectChain {
  private gl: WebGL2RenderingContext;
  private canvas: OffscreenCanvas;
  private fbo: FBOPair;
  /** Dedicated scratch FBO for intermediate multi-pass effects (e.g. blur H-pass). */
  private scratch: FBOEntry;
  private sourceTex: WebGLTexture;
  private programs: Map<string, Program> = new Map();
  private width: number;
  private height: number;

  /** True when EXT_color_buffer_float is available — enables RGBA16F FBO textures. */
  private useFloat16: boolean;
  /** True when OES_texture_float_linear is available — enables LINEAR filter on TEXTURE_3D. */
  private hasFloatLinear: boolean;

  /** Cache of uploaded LUT 3D textures, keyed by Float32Array reference. */
  private lutTexCache: Map<Float32Array, WebGLTexture> = new Map();
  /** Tracks whether the NEAREST-filter warning has been fired (fire once per instance). */
  private lutNearestWarnFired = false;

  private onWarning?: (msg: string) => void;

  constructor(width: number, height: number, onWarning?: (msg: string) => void) {
    this.width  = width;
    this.height = height;
    this.onWarning = onWarning;
    this.canvas = new OffscreenCanvas(width, height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    // Check float extension availability (both enables the extension AND tests presence)
    this.useFloat16     = !!gl.getExtension('EXT_color_buffer_float');
    this.hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');

    if (!this.useFloat16) {
      this.onWarning?.('GPU limited: some effects may show banding');
    }

    this.sourceTex = this.mkTex();
    this.fbo       = this.mkFBOPair();
    this.scratch   = this.mkFBOEntry();

    this.buildProgram('identity',     VERT, FRAG_IDENTITY,      []);
    this.buildProgram('colorCorrect', VERT, FRAG_COLOR_CORRECT,
      ['u_brightness','u_contrast','u_saturation','u_hue','u_temperature','u_tint',
       'u_lift','u_gamma','u_gain']);
    this.buildProgram('blurH',        VERT, FRAG_BLUR_H,        ['u_radius','u_texel']);
    this.buildProgram('blurV',        VERT, FRAG_BLUR_V,        ['u_radius','u_texel']);
    this.buildProgram('sharpen',      VERT, FRAG_SHARPEN,       ['u_amount','u_texel']);
    this.buildProgram('vignette',     VERT, FRAG_VIGNETTE,
      ['u_strength','u_midpoint','u_roundness','u_feather','u_aspect']);
    this.buildProgram('crop',         VERT, FRAG_CROP,
      ['u_left','u_right','u_top','u_bottom']);
    // Non-essential programs — degrade gracefully if GPU rejects them
    this.tryBuildProgram('transform', VERT, FRAG_TRANSFORM,
      ['u_tx','u_ty','u_sx','u_sy','u_rot','u_ax','u_ay']);
    this.tryBuildProgram('lut',       VERT, FRAG_LUT,
      ['u_lut','u_opacity','u_lut_size']);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Process a VideoFrame or ImageBitmap through the effect stack.
   * The frame/bitmap is NOT closed here — caller is responsible.
   * Returns an ImageBitmap for drawing to the display canvas.
   */
  async process(frame: VideoFrame | ImageBitmap, effects: Effect[]): Promise<ImageBitmap> {
    const gl = this.gl;

    // Resize FBOs if the frame dimensions differ from our current size
    // ImageBitmap uses .width/.height; VideoFrame uses .displayWidth/.displayHeight
    const fw = 'displayWidth' in frame ? frame.displayWidth : frame.width;
    const fh = 'displayHeight' in frame ? frame.displayHeight : frame.height;
    if (fw !== this.width || fh !== this.height) {
      this.resize(fw, fh);
    }

    gl.viewport(0, 0, this.width, this.height);

    // Upload the VideoFrame to the source texture (flip Y so GL's bottom-left
    // origin matches the VideoFrame's top-left origin — done here once instead
    // of in the vertex shader, which would double-flip on multi-pass chains)
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const enabledEffects = filterEnabledEffects(effects);

    if (enabledEffects.length === 0) {
      // Fast path: blit source directly to canvas (null = default framebuffer)
      this.runPass('identity', this.sourceTex, null, {});
    } else {
      let readTex  = this.sourceTex;
      let writeFBO = this.fbo.fbo[0];
      let writeTex = this.fbo.tex[0];
      let pingpong = 0;

      for (const effect of enabledEffects) {
        this.runEffect(effect, readTex, writeFBO);

        // Swap ping-pong: next read comes from what we just wrote
        pingpong ^= 1;
        readTex  = writeTex;
        writeFBO = this.fbo.fbo[pingpong];
        writeTex = this.fbo.tex[pingpong];
      }

      // Blit the final result (readTex) to the canvas
      this.runPass('identity', readTex, null, {});
    }

    // Transfer canvas pixels to an ImageBitmap and return it
    return this.canvas.transferToImageBitmap();
  }

  /** Resize the internal FBO textures. Called automatically when frame dimensions change. */
  resize(width: number, height: number): void {
    this.width  = width;
    this.height = height;
    this.canvas.width  = width;
    this.canvas.height = height;

    this.resizeTex(this.fbo.tex[0]);
    this.resizeTex(this.fbo.tex[1]);
    this.resizeTex(this.scratch.tex);
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.programs.values()) {
      gl.deleteProgram(p.prog);
      gl.deleteVertexArray(p.vao);
      gl.deleteBuffer(p.buf);
    }
    this.programs.clear();
    gl.deleteTexture(this.sourceTex);
    gl.deleteTexture(this.fbo.tex[0]);
    gl.deleteTexture(this.fbo.tex[1]);
    gl.deleteFramebuffer(this.fbo.fbo[0]);
    gl.deleteFramebuffer(this.fbo.fbo[1]);
    gl.deleteTexture(this.scratch.tex);
    gl.deleteFramebuffer(this.scratch.fbo);

    // Clean up cached LUT 3D textures
    for (const tex of this.lutTexCache.values()) {
      gl.deleteTexture(tex);
    }
    this.lutTexCache.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private runEffect(effect: Effect, readTex: WebGLTexture, writeFBO: WebGLFramebuffer): void {
    const p = effect.params;
    switch (effect.kind) {
      case 'colorCorrect': {
        const cc = p as ColorCorrectParams;
        this.runPass('colorCorrect', readTex, writeFBO, {
          u_brightness:  cc.brightness,
          u_contrast:    cc.contrast,
          u_saturation:  cc.saturation,
          u_hue:         cc.hue,
          u_temperature: cc.temperature,
          u_tint:        cc.tint,
          u_lift:  [cc.liftR,  cc.liftG,  cc.liftB ],
          u_gamma: [cc.gammaR, cc.gammaG, cc.gammaB],
          u_gain:  [cc.gainR,  cc.gainG,  cc.gainB ],
        });
        break;
      }
      case 'blur': {
        const b = p as BlurParams;
        const tw = 1 / this.width;
        const th = 1 / this.height;
        // H-pass → scratch (never conflicts with readTex or writeFBO)
        // V-pass → writeFBO (reads scratch, which is separate)
        this.runPass('blurH', readTex, this.scratch.fbo, {
          u_radius: b.radius, u_texel: [tw, th],
        });
        this.runPass('blurV', this.scratch.tex, writeFBO, {
          u_radius: b.radius, u_texel: [tw, th],
        });
        break;
      }
      case 'sharpen': {
        const s = p as SharpenParams;
        this.runPass('sharpen', readTex, writeFBO, {
          u_amount: s.amount,
          u_texel: [1 / this.width, 1 / this.height],
        });
        break;
      }
      case 'vignette': {
        const v = p as VignetteParams;
        this.runPass('vignette', readTex, writeFBO, {
          u_strength:  v.strength,
          u_midpoint:  v.midpoint,
          u_roundness: v.roundness,
          u_feather:   v.feather,
          u_aspect:    this.width / this.height,
        });
        break;
      }
      case 'crop': {
        const c = p as CropParams;
        this.runPass('crop', readTex, writeFBO, {
          u_left:   c.left,
          u_right:  c.right,
          u_top:    c.top,
          u_bottom: c.bottom,
        });
        break;
      }
      case 'transform': {
        const t = p as TransformParams;
        const uniforms = normalizeTransformUniforms(t, this.width, this.height);
        this.runPass('transform', readTex, writeFBO, uniforms);
        break;
      }
      case 'lut': {
        const lut = p as LutParams;
        // Skip if no LUT data loaded — run identity pass-through
        if (lut.lutData.length === 0) {
          this.runPass('identity', readTex, writeFBO, {});
          break;
        }
        const lutTex = this.uploadLut(lut.lutData, lut.size);
        const gl = this.gl;
        const prog = this.programs.get('lut');
        if (!prog) break;

        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
        gl.useProgram(prog.prog);
        gl.bindVertexArray(prog.vao);

        // Bind source 2D texture to unit 0
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);
        const uTex = prog.uniforms.get('u_tex');
        if (uTex != null) gl.uniform1i(uTex, 0);

        // Bind LUT 3D texture to unit 1
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lutTex);
        const uLut = prog.uniforms.get('u_lut');
        if (uLut != null) gl.uniform1i(uLut, 1);

        // Set float uniforms
        const uOpacity = prog.uniforms.get('u_opacity');
        if (uOpacity != null) gl.uniform1f(uOpacity, lut.opacity);
        const uLutSize = prog.uniforms.get('u_lut_size');
        if (uLutSize != null) gl.uniform1f(uLutSize, lut.size);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
        break;
      }
      default:
        // Unknown effect kind — pass through
        this.runPass('identity', readTex, writeFBO, {});
    }
  }

  /**
   * Upload a LUT Float32Array as a WebGL2 TEXTURE_3D, caching by reference.
   * Uses LINEAR filter when OES_texture_float_linear is available, NEAREST otherwise.
   */
  private uploadLut(lutData: Float32Array, size: number): WebGLTexture {
    const existing = this.lutTexCache.get(lutData);
    if (existing) return existing;

    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);

    const filter = this.hasFloatLinear ? gl.LINEAR : gl.NEAREST;
    if (!this.hasFloatLinear && !this.lutNearestWarnFired) {
      this.lutNearestWarnFired = true;
      this.onWarning?.('GPU limited: LUT trilinear filter unavailable, using NEAREST (may show banding)');
    }

    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, lutData);

    this.lutTexCache.set(lutData, tex);
    return tex;
  }

  private runPass(
    name: string,
    srcTex: WebGLTexture,
    destFBO: WebGLFramebuffer | null,
    uniforms: Record<string, number | number[]>,
  ): void {
    const gl = this.gl;
    const prog = this.programs.get(name);
    if (!prog) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO);
    gl.useProgram(prog.prog);
    gl.bindVertexArray(prog.vao);

    // Bind source texture to unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    const uTex = prog.uniforms.get('u_tex');
    // Use != null (not !== undefined) — getUniformLocation returns null for
    // inactive uniforms, and calling uniform1i(null, 0) is a GL error.
    if (uTex != null) gl.uniform1i(uTex, 0);

    // Set remaining uniforms
    for (const [key, val] of Object.entries(uniforms)) {
      const loc = prog.uniforms.get(key);
      if (loc == null) continue;
      if (Array.isArray(val)) {
        if (val.length === 2) gl.uniform2fv(loc, val);
        else if (val.length === 3) gl.uniform3fv(loc, val);
        else if (val.length === 4) gl.uniform4fv(loc, val);
      } else {
        gl.uniform1f(loc, val);
      }
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private buildProgram(name: string, vert: string, frag: string, uniformNames: string[]): void {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vert);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      // Free GPU resources before throwing — the throw would otherwise skip the
      // deleteShader/deleteProgram calls below.
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      throw new Error(`Shader link error [${name}]: ${info}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Full-screen quad (two triangles covering NDC [-1,1])
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,  -1,  1,
       1, -1,   1,  1,  -1,  1,
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Collect uniform locations (including u_tex)
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    uniforms.set('u_tex', gl.getUniformLocation(prog, 'u_tex'));
    for (const u of uniformNames) {
      uniforms.set(u, gl.getUniformLocation(prog, u));
    }

    this.programs.set(name, { prog, vao, buf, uniforms });
  }

  /** Like buildProgram but logs a warning instead of throwing on failure. */
  private tryBuildProgram(name: string, vert: string, frag: string, uniformNames: string[]): void {
    try {
      this.buildProgram(name, vert, frag, uniformNames);
    } catch (err) {
      console.warn(`[EffectChain] ${name} shader unavailable:`, err);
      this.onWarning?.(`${name} effect unavailable on this GPU`);
    }
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${gl.getShaderInfoLog(sh)}\n\n${src}`);
    }
    return sh;
  }

  private mkTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internalFmt = this.useFloat16 ? gl.RGBA16F  : gl.RGBA8;
    const pixelType   = this.useFloat16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, this.width, this.height, 0, gl.RGBA, pixelType, null);
    return tex;
  }

  private resizeTex(tex: WebGLTexture): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internalFmt = this.useFloat16 ? gl.RGBA16F  : gl.RGBA8;
    const pixelType   = this.useFloat16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, this.width, this.height, 0, gl.RGBA, pixelType, null);
  }

  private mkFBOPair(): FBOPair {
    const gl = this.gl;
    const t0 = this.mkTex();
    const t1 = this.mkTex();
    const f0 = gl.createFramebuffer()!;
    const f1 = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f1);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t1, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: [f0, f1], tex: [t0, t1] };
  }

  private mkFBOEntry(): FBOEntry {
    const gl  = this.gl;
    const tex = this.mkTex();
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }
}
