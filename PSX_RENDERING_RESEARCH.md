# PlayStation 1 (PSX) Style Rendering in Three.js

> Complete technical guide to implementing PSX graphics in Three.js
> Intended for the `psx` branch of the *Signs: Harvest Night* project

---

## Table of Contents

1. [Overview](#1-overview)
2. [PS1 Visual Characteristics](#2-ps1-visual-characteristics)
3. [Implementation Techniques](#3-implementation-techniques)
4. [Complete Pipeline (Custom Shader)](#4-complete-pipeline-custom-shader)
5. [Table: Technique vs. Approach](#5-table-technique-vs-approach)
6. [Performance Considerations](#6-performance-considerations)
7. [Links and Resources](#7-links-and-resources)
8. [References](#8-references)

---

## 1. Overview

The PlayStation 1 used hardware with severe limitations that today define a recognizable aesthetic:

- **No floating-point** → 16-bit integer geometry → vertices "pop" (snap/jitter)
- **No perspective-correct texture mapping** → textures "dance" (affine warp)
- **15-bit color (5:5:5 RGB)** → 32,768 colors, visible color bands
- **1 MB frame buffer** → low resolution (256x224 or 320x240), no anti-aliasing
- **No zbuffer** → polygon rendering order (painter's algorithm)
- **GTE (Geometry Transformation Engine)** → fixed matrix operations, no per-pixel lighting

---

## 2. PS1 Visual Characteristics

| Characteristic | Technical Cause | Visual Effect |
|---|---|---|
| **Vertex Snapping** | Fixed-point math (3.12 signed) | Vertices shake/snap in a grid |
| **Affine Texture Mapping** | No perspective correction | Texturas沿 diagonais扭曲 |
| **Dithering** | 15-bit frame buffer → Bayer pattern | Organized noise in gradient areas |
| **Color Banding** | 5 bits per channel (0-31) | Visible gradients, abrupt transitions |
| **Low Poly** | Limit of ~2400 polygons per frame | Simplified models, large faces |
| **Sub-Pixel Wobble** | Lack of sub-pixel precision in the GTE | Objects "vibrate" relative to the camera |
| **Pop-In** | Short render distance + sector-based visibility | Objects appear suddenly |
| **Fog** | Distance fog forced by hardware | Dense fog that hides pop-in |
| **Nearest Neighbor** | No bilinear filtering | Pixelated, "jagged" textures |
| **No Anti-Aliasing** | Direct frame buffer, no multisampling | Evident aliasing on edges |

---

## 3. Implementation Techniques

### 3.1 Nearest-Neighbor Filtering

**Approach: Default Three.js configuration** — no shader needed.

```javascript
import * as THREE from 'three';

const texture = new THREE.TextureLoader().load('texture.png');
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;

// In GLTF loader:
const loader = new THREE.GLTFLoader();
loader.load('model.glb', (gltf) => {
  gltf.scene.traverse((node) => {
    if (node.isMesh && node.material.map) {
      node.material.map.magFilter = THREE.NearestFilter;
      node.material.map.minFilter = THREE.NearestFilter;
      node.material.map.generateMipmaps = false;
      node.material.flatShading = true;
    }
  });
});
```

> **Light.** Zero performance cost, just changes the GPU sampler.

### 3.2 Low-Poly / Low Polygon Count

**Approach: Default Three.js configuration**

```javascript
const sphere = new THREE.SphereGeometry(1, 8, 8);   // 8x8 = 80 triângulos
const cylinder = new THREE.CylinderGeometry(1, 1, 2, 6); // Prisma hexagonal
```

> **Light.** Fewer polygons = more performance.

### 3.3 Color Depth / Color Quantization

**Approach: Post-processing shader (GLSL)**

```javascript
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const ColorQuantizeShader = {
  uniforms: { tDiffuse: { value: null }, uSteps: { value: 31.0 } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSteps; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = floor(c.rgb * uSteps) / uSteps;
      gl_FragColor = c;
    }
  `
};
const quantizePass = new ShaderPass(ColorQuantizeShader);
composer.addPass(quantizePass);
```

> **Medium.** Simple full-screen pass. Authentic PS1 uses 5-bit (31 steps). For horror, 16-24 steps.

### 3.4 Dithering (Bayer Matrix)

**Approach: Post-processing shader**

```javascript
const DitherShader = {
  uniforms: { tDiffuse: { value: null }, uSteps: { value: 31.0 }, uStrength: { value: 1.5 } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSteps; uniform float uStrength; varying vec2 vUv;
    const float bayer[16] = float[](
      0.0/16.0, 8.0/16.0, 2.0/16.0, 10.0/16.0,
      12.0/16.0, 4.0/16.0, 14.0/16.0, 6.0/16.0,
      3.0/16.0, 11.0/16.0, 1.0/16.0, 9.0/16.0,
      15.0/16.0, 7.0/16.0, 13.0/16.0, 5.0/16.0
    );
    void main() {
      vec2 frag = gl_FragCoord.xy;
      int ix = int(mod(frag.x, 4.0)); int iy = int(mod(frag.y, 4.0));
      float threshold = bayer[iy * 4 + ix] * uStrength;
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = floor(c.rgb * uSteps + threshold) / uSteps;
      gl_FragColor = c;
    }
  `
};
```

> **Medium.** Always combine with quantization. Essential for the PSX look.

### 3.5 Vertex Snapping / Jitter

**Approach: Custom vertex shader** — the most important technique.

```javascript
const vertexSnapShader = {
  uniforms: {
    uSnapNear: { value: 0.05 }, uSnapFar: { value: 0.15 },
    uSnapRef: { value: 64.0 }, uSnapCurve: { value: 1.0 }, uJitter: { value: 0.02 }
  },
  vertexShader: `
    uniform float uSnapNear, uSnapFar, uSnapRef, uSnapCurve, uJitter;
    varying vec2 vUv; varying float vDepth;
    void main() {
      vUv = uv;
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      float depth = length(worldPos.xyz);
      float t = pow(clamp(depth / uSnapRef, 0.0, 1.0), uSnapCurve);
      float snapSize = mix(uSnapNear, uSnapFar, t);
      vec3 snapped = floor(worldPos.xyz / snapSize + 0.5) * snapSize;
      if (uJitter > 0.0) {
        vec3 cell = floor(worldPos.xyz / snapSize);
        float hash = fract(sin(dot(cell.xy, vec2(12.9898, 78.233)) + cell.z * 37.0) * 43758.5453);
        snapped.xy += (hash - 0.5) * uJitter * snapSize;
      }
      vec4 viewPos = viewMatrix * vec4(snapped, 1.0);
      gl_Position = projectionMatrix * viewPos;
      vDepth = -viewPos.z;
    }
  `,
  fragmentShader: `
    varying vec2 vUv; varying float vDepth;
    void main() { gl_FragColor = vec4(1.0); }
  `
};
```

**Camera-Relative Snap Variation (more authentic):**
```glsl
vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
float snap = 0.5;
vec2 snappedXY = floor(viewPos.xy / snap) * snap;
viewPos.xy = snappedXY;
gl_Position = projectionMatrix * viewPos;
```

> **Heavy (relative).** Costs math per vertex. For <10k vertices it's imperceptible.

### 3.6 Affine Texture Mapping

**Approach: Custom fragment shader**

```javascript
const AffineTextureShader = {
  uniforms: { uTexture: { value: null }, uWarpLimit: { value: 0.5 } },
  vertexShader: `
    varying vec2 vUv; varying float vW;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vW = mvPosition.w;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform sampler2D uTexture; uniform float uWarpLimit;
    varying vec2 vUv; varying float vW;
    void main() {
      float warp = uWarpLimit / max(vW, 0.5);
      vec2 affineUV = vUv + (vUv - 0.5) * warp;
      gl_FragColor = texture2D(uTexture, affineUV);
    }
  `
};
```

**Authentic variation (affine divided by W):**
```glsl
// Vertex:
varying vec2 vAffineUV; varying float vW;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vW = mvPos.w; vAffineUV = uv * vW;
  gl_Position = projectionMatrix * mvPos;
}
// Fragment:
void main() {
  vec2 affineUV = vAffineUV / max(vW, 0.001);
  gl_FragColor = texture2D(uTexture, affineUV);
}
```

> **Medium.** Exaggerated warp = the face of PS1. Combine with vertex snapping.

### 3.7 Sub-Pixel Wobble

**Approach: CPU** — projection matrix animation.

```javascript
let frame = 0;
function updateCameraWobble(camera) {
  frame++;
  const wobbleX = (Math.sin(frame * 0.3) * 0.5 + Math.cos(frame * 0.17) * 0.5) * 0.5;
  const wobbleY = (Math.cos(frame * 0.23) * 0.5 + Math.sin(frame * 0.41) * 0.5) * 0.5;
  const proj = camera.projectionMatrix.elements;
  proj[8] += wobbleX * 0.001;
  proj[9] += wobbleY * 0.001;
}
```

> **Light.** Just CPU math 1x per frame.

### 3.8 Pop-In / Distance Culling

**Approach: Native Three.js + manual sectorization**

```javascript
const popInDistance = 30;
function updatePopIn(object, camera) {
  object.visible = object.position.distanceTo(camera.position) < popInDistance;
}

// Manual sectorization (authentic PS1):
const sectorSize = 20;
function updateSectors(camera, sectors) {
  const cx = Math.floor(camera.position.x / sectorSize);
  const cz = Math.floor(camera.position.z / sectorSize);
  for (const key in sectors) {
    const [sx, sz] = key.split(',').map(Number);
    sectors[key].forEach(obj => {
      obj.visible = Math.abs(sx - cx) <= 1 && Math.abs(sz - cz) <= 1;
    });
  }
}
```

> **Light.** Just distance operations.

### 3.9 PS1-Style Fog

**Approach: Custom shader with depth texture**

```javascript
const PSXFogShader = {
  uniforms: {
    tDiffuse: { value: null }, uDepthTexture: { value: null },
    uFogDistance: { value: 30.0 }, uFogColor: { value: new THREE.Color(0x000000) },
    uCameraNear: { value: 0.1 }, uCameraFar: { value: 100.0 },
    uDitherStrength: { value: 0.002 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse, uDepthTexture;
    uniform float uFogDistance, uCameraNear, uCameraFar, uDitherStrength;
    uniform vec3 uFogColor; varying vec2 vUv;

    const float bayer[16] = float[](
      0.0/16.0, 8.0/16.0, 2.0/16.0, 10.0/16.0,
      12.0/16.0, 4.0/16.0, 14.0/16.0, 6.0/16.0,
      3.0/16.0, 11.0/16.0, 1.0/16.0, 9.0/16.0,
      15.0/16.0, 7.0/16.0, 13.0/16.0, 5.0/16.0
    );

    float getLinearDepth(float d) {
      float z = d * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float depth = texture2D(uDepthTexture, vUv).r;
      float linearDepth = getLinearDepth(depth);
      float fogFactor = smoothstep(uFogDistance - 5.0, uFogDistance + 5.0, linearDepth);
      int ix = int(mod(gl_FragCoord.x, 4.0)); int iy = int(mod(gl_FragCoord.y, 4.0));
      fogFactor = clamp(fogFactor + (bayer[iy * 4 + ix] - 0.5) * uDitherStrength, 0.0, 1.0);
      color.rgb = mix(color.rgb, uFogColor, fogFactor);
      gl_FragColor = color;
    }
  `
};
```

**Native alternative:**
```javascript
scene.fog = new THREE.Fog(0x000000, 20, 50); // Linear
scene.fog = new THREE.FogExp2(0x000000, 0.04); // Exponential — closer to PS1
```

> **Medium.** Requires depth texture. Native alternative is light but without dithering.

### 3.10 Gouraud Shading with Banding

**Approach: ShaderMaterial with per-vertex light quantization**

```javascript
const PSXGouraudShader = {
  uniforms: {
    uLightDir: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
    uLightSteps: { value: 32.0 }, uLightIntensity: { value: 0.8 }
  },
  vertexShader: `
    uniform vec3 uLightDir; uniform float uLightSteps, uLightIntensity;
    varying vec3 vColor; varying vec2 vUv;
    void main() {
      vUv = uv;
      vec3 normal = normalize(normalMatrix * normal);
      float NdotL = max(dot(normal, uLightDir), 0.0);
      float light = floor(NdotL * uLightSteps) / uLightSteps;
      light = light * uLightIntensity + (1.0 - uLightIntensity);
      vColor = color * light;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vColor; varying vec2 vUv;
    void main() { gl_FragColor = vec4(vColor, 1.0); }
  `
};
```

> **Medium.** Per-vertex calculation.

### 3.11 Flat Shading

**Approach: Native Three.js**

```javascript
const material = new THREE.MeshStandardMaterial({ flatShading: true });
// In ShaderMaterial: { flatShading: true }
```

> **Light.** Native.

---

## 4. Complete Pipeline (Custom Shader)

Unified shader combining **vertex snapping + affine texture + quantization + dithering + fog**:

```javascript
// PSX_UnifiedShader.js
import * as THREE from 'three';

export const PSXShader = {
  uniforms: {
    uTexture: { value: null },
    uSnapNear: { value: 0.03 }, uSnapFar: { value: 0.08 },
    uSnapRef: { value: 96.0 }, uSnapCurve: { value: 1.0 }, uJitter: { value: 0.02 },
    uWarpLimit: { value: 0.5 },
    uColorSteps: { value: 31.0 }, uDitherStrength: { value: 2.0 },
    uFogColor: { value: new THREE.Color(0x000000) }, uFogDistance: { value: 40.0 }
  },

  vertexShader: /* glsl */`
    uniform float uSnapNear, uSnapFar, uSnapRef, uSnapCurve, uJitter;
    varying vec2 vUv; varying vec2 vAffineUV; varying float vW; varying float vDepth;

    void main() {
      vUv = uv;
      // Vertex snapping
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      float depth = length(worldPos.xyz);
      float t = pow(clamp(depth / uSnapRef, 0.0, 1.0), uSnapCurve);
      float snapSize = mix(uSnapNear, uSnapFar, t);
      vec3 snapped = floor(worldPos.xyz / snapSize + 0.5) * snapSize;
      if (uJitter > 0.0) {
        vec3 cell = floor(worldPos.xyz / snapSize);
        float hash = fract(sin(dot(cell.xy, vec2(12.9898, 78.233)) + cell.z * 37.0) * 43758.5453);
        snapped.xy += (hash - 0.5) * uJitter * snapSize;
      }
      vec4 viewPos = viewMatrix * vec4(snapped, 1.0);
      // Affine prep
      vW = viewPos.w; vAffineUV = uv * vW;
      gl_Position = projectionMatrix * viewPos;
      vDepth = -viewPos.z;
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D uTexture;
    uniform float uWarpLimit, uColorSteps, uDitherStrength, uFogDistance;
    uniform vec3 uFogColor;
    varying vec2 vUv, vAffineUV; varying float vW, vDepth;

    const float bayer[16] = float[](
      0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
      3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0
    );

    void main() {
      vec2 uv_affine = vAffineUV / max(vW, 0.001);
      uv_affine = clamp(uv_affine, -1.0, 2.0);
      float warp = uWarpLimit / max(vW, 0.5);
      vec2 finalUV = uv_affine + (uv_affine - 0.5) * warp;
      vec4 texColor = texture2D(uTexture, finalUV);

      // Quantization
      vec3 quantized = floor(texColor.rgb * uColorSteps) / uColorSteps;

      // Dithering
      int ix = int(mod(gl_FragCoord.x, 4.0)); int iy = int(mod(gl_FragCoord.y, 4.0));
      float dither = (bayer[iy * 4 + ix] / 16.0) * uDitherStrength;
      vec3 dithered = floor(texColor.rgb * uColorSteps + dither) / uColorSteps;
      vec3 finalColor = mix(quantized, dithered, step(0.001, length(texColor.rgb)));

      // Fog
      float fogFactor = smoothstep(uFogDistance - 8.0, uFogDistance + 2.0, vDepth);
      fogFactor = clamp(fogFactor + (bayer[(iy * 4 + ix) % 16] / 16.0 - 0.5) * 0.002, 0.0, 1.0);
      finalColor = mix(finalColor, uFogColor, fogFactor);

      gl_FragColor = vec4(finalColor, texColor.a);
    }
  `
};

// Usage:
const psxMaterial = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.clone(PSXShader.uniforms),
  vertexShader: PSXShader.vertexShader,
  fragmentShader: PSXShader.fragmentShader,
  side: THREE.DoubleSide
});
```

---

## 5. Table: Technique vs. Approach

| Technique | Three.js Approach | Requires Shader? | Code |
|---|---|---|---|
| Nearest-Neighbor | texture.magFilter = NearestFilter | No | 1 line |
| Low-Poly | SphereGeometry(1, 8, 8) | No | 1 line |
| Flat Shading | material.flatShading = true | No | 1 line |
| Color Quantization | GLSL Post-process | Yes (fragment) | ~20 lines |
| Bayer Dithering | GLSL Post-process | Yes (fragment) | ~40 lines |
| Vertex Snapping | Vertex shader | Yes (vertex) | ~30 lines |
| Affine Texture | Fragment shader | Yes (vertex+frag) | ~15 lines |
| Sub-Pixel Wobble | CPU (animates camera) | Optional | ~10 lines |
| Pop-In | object.visible = dist < limit | No | 1 line |
| Fog (basic) | scene.fog = new THREE.Fog() | No | 1 line |
| Fog (PSX style) | Post-process with depth | Yes | ~50 lines |
| Gouraud banding | ShaderMaterial with quantization | Yes (vertex) | ~30 lines |
| Low resolution | renderer.setSize(320, 240) | No | 1 line |
| No AA | antialias: false | No | 1 line |

---

## 6. Performance Considerations

### Light (zero or minimal cost)
| Technique | Impact |
|---|---|
| Nearest-neighbor filtering | 🟢 None |
| Flat shading | 🟢 None |
| Low-poly geometry | 🟢 Positive (fewer vertices) |
| Manual pop-in | 🟢 Minimal |
| Low resolution | 🟢 Positive |
| No anti-aliasing | 🟢 Positive |

### Medium (acceptable cost)
| Technique | Impact |
|---|---|
| Color quantization | 🟡 1 simple pass |
| Bayer dithering | 🟡 Matrix lookup |
| Fog with depth | 🟡 Requires depth texture |
| Vertex snapping | 🟡 Math in vertex shader |
| Gouraud banding | 🟡 Per-vertex calculation |

### Heavy (use sparingly)
| Technique | Impact |
|---|---|
| Affine texture mapping | 🔴 Extra division in fragment |
| Jitter (trigonometric hash) | 🔴 sin/cos in vertex shader |
| Multi-pass post-processing | 🔴 Bandwidth |
| Sub-pixel wobble (CPU) | 🔴 Overhead with many objects |

### Recommendations for Signs: Harvest Night

**Ideal pipeline:**
1. `renderer.setPixelRatio(1)` + `{ antialias: false }` + low resolution (640x480)
2. All textures: NearestFilter + generateMipmaps = false
3. **ONE** unified shader (snapping + quantization + dithering + fog)
4. Affine texture mapping **selective** (only nearby objects)
5. Sector-based pop-in
6. Abrupt fog (hides pop-in + horror atmosphere)

**What NOT to do:**
- Don't use EffectComposer with 5+ passes → combine everything in 1 shader
- Don't apply affine warp to distant objects
- Don't use sin/cos for jitter with >5000 vertices
- Don't use unnecessary multiple post-processing passes

**Real PS1 profile vs target:**
- PS1: ~180K polygons/s theoretical, ~70-100K/s realistic, 320x240, ~30 FPS
- If running at 30 FPS at 640x480 with PSX shader → **above original hardware**

---

## 7. Links and Resources

### GitHub Repositories

| Repository | Stars | Description |
|---|---|---|
| [phoboslab/wipeout](https://github.com/phoboslab/wipeout) | 552 | WipEout PSX Model Viewer in Three.js — canonical example |
| [ad044/lainTSX](https://github.com/ad044/lainTSX) | 686 | WebGL engine of Serial Experiments Lain PSX — **ultimate reference** |
| [mesmotronic/three-retropass](https://github.com/mesmotronic/three-retropass) | 36 | Retro post-process for Three.js (dither, quantize, pixelation) |
| [dooji2/psx-core-shader](https://github.com/dooji2/psx-core-shader) | — | PSX Minecraft shader (snapping, affine, dither, fog) — **GLSL reference** |
| [grayespinoza/ps1-shaders](https://github.com/grayespinoza/ps1-shaders) | 1 | OptiFine shaders with PS1 techniques |
| [gorescript/gorescript](https://github.com/gorescript/gorescript) | 350 | Retro FPS in Three.js |
| [dannycalleri/polytron](https://github.com/dannycalleri/polytron) | 17 | PSX TMD model viewer in Three.js |
| [andrewboudreau/nullgrav](https://github.com/andrewboudreau/nullgrav) | — | PSX-style hover racer in Three.js |

### Articles and Documentation

| Resource | Link |
|---|---|
| Three.js ShaderMaterial Docs | https://threejs.org/docs/#api/en/materials/ShaderMaterial |
| Three.js Post-Processing Guide | https://threejs.org/docs/#manual/en/introduction/How-to-use-post-processing |
| DotScreen Effect Example | https://threejs.org/examples/webgl_postprocessing_dotscreen |
| PS1 GPU Technical Reference | https://psx-spx.consoledev.net/graphicsprocessingunittm-gpu/ |
| PS1 GTE Overview | https://psx-spx.consoledev.net/geometrytransformationenginetm-gte/ |
| psx.dev — PS1 programming blog | https://psx.dev/ |
| "Why PS1 Graphics Wobble" (YouTube) | https://www.youtube.com/watch?v=TK82U7bQhY8 |
| Bayer Matrix Dithering | https://en.wikipedia.org/wiki/Ordered_dithering |

### npm and ShaderToy

| Resource | Link/Package |
|---|---|
| three-retropass package | `npm install @mesmotronic/three-retropass` |
| PS1-style ShaderToy | https://www.shadertoy.com/results?query=psx+retro |

---

## 8. References

Compiled from:
1. [phoboslab/wipeout](https://github.com/phoboslab/wipeout) — NearestFilter + PSX materials
2. [ad044/lainTSX](https://github.com/ad044/lainTSX) — WebGL engine of Serial Experiments Lain PSX
3. [mesmotronic/three-retropass](https://github.com/mesmotronic/three-retropass) — Bayer dithering + quantization in Three.js
4. [dooji2/psx-core-shader](https://github.com/dooji2/psx-core-shader) — GLSL of vertex snapping, affine mapping, dithering, fog
5. [psx-spx.consoledev.net](https://psx-spx.consoledev.net/) — PS1 technical specification
6. Official Three.js documentation

---

> **Final note:** Vertex snapping + affine texture + dithering + low resolution = 90% of the PSX look. The rest is polish.
