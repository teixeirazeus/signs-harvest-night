# Free Grey Alien 3D Models for PSX-Style Game

Found on Sketchfab (June 2026) — downloadable, CC-licensed.

## Best Match

### 1. "PS1/Low Poly Grey Alien" — jellypack
- **URL:** https://sketchfab.com/3d-models/ps1low-poly-grey-alien
- **Likes:** 142 | **Views:** 4,300+
- **License:** CC BY (attribution required)
- **Why it's perfect:** Literally designed as a PS1/low-poly Grey alien. The name says it all.
- **Usage:** Download from Sketchfab → import into Three.js via GLTFLoader → replace our stalkerGroup.

### 2. "Grey Alien idle" — ShaxerTakkuY
- **URL:** https://sketchfab.com/3d-models/grey-alien-idle
- **Likes:** 97 | **Views:** 7,500+
- **License:** CC BY (attribution required)
- **Extras:** Animated (idle animation included) — could add idle breathing/standing animation
- **Usage:** Same as above, but also includes animation clips for idle stance.

### Also found (paid)

### 3. "Grey Alien Enemy Animated" — nateordie (Store)
- **URL:** https://sketchfab.com/3d-models/grey-alien-enemy-animated
- $ Paid model, but includes walk/chase animations

### 4. "Realistic Alien Gray Low-poly" — VincentFreelance (Store)
- $ Paid model

## How to use in Three.js

```javascript
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
loader.load('path/to/grey_alien.glb', (gltf) => {
  const model = gltf.scene;
  
  // PSX-style: force flat shading + nearest filter
  model.traverse((node) => {
    if (node.isMesh) {
      node.material.flatShading = true;
      // Optionally recolor to green for visibility:
      // node.material.color.set(0x3d7a2e);
      if (node.material.map) {
        node.material.map.magFilter = THREE.NearestFilter;
        node.material.map.minFilter = THREE.NearestFilter;
      }
    }
  });
  
  // Replace our current stalkerGroup
  scene.remove(stalkerGroup);
  stalkerGroup = model; // reassign reference
  scene.add(stalkerGroup);
});
```

Sketchfab models typically download as `.glb` (binary GLTF) — ideal for Three.js.
