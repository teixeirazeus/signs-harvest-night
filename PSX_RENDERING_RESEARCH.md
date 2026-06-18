# Renderização Estilo PlayStation 1 (PSX) em Three.js

> Guia técnico completo para implementar gráficos PSX no Three.js
> Destinado ao branch `psx` do projeto *Signs: Harvest Night*

---

## Índice

1. [Visão Geral](#1-visão-geral)
2. [Características Visuais do PS1](#2-características-visuais-do-ps1)
3. [Técnicas de Implementação](#3-técnicas-de-implementação)
4. [Pipeline Completo (Shader Customizado)](#4-pipeline-completo-shader-customizado)
5. [Tabela: Técnica vs. Abordagem](#5-tabela-técnica-vs-abordagem)
6. [Performance Considerations](#6-performance-considerations)
7. [Links e Recursos](#7-links-e-recursos)
8. [Referências](#8-referências)

---

## 1. Visão Geral

O PlayStation 1 usava hardware com limitações severas que hoje definem uma estética reconhecível:

- **Sem floating-point** → geometria em inteiros de 16-bit → vértices "pulam" (snap/jitter)
- **Sem perspective-correct texture mapping** → texturas "dançam" (affine warp)
- **15-bit color (5:5:5 RGB)** → 32.768 cores, bandas de cor visíveis
- **Frame buffer de 1 MB** → resolução baixa (256x224 ou 320x240), sem anti-aliasing
- **Sem zbuffer** → ordem de renderização por polígono (painter's algorithm)
- **GTE (Geometry Transformation Engine)** → operações matriciais fixas, sem lighting por pixel

---

## 2. Características Visuais do PS1

| Característica | Causa Técnica | Efeito Visual |
|---|---|---|
| **Vertex Snapping** | Fixed-point math (3.12 signed) | Vértices tremem/saltam em grid |
| **Affine Texture Mapping** | Sem perspectiva correction | Texturas沿 diagonais扭曲 |
| **Dithering** | Frame buffer de 15-bit → padrão Bayer | Ruído organizado em áreas de gradiente |
| **Color Banding** | 5 bits por canal (0-31) | Degradês visíveis, transições abruptas |
| **Low Poly** | Limite de ~2400 polígonos por frame | Modelos simplificados, faces grandes |
| **Sub-Pixel Wobble** | Ausência de sub-pixel precision na GTE | Objetos "vibram" em relação à câmera |
| **Pop-In** | Distância de render curta + visibilidade por setor | Objetos aparecem subitamente |
| **Fog** | Distance fog forçado pelo hardware | Nevoeiro denso que oculta o pop-in |
| **Nearest Neighbor** | Sem bilinear filtering | Texturas pixeladas, "serrilhadas" |
| **No Anti-Aliasing** | Frame buffer direto, sem multisampling | Aliasing evidente em bordas |

---

## 3. Técnicas de Implementação

### 3.1 Nearest-Neighbor Filtering

**Abordagem: Configuração padrão do Three.js** — não precisa de shader.

```javascript
import * as THREE from 'three';

const texture = new THREE.TextureLoader().load('texture.png');
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.generateMipmaps = false;

// No carregador GLTF:
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

> **Leve.** Custo zero de performance, apenas muda o sampler do GPU.

### 3.2 Low-Poly / Baixa Contagem de Polígonos

**Abordagem: Configuração padrão do Three.js**

```javascript
const sphere = new THREE.SphereGeometry(1, 8, 8);   // 8x8 = 80 triângulos
const cylinder = new THREE.CylinderGeometry(1, 1, 2, 6); // Prisma hexagonal
```

> **Leve.** Menos polígonos = mais performance.

### 3.3 Color Depth / Quantização de Cores

**Abordagem: Shader de pós-processamento (GLSL)**

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

> **Médio.** Pass simples de tela cheia. PS1 autêntico usa 5-bit (31 steps). Para terror, 16-24 steps.

### 3.4 Dithering (Bayer Matrix)

**Abordagem: Shader de pós-processamento**

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

> **Médio.** Combine sempre com quantização. Essencial para o visual PSX.

### 3.5 Vertex Snapping / Jitter

**Abordagem: Shader de vértice customizado** — técnica mais importante.

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

**Variação Camera-Relative Snap (mais autêntico):**
```glsl
vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
float snap = 0.5;
vec2 snappedXY = floor(viewPos.xy / snap) * snap;
viewPos.xy = snappedXY;
gl_Position = projectionMatrix * viewPos;
```

> **Pesado (relativo).** Custa math por vértice. Para <10k vértices é imperceptível.

### 3.6 Affine Texture Mapping

**Abordagem: Shader de fragmento customizado**

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

**Variação autêntica (affine dividido por W):**
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

> **Médio.** Warp exagerado = cara do PS1. Combine com vertex snapping.

### 3.7 Sub-Pixel Wobble

**Abordagem: CPU** — animação da matriz de projeção.

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

> **Leve.** Apenas math de CPU 1x por frame.

### 3.8 Pop-In / Distance Culling

**Abordagem: nativa Three.js + setorização manual**

```javascript
const popInDistance = 30;
function updatePopIn(object, camera) {
  object.visible = object.position.distanceTo(camera.position) < popInDistance;
}

// Setorização manual (autêntico PS1):
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

> **Leve.** Apenas operações de distância.

### 3.9 Fog Estilo PS1

**Abordagem: Shader customizado com depth texture**

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

**Alternativa nativa:**
```javascript
scene.fog = new THREE.Fog(0x000000, 20, 50); // Linear
scene.fog = new THREE.FogExp2(0x000000, 0.04); // Exponencial — mais próximo do PS1
```

> **Médio.** Requer depth texture. Alternativa nativa é leve mas sem dithering.

### 3.10 Gouraud Shading com Bandas

**Abordagem: ShaderMaterial com quantização de luz por vértice**

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

> **Médio.** Cálculo por vértice.

### 3.11 Flat Shading

**Abordagem: Nativo Three.js**

```javascript
const material = new THREE.MeshStandardMaterial({ flatShading: true });
// No ShaderMaterial: { flatShading: true }
```

> **Leve.** Nativo.

---

## 4. Pipeline Completo (Shader Customizado)

Shader unificado combinando **vertex snapping + affine texture + quantização + dithering + fog**:

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

// Uso:
const psxMaterial = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.clone(PSXShader.uniforms),
  vertexShader: PSXShader.vertexShader,
  fragmentShader: PSXShader.fragmentShader,
  side: THREE.DoubleSide
});
```

---

## 5. Tabela: Técnica vs. Abordagem

| Técnica | Abordagem Three.js | Requer Shader? | Código |
|---|---|---|---|
| Nearest-Neighbor | texture.magFilter = NearestFilter | Não | 1 linha |
| Low-Poly | SphereGeometry(1, 8, 8) | Não | 1 linha |
| Flat Shading | material.flatShading = true | Não | 1 linha |
| Color Quantization | Pós-processo GLSL | Sim (fragment) | ~20 linhas |
| Bayer Dithering | Pós-processo GLSL | Sim (fragment) | ~40 linhas |
| Vertex Snapping | Shader de vértice | Sim (vertex) | ~30 linhas |
| Affine Texture | Shader de fragmento | Sim (vertex+frag) | ~15 linhas |
| Sub-Pixel Wobble | CPU (anima câmera) | Opcional | ~10 linhas |
| Pop-In | object.visible = dist < limit | Não | 1 linha |
| Fog (básico) | scene.fog = new THREE.Fog() | Não | 1 linha |
| Fog (PSX estilo) | Pós-processo com depth | Sim | ~50 linhas |
| Gouraud banding | ShaderMaterial com quantização | Sim (vertex) | ~30 linhas |
| Baixa resolução | renderer.setSize(320, 240) | Não | 1 linha |
| Sem AA | antialias: false | Não | 1 linha |

---

## 6. Performance Considerations

### Leve (custo zero ou mínimo)
| Técnica | Impacto |
|---|---|
| Nearest-neighbor filtering | 🟢 Nenhum |
| Flat shading | 🟢 Nenhum |
| Low-poly geometria | 🟢 Positivo (menos vértices) |
| Pop-in manual | 🟢 Mínimo |
| Resolução baixa | 🟢 Positivo |
| Sem anti-aliasing | 🟢 Positivo |

### Médio (custo aceitável)
| Técnica | Impacto |
|---|---|
| Color quantization | 🟡 1 pass simples |
| Bayer dithering | 🟡 lookup de matriz |
| Fog com depth | 🟡 Requer depth texture |
| Vertex snapping | 🟡 Math no vertex shader |
| Gouraud banding | 🟡 Cálculo por vértice |

### Pesado (usar com moderação)
| Técnica | Impacto |
|---|---|
| Affine texture mapping | 🔴 Divisão extra no fragment |
| Jitter (hash trigonométrico) | 🔴 sin/cos no vertex shader |
| Multi-pass pós-processo | 🔴 Largura de banda |
| Sub-pixel wobble (CPU) | 🔴 Overhead com muitos objetos |

### Recomendações para Signs: Harvest Night

**Pipeline ideal:**
1. `renderer.setPixelRatio(1)` + `{ antialias: false }` + resolução baixa (640x480)
2. Todas texturas: NearestFilter + generateMipmaps = false
3. **UM** shader unificado (snapping + quantização + dithering + fog)
4. Affine texture mapping **seletivo** (só objetos próximos)
5. Pop-in por setorização
6. Fog abrupto (esconde pop-in + atmosfera de terror)

**O que NÃO fazer:**
- Não use EffectComposer com 5+ passes → combine tudo em 1 shader
- Não aplique affine warp em objetos distantes
- Não use sin/cos para jitter com >5000 vértices
- Não use múltiplos passes de pós-processamento desnecessários

**Profile PS1 real vs alvo:**
- PS1: ~180K polígonos/s teórico, ~70-100K/s realista, 320x240, ~30 FPS
- Se rodar a 30 FPS em 640x480 com shader PSX → **acima do hardware original**

---

## 7. Links e Recursos

### Repositórios GitHub

| Repositório | Estrelas | Descrição |
|---|---|---|
| [phoboslab/wipeout](https://github.com/phoboslab/wipeout) | 552 | WipEout PSX Model Viewer em Three.js — exemplo canônico |
| [ad044/lainTSX](https://github.com/ad044/lainTSX) | 686 | WebGL do jogo Serial Experiments Lain PSX — **referência máxima** |
| [mesmotronic/three-retropass](https://github.com/mesmotronic/three-retropass) | 36 | Post-process retro para Three.js (dither, quantize, pixelation) |
| [dooji2/psx-core-shader](https://github.com/dooji2/psx-core-shader) | — | Shader PSX Minecraft (snapping, affine, dither, fog) — **referência GLSL** |
| [grayespinoza/ps1-shaders](https://github.com/grayespinoza/ps1-shaders) | 1 | Shaders OptiFine com técnicas PS1 |
| [gorescript/gorescript](https://github.com/gorescript/gorescript) | 350 | Retro FPS em Three.js |
| [dannycalleri/polytron](https://github.com/dannycalleri/polytron) | 17 | Visualizador de modelos PSX TMD em Three.js |
| [andrewboudreau/nullgrav](https://github.com/andrewboudreau/nullgrav) | — | Hover racer estilo PSX em Three.js |

### Artigos e Documentação

| Recurso | Link |
|---|---|
| Three.js ShaderMaterial Docs | https://threejs.org/docs/#api/en/materials/ShaderMaterial |
| Three.js Post-Processing Guide | https://threejs.org/docs/#manual/en/introduction/How-to-use-post-processing |
| DotScreen Effect Example | https://threejs.org/examples/webgl_postprocessing_dotscreen |
| PS1 GPU Technical Reference | https://psx-spx.consoledev.net/graphicsprocessingunittm-gpu/ |
| PS1 GTE Overview | https://psx-spx.consoledev.net/geometrytransformationenginetm-gte/ |
| psx.dev — PS1 programming blog | https://psx.dev/ |
| "Why PS1 Graphics Wobble" (YouTube) | https://www.youtube.com/watch?v=TK82U7bQhY8 |
| Bayer Matrix Dithering | https://en.wikipedia.org/wiki/Ordered_dithering |

### npm e ShaderToy

| Recurso | Link/Package |
|---|---|
| three-retropass package | `npm install @mesmotronic/three-retropass` |
| PS1-style ShaderToy | https://www.shadertoy.com/results?query=psx+retro |

---

## 8. Referências

Compilado a partir de:
1. [phoboslab/wipeout](https://github.com/phoboslab/wipeout) — NearestFilter + materiais PSX
2. [ad044/lainTSX](https://github.com/ad044/lainTSX) — engine WebGL Serial Experiments Lain PSX
3. [mesmotronic/three-retropass](https://github.com/mesmotronic/three-retropass) — Bayer dithering + quantização em Three.js
4. [dooji2/psx-core-shader](https://github.com/dooji2/psx-core-shader) — GLSL de vertex snapping, affine mapping, dithering, fog
5. [psx-spx.consoledev.net](https://psx-spx.consoledev.net/) — Especificação técnica do PS1
6. Documentação oficial Three.js

---

> **Nota final:** Vertex snapping + affine texture + dithering + baixa resolução = 90% do visual PSX. O resto é polish.
