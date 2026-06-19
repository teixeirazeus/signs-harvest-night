/**
 * SIGNS: HARVEST NIGHT — main.js
 * 3D Horror FPS — Three.js greybox prototype
 *
 * Architecture:
 *   G001 — Scene, Camera, Renderer, PointerLockControls, WASD movement
 *   G002 — Night atmosphere, fog, flashlight SpotLight
 *   G003 — Cornfield (InstancedMesh)
 *   G004 — Anomalies (collectible objects)
 *   G005 — Stalker AI (chase + stare mechanic)
 *   G006 — Game loop, HUD, states, win/lose
 *   G007 — Verification gate
 *
 * All lighting, collision, and game-loop sections are heavily commented
 * for future art/sound integration.
 */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ============================================================================
// DOM REFERENCES
// ============================================================================
const instructionsEl = document.getElementById('instructions');
const hudEl = document.getElementById('hud');
const gameOverScreen = document.getElementById('game-over-screen');
const gameOverTitle = document.getElementById('game-over-title');
const gameOverReason = document.getElementById('game-over-reason');
const winScreen = document.getElementById('win-screen');
const restartBtn = document.getElementById('restart-btn');
const restartBtnWin = document.getElementById('restart-btn-win');
const anomalyCountEl = document.getElementById('anomaly-count');
const stareMeterEl = document.getElementById('stare-meter');

// ============================================================================
// CORE THREE.JS SETUP — Scene, Camera, Renderer
// ============================================================================

// --- RENDERER (PSX-style) ---
// Low resolution, no anti-aliasing, no tone mapping — authentic PS1 feel.
// 640x480 internal resolution at native pixel ratio mimics the PS1's
// 320x240 framebuffer scaled to typical displays.
const PSX_WIDTH = 640;
const PSX_HEIGHT = 480;
const renderer = new THREE.WebGLRenderer({
  antialias: false,          // PS1 has no AA
  powerPreference: 'high-performance',
});
renderer.setSize(PSX_WIDTH, PSX_HEIGHT);
renderer.setPixelRatio(1);   // No retina — 1:1 pixel mapping
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;  // PS1 has no HDR
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Scale canvas with CSS to fill viewport (preserves low-res rendering)
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.domElement.style.imageRendering = 'pixelated'; // Crisp pixel scaling

// --- SCENE ---
const scene = new THREE.Scene();

// --- CAMERA ---
// FOV 75 for claustrophobic feel common in horror games.
// Near clip at 0.1, far clip at 80 — fog will obscure beyond ~40.
const camera = new THREE.PerspectiveCamera(
  75,                                             // FOV
  PSX_WIDTH / PSX_HEIGHT,                          // Aspect (4:3)
  0.1,                                            // Near clip
  80                                               // Far clip
);
camera.position.set(0, 1.7, 0); // Eye height ~1.7 units (average human)
scene.add(camera);

// ============================================================================
// POINTER LOCK CONTROLS — First-person mouse look + WASD
// ============================================================================

const controls = new PointerLockControls(camera, renderer.domElement);

// Pointer lock on click — standard FPS pattern.
// Must listen on BOTH the canvas AND the instructions overlay, because
// the overlay sits on top of the canvas and captures clicks first.
function requestPointerLock() {
  if (!controls.isLocked) {
    controls.lock();
  }
}
renderer.domElement.addEventListener('click', requestPointerLock);
// The instructions overlay covers the canvas — clicks land here first.
instructionsEl.addEventListener('click', (e) => {
  e.stopPropagation(); // Don't double-fire on the canvas underneath
  requestPointerLock();
});

controls.addEventListener('lock', () => {
  instructionsEl.classList.add('hidden');
  hudEl.style.display = 'block';
  if (gameState === 'MENU') {
    gameState = 'PLAYING';
    // Start audio on first user interaction
    initAudio();
    if (audioState.ambience && !audioState.ambience.playing()) {
      audioState.ambience.play();
    }
    console.log('Game started — explore the cornfield. Find 5 anomalies.');
  }
});

controls.addEventListener('unlock', () => {
  if (gameState === 'PLAYING') {
    instructionsEl.classList.remove('hidden');
    hudEl.style.display = 'none';
  }
});

// ============================================================================
// INPUT STATE — WASD movement tracking
// ============================================================================

const keyState = {
  KeyW: false,
  KeyA: false,
  KeyS: false,
  KeyD: false,
};

document.addEventListener('keydown', (e) => {
  if (e.code in keyState) {
    keyState[e.code] = true;
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code in keyState) {
    keyState[e.code] = false;
    e.preventDefault();
  }
});

// ============================================================================
// MOVEMENT CONSTANTS
// ============================================================================

const MOVE_SPEED = 6.0;      // Units per second — walking speed
const PLAYER_HEIGHT = 1.7;   // Eye/camera height above ground

// Movement direction vector (reused each frame to avoid allocation)
const moveDirection = new THREE.Vector3();
const forwardDir = new THREE.Vector3();
const rightDir = new THREE.Vector3();

// ============================================================================
// CLOCK — for delta-time based movement
// ============================================================================

const clock = new THREE.Clock();

// ============================================================================
// GAME STATE
// ============================================================================

let gameState = 'MENU'; // MENU | PLAYING | GAME_OVER | WIN
let anomaliesCollected = 0;

// ============================================================================
// RESIZE HANDLER
// ============================================================================

window.addEventListener('resize', () => {
  // Fixed 4:3 resolution — scale canvas with CSS, not render size
  // (PSX-style: internal resolution never changes, CSS stretches to fill)
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
});

// ============================================================================
// ANIMATION LOOP
// ============================================================================

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.1); // Cap delta to avoid tunneling

  // --- MOVEMENT (WASD relative to camera facing) ---
  // Only apply movement when pointer is locked and game is in PLAYING state.
  if (controls.isLocked && (gameState === 'PLAYING' || gameState === 'ABDUCTING')) {
    // Get camera's forward (on XZ plane) and right vectors
    camera.getWorldDirection(forwardDir);
    forwardDir.y = 0;
    forwardDir.normalize();

    rightDir.crossVectors(forwardDir, camera.up).normalize();

    // Accumulate input into moveDirection
    moveDirection.set(0, 0, 0);

    if (keyState.KeyW) moveDirection.add(forwardDir);
    if (keyState.KeyS) moveDirection.sub(forwardDir);
    if (keyState.KeyA) moveDirection.sub(rightDir);
    if (keyState.KeyD) moveDirection.add(rightDir);

    if (moveDirection.lengthSq() > 0) {
      moveDirection.normalize();
      // Apply movement — controls.moveRight / moveForward handle collision
      // with PointerLockControls' built-in velocity.
      controls.moveRight(moveDirection.dot(rightDir) * MOVE_SPEED * delta);
      controls.moveForward(moveDirection.dot(forwardDir) * MOVE_SPEED * delta);
    }

    // Clamp player to ground plane (Y = PLAYER_HEIGHT)
    // In future: replace with proper terrain height query.
    camera.position.y = PLAYER_HEIGHT;

    // --- G004: ANOMALY COLLECTION DETECTION ---
    // Check distance from player (camera) to each uncollected anomaly.
    // If within COLLECT_DISTANCE, mark as collected and update HUD.
    for (const anomaly of anomalies) {
      if (anomaly.collected) continue;
      const dx = camera.position.x - anomaly.mesh.position.x;
      const dz = camera.position.z - anomaly.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < COLLECT_DISTANCE) {
        anomaly.collected = true;
        anomaly.mesh.visible = false;
        if (anomaly.glowLight) anomaly.glowLight.intensity = 0;
        anomaliesCollected++;
        anomalyCountEl.textContent = anomaliesCollected;

        console.log(`Anomaly collected: ${anomaly.name} (${anomaliesCollected}/5)`);

        // Check win condition
        if (anomaliesCollected >= 5) {
          gameState = 'WIN';
          controls.unlock();
          winScreen.classList.remove('hidden');
          hudEl.style.display = 'none';
          console.log('WIN: All 5 anomalies collected!');
        }
      }
    }

    // --- G005: STALKER AI — chase, stare, and visibility ---
    updateStalker(delta, forwardDir);

    // --- VISUAL: Update dust particles (drift + recycle) ---
    updateParticles(delta);

    // --- VISUAL: Rotate and pulse anomalies ---
    const time = performance.now() * 0.001;
    for (const anomaly of anomalies) {
      if (anomaly.collected) continue;
      // Slow rotation — each anomaly at a different axis/speed
      anomaly.mesh.rotation.y += delta * anomaly.rotSpeed;
      anomaly.mesh.rotation.x += delta * anomaly.rotSpeed * 0.3;
      // Pulsing emissive intensity (subtle, sinusoidal)
      const pulse = 1.0 + Math.sin(time * anomaly.pulseFreq) * 0.4;
      anomaly.mesh.material.emissiveIntensity = 1.5 * pulse;
      if (anomaly.glowLight) {
        anomaly.glowLight.intensity = ANOMALY_GLOW_INTENSITY * pulse;
      }
    }

    // --- AUDIO: Footsteps (triggered every ~0.45s while moving) ---
    const isMoving = keyState.KeyW || keyState.KeyA || keyState.KeyS || keyState.KeyD;
    if (isMoving) {
      audioState.footstepTimer += delta;
      if (audioState.footstepTimer > 0.45) {
        audioState.footstepTimer = 0;
        playFootstep();
      }
    } else {
      audioState.footstepTimer = 0;
    }

    // --- AUDIO: TV static intensity based on stare ---
    const staticLevel = stareTime / STARE_TIME_MAX;
    setStaticIntensity(staticLevel);
  }

  // --- ABDUCTION cinematic (outside isLocked check — must run even after unlock) ---
  updateAbduction(delta);
  if (gameState === 'ABDUCTING') { renderer.render(scene, camera); return; }

  // --- RENDER ---
  renderer.render(scene, camera);
}

// ============================================================================
// G002: ATMOSPHERE & LIGHTING — Night farm, fog, flashlight
// ============================================================================
// All lighting and atmosphere parameters are centralized here for easy art tuning.
// When replacing greybox with final models, adjust these values to taste.

// --- SKY / BACKGROUND ---
// Deep night sky — near-black with faint navy tint.
scene.background = new THREE.Color(0x050510);
scene.fog = new THREE.FogExp2(0x0a0a18, 0.04); // Exponential fog: dark blue-grey, playable PSX-style

// --- AMBIENT LIGHT ---
// Minimal global illumination — bumped for PSX branch to compensate for
// quantization. 0.6 intensity + 0x222244 gives enough silhouette definition.
const ambientLight = new THREE.AmbientLight(0x222244, 0.6);
scene.add(ambientLight);

// --- MOONLIGHT (faint directional) ---
// Increased to 0.8 for PSX branch — provides a cold blue wash over the scene.
const moonLight = new THREE.DirectionalLight(0x8899cc, 0.8);
moonLight.position.set(30, 50, -20);
moonLight.castShadow = true;
moonLight.shadow.mapSize.width = 1024;
moonLight.shadow.mapSize.height = 1024;
moonLight.shadow.camera.near = 1;
moonLight.shadow.camera.far = 100;
moonLight.shadow.camera.left = -40;
moonLight.shadow.camera.right = 40;
moonLight.shadow.camera.top = 40;
moonLight.shadow.camera.bottom = -40;
scene.add(moonLight);

// --- GROUND PLANE (farm earth) ---
// Dark soil with slight green-brown tint. Large enough to cover the entire play area.
// Receives shadows from the flashlight and moonlight.
const groundGeometry = new THREE.PlaneGeometry(80, 80);
const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a2a14,
  roughness: 0.95,
  metalness: 0.0,
  flatShading: true,
});
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
ground.name = 'farmGround';
scene.add(ground);

// --- FLASHLIGHT (SpotLight attached to camera) ---
// Narrow cone angle (~18°) restricts peripheral vision, forcing the player to
// actively scan. Yellow-white temperature (0xfff8e7) for incandescent flashlight feel.
// Penumbra 0.3 gives soft edges — realistic flashlight falloff.
// Decay 1.5 ensures light doesn't reach too far through the fog.
const flashlight = new THREE.SpotLight(0xfff8e7, 60, 30, Math.PI / 7, 0.3, 1.2);
//                                    color     int dist cone(~25°) pen  decay
// Bumped intensity 45→60, cone π/10→π/7 (wider beam for PSX visibility),
// distance 25→30, decay 1.5→1.2 (reaches further through fog).
flashlight.position.set(0, 0, 0); // Relative to camera — updated each frame
flashlight.target.position.set(0, 0, -1); // Points forward from camera
flashlight.castShadow = true;
flashlight.shadow.mapSize.width = 512;
flashlight.shadow.mapSize.height = 512;
flashlight.shadow.camera.near = 0.3;
flashlight.shadow.camera.far = 30;
flashlight.shadow.camera.fov = 20;
flashlight.name = 'flashlight';

// Flashlight must be added to both scene and camera so it moves with the player.
camera.add(flashlight);
camera.add(flashlight.target);
scene.add(flashlight);
scene.add(flashlight.target);

// ============================================================================
// VISUAL ENHANCEMENT: Atmospheric dust particles in flashlight beam
// ============================================================================
// Floating dust motes that drift inside the flashlight cone — classic horror
// atmosphere. Particles are regenerated at random positions within the cone
// and slowly drift upward/outward, creating a living, breathing beam effect.
// Each particle is a small white sprite with soft edges.

const PARTICLE_COUNT = 400;
const PARTICLE_CONE_ANGLE = Math.PI / 9;   // Slightly wider than flashlight for natural spread
const PARTICLE_MAX_DIST = 22;               // Max distance from camera
const PARTICLE_DRIFT_SPEED = 0.4;           // Base upward drift speed
const PARTICLE_SIZE = 0.06;                 // Sprite size

// Create circular gradient texture for soft dust particles
const particleCanvas = document.createElement('canvas');
particleCanvas.width = 32;
particleCanvas.height = 32;
const pctx = particleCanvas.getContext('2d');
const gradient = pctx.createRadialGradient(16, 16, 0, 16, 16, 16);
gradient.addColorStop(0, 'rgba(255,250,230,0.9)');
gradient.addColorStop(0.15, 'rgba(255,245,210,0.6)');
gradient.addColorStop(0.4, 'rgba(255,240,180,0.2)');
gradient.addColorStop(0.7, 'rgba(200,180,120,0.03)');
gradient.addColorStop(1, 'rgba(0,0,0,0)');
pctx.fillStyle = gradient;
pctx.fillRect(0, 0, 32, 32);
const particleTexture = new THREE.CanvasTexture(particleCanvas);
particleTexture.magFilter = THREE.NearestFilter;
particleTexture.minFilter = THREE.NearestFilter;

// Particle geometry and state
const particleGeom = new THREE.BufferGeometry();
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const particleData = []; // { age, maxAge, speed, baseAngle, radius }

// Initialize particles at random positions within the flashlight cone
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const angle = Math.random() * PARTICLE_CONE_ANGLE;
  const azimuth = Math.random() * Math.PI * 2;
  const radius = 0.5 + Math.random() * PARTICLE_MAX_DIST;

  // Convert spherical cone coordinates to Cartesian (Z-forward)
  const r = Math.tan(angle) * radius;
  particlePositions[i * 3] = Math.cos(azimuth) * r;     // X (lateral)
  particlePositions[i * 3 + 1] = Math.sin(azimuth) * r;  // Y (vertical)
  particlePositions[i * 3 + 2] = -radius;                 // Z (forward, negative)

  particleData.push({
    maxAge: 3 + Math.random() * 8,          // Lifetime before reset
    age: Math.random() * 8,                  // Start at random ages
    speed: 0.2 + Math.random() * PARTICLE_DRIFT_SPEED,
    baseAngle: azimuth,
    baseRadius: r,
  });
}

particleGeom.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

const particleMat = new THREE.PointsMaterial({
  size: PARTICLE_SIZE,
  map: particleTexture,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
  opacity: 0.6,
  color: 0xfff8e0,
});

const dustParticles = new THREE.Points(particleGeom, particleMat);
dustParticles.name = 'dustParticles';
// Attach particles to camera so they move with the player
camera.add(dustParticles);

console.log(`  Particles: ${PARTICLE_COUNT} dust motes in flashlight beam`);

// ============================================================================
// VISUAL ENHANCEMENT: Moon + starfield
// ============================================================================
// A large pale moon disc suspended high in the sky and a field of twinkling
// stars created with a Points geometry. These provide silhouette definition
// against the otherwise pitch-black sky.

// --- Moon ---
const moonGeom = new THREE.CircleGeometry(3, 16);   // Low-poly: 16 sides instead of 32
const moonMat = new THREE.MeshBasicMaterial({
  color: 0xfffff0,    // Brighter for PSX branch
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.85,      // Increased from 0.7
});
const moon = new THREE.Mesh(moonGeom, moonMat);
moon.position.set(25, 42, -35);
// Tilt moon to face the play area
moon.lookAt(new THREE.Vector3(0, 42, 0));
moon.name = 'moon';
scene.add(moon);

// Subtle moon glow halo
const haloGeom = new THREE.CircleGeometry(4.5, 16);  // Low-poly: 16 sides
const haloMat = new THREE.MeshBasicMaterial({
  color: 0xccccdd,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.12,
});
const halo = new THREE.Mesh(haloGeom, haloMat);
halo.position.copy(moon.position);
halo.lookAt(new THREE.Vector3(0, 42, 0));
halo.name = 'moonHalo';
scene.add(halo);

// --- Starfield ---
const STAR_COUNT = 600;
const starGeom = new THREE.BufferGeometry();
const starPositions = new Float32Array(STAR_COUNT * 3);
const starSizes = new Float32Array(STAR_COUNT);

for (let i = 0; i < STAR_COUNT; i++) {
  // Random position on a large hemisphere above the scene
  const theta = Math.random() * Math.PI * 0.48; // Not quite to horizon
  const phi = Math.random() * Math.PI * 2;
  const r = 55 + Math.random() * 20;
  starPositions[i * 3] = Math.sin(theta) * Math.cos(phi) * r;
  starPositions[i * 3 + 1] = Math.cos(theta) * r + 10; // Shifted up
  starPositions[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
  starSizes[i] = 0.3 + Math.random() * 1.2; // Varying brightness
}

starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
starGeom.setAttribute('size', new THREE.BufferAttribute(starSizes, 1));

// Create tiny star sprite texture
const starCanvas = document.createElement('canvas');
starCanvas.width = 8;
starCanvas.height = 8;
const sctx = starCanvas.getContext('2d');
const sg = sctx.createRadialGradient(4, 4, 0, 4, 4, 4);
sg.addColorStop(0, 'rgba(255,255,255,1)');
sg.addColorStop(0.2, 'rgba(255,255,255,0.8)');
sg.addColorStop(0.5, 'rgba(200,210,255,0.2)');
sg.addColorStop(1, 'rgba(0,0,0,0)');
sctx.fillStyle = sg;
sctx.fillRect(0, 0, 8, 8);
const starTexture = new THREE.CanvasTexture(starCanvas);
starTexture.magFilter = THREE.NearestFilter;
starTexture.minFilter = THREE.NearestFilter;

const starMat = new THREE.PointsMaterial({
  size: 0.7,          // Slightly larger for PSX resolution
  map: starTexture,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
  opacity: 0.9,        // Brighter
  color: 0xccddff,
});

const stars = new THREE.Points(starGeom, starMat);
stars.name = 'starfield';
scene.add(stars);

console.log(`  Sky: moon + ${STAR_COUNT} stars`);

// ============================================================================
// G003: CORNFIELD — InstancedMesh with 3600 stalks
// ============================================================================
// The cornfield uses InstancedMesh for performance: one draw call for all stalks.
// Each stalk is a slightly tapered cylinder with randomized height, scale, and
// Y-rotation. The stalks are placed in a grid with a central clearing for the
// player spawn and scattered gaps for anomalies.
//
// TUNING PARAMETERS (adjust when replacing with models):
//   - STALK_HEIGHT: base stalk height in units
//   - STALK_WIDTH: width based on sprite aspect ratio (195/439 ≈ 0.444)

const STALK_COUNT = 3600;
const FIELD_HALF = 45;
const SPACING = 1.5;
const CLEARING_RADIUS = 5;
const STALK_HEIGHT = 4.5;
const STALK_WIDTH = STALK_HEIGHT * (195 / 439); // ~2.0 — matches corn.png aspect

// --- PRNG ---
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);

// --- Stalk geometry: flat plane with correct aspect ratio ---
// MeshStandardMaterial reacts to lighting (flashlight, ambient, moon).
const stalkGeom = new THREE.PlaneGeometry(STALK_WIDTH, STALK_HEIGHT);

// --- Material with corn.png texture ---
// Starts with a solid color until the sprite loads.
const stalkMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.85,
  metalness: 0.0,
  flatShading: true,
  side: THREE.DoubleSide,
  transparent: true,       // Required: honor alpha channel from texture
  alphaTest: 0.1,          // Discard nearly-transparent fragments
});

// --- InstancedMesh ---
const cornfield = new THREE.InstancedMesh(stalkGeom, stalkMat, STALK_COUNT);
cornfield.castShadow = true;
cornfield.receiveShadow = true;
cornfield.name = 'cornfield';

// --- Load corn sprite and apply as texture ---
const cornImage = new Image();
cornImage.src = 'sprites/corn.png';
cornImage.onload = () => {
  console.log(`[Sprite] Corn stalk loaded: ${cornImage.naturalWidth}x${cornImage.naturalHeight}`);

  // Draw onto canvas for brightness boost
  const w = cornImage.naturalWidth;
  const h = cornImage.naturalHeight;
  const texCanvas = document.createElement('canvas');
  texCanvas.width = w;
  texCanvas.height = h;
  const tctx = texCanvas.getContext('2d');
  tctx.drawImage(cornImage, 0, 0);

  // Boost brightness 2x — helps stalks stand out at night
  const imgData = tctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) continue;
    data[p]     = Math.min(255, data[p] * 2.0);
    data[p + 1] = Math.min(255, data[p + 1] * 2.0);
    data[p + 2] = Math.min(255, data[p + 2] * 2.0);
  }
  tctx.putImageData(imgData, 0, 0);

  const cornTexture = new THREE.CanvasTexture(texCanvas);
  cornTexture.magFilter = THREE.NearestFilter;
  cornTexture.minFilter = THREE.NearestFilter;
  cornTexture.generateMipmaps = false;

  stalkMat.map = cornTexture;
  stalkMat.color.set(0xffffff); // White — texture provides the color
  stalkMat.needsUpdate = true;
};

// --- Instance matrices ---
const dummy = new THREE.Object3D();
const stalkPositions = [];
let placedCount = 0;
const gridCells = Math.ceil((FIELD_HALF * 2) / SPACING);

for (let ix = 0; ix < gridCells && placedCount < STALK_COUNT; ix++) {
  for (let iz = 0; iz < gridCells && placedCount < STALK_COUNT; iz++) {
    const wx = (ix - gridCells / 2) * SPACING;
    const wz = (iz - gridCells / 2) * SPACING;
    const distFromCenter = Math.sqrt(wx * wx + wz * wz);
    if (distFromCenter < CLEARING_RADIUS) continue;
    if (rng() < 0.15) continue;

    const offsetX = (rng() - 0.5) * 0.6;
    const offsetZ = (rng() - 0.5) * 0.6;
    const posX = wx + offsetX;
    const posZ = wz + offsetZ;
    const rotY = rng() * Math.PI * 2;
    const scaleY = 0.85 + rng() * 0.3;
    const scaleXZ = 0.8 + rng() * 0.4;

    dummy.position.set(posX, (STALK_HEIGHT / 2) * scaleY, posZ);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(scaleXZ, scaleY, 1); // Keep Z=1 — planes are flat
    dummy.updateMatrix();
    cornfield.setMatrixAt(placedCount, dummy.matrix);

    stalkPositions.push({ x: posX, z: posZ });
    placedCount++;
  }
}

cornfield.count = placedCount;
cornfield.instanceMatrix.needsUpdate = true;
cornfield.frustumCulled = true;
scene.add(cornfield);

console.log(`  Cornfield: ${placedCount} textured-plane stalks (corn.png sprite)`);

// ============================================================================
// VISUAL ENHANCEMENT: Farmhouse + ground details
// ============================================================================
// Simple geometric buildings and ground scatter to give the central clearing
// a sense of place — a farm in the middle of nowhere. All greybox primitives
// ready to be replaced with proper models.

// --- FARMHOUSE ---
// A simple two-story house: box body + triangular prism roof.
// Positioned at the edge of the clearing, slightly behind the player spawn.
const houseGroup = new THREE.Group();
houseGroup.name = 'farmhouse';

// Main body
const houseBody = new THREE.Mesh(
  new THREE.BoxGeometry(5, 3.5, 4),
  new THREE.MeshStandardMaterial({ color: 0x3a3025, roughness: 0.9 })
);
houseBody.position.y = 1.75;
houseBody.castShadow = true;
houseBody.receiveShadow = true;
houseGroup.add(houseBody);

// Roof — triangular prism using a custom geometry (simple wedge)
const roofGeom = new THREE.BufferGeometry();
const roofVerts = new Float32Array([
  // Front triangle
  -2.8, 3.5, 2.2,   2.8, 3.5, 2.2,   0, 5.5, 2.2,
  // Back triangle
  -2.8, 3.5, -2.2,  0, 5.5, -2.2,   2.8, 3.5, -2.2,
  // Left slope
  -2.8, 3.5, 2.2,   0, 5.5, 2.2,    0, 5.5, -2.2,
  -2.8, 3.5, 2.2,   0, 5.5, -2.2,  -2.8, 3.5, -2.2,
  // Right slope
  2.8, 3.5, 2.2,    0, 5.5, -2.2,   0, 5.5, 2.2,
  2.8, 3.5, 2.2,    2.8, 3.5, -2.2, 0, 5.5, -2.2,
]);
roofGeom.setAttribute('position', new THREE.BufferAttribute(roofVerts, 3));
roofGeom.computeVertexNormals();
const roof = new THREE.Mesh(roofGeom, new THREE.MeshStandardMaterial({
  color: 0x1a1210, roughness: 0.95
}));
roof.castShadow = true;
roof.receiveShadow = true;
houseGroup.add(roof);

// Dark window squares — emissive faint blue (moonlight reflection)
const winMat = new THREE.MeshStandardMaterial({
  color: 0x0a0a15, emissive: 0x0a0a20, emissiveIntensity: 0.3, roughness: 0.3
});
const winGeom = new THREE.PlaneGeometry(0.6, 0.8);
// Front windows
const win1 = new THREE.Mesh(winGeom, winMat);
win1.position.set(-1.3, 2.0, 2.01);
houseGroup.add(win1);
const win2 = new THREE.Mesh(winGeom, winMat);
win2.position.set(1.3, 2.0, 2.01);
houseGroup.add(win2);

// Door
const door = new THREE.Mesh(
  new THREE.PlaneGeometry(1.0, 2.0),
  new THREE.MeshStandardMaterial({ color: 0x1a0f08, roughness: 0.9 })
);
door.position.set(0, 1.0, 2.01);
houseGroup.add(door);

houseGroup.position.set(0, 0, -8);
scene.add(houseGroup);

// --- BARN ---
// Smaller, wider structure to the right of the house.
const barnGroup = new THREE.Group();
barnGroup.name = 'barn';

const barnBody = new THREE.Mesh(
  new THREE.BoxGeometry(6, 3, 5),
  new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.92 })
);
barnBody.position.y = 1.5;
barnBody.castShadow = true;
barnBody.receiveShadow = true;
barnGroup.add(barnBody);

// Barn roof — flat gable
const barnRoof = new THREE.Mesh(
  new THREE.BoxGeometry(6.4, 0.3, 5.4),
  new THREE.MeshStandardMaterial({ color: 0x100a08, roughness: 0.95 })
);
barnRoof.position.y = 3.15;
barnRoof.castShadow = true;
barnGroup.add(barnRoof);

barnGroup.position.set(8, 0, -5);
scene.add(barnGroup);

// --- SCATTERED DEBRIS ---
// Small rocks and crates scattered around the clearing for visual texture.
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x252018, roughness: 0.95 });
const debrisColors = [0x252018, 0x302515, 0x1a1510];
const debrisItems = [
  { type: 'rock', x: 3.5, z: 3, s: 0.4 },
  { type: 'rock', x: -4, z: 4.5, s: 0.6 },
  { type: 'crate', x: 5, z: -2, s: 0.8 },
  { type: 'rock', x: -5.5, z: -3, s: 0.3 },
  { type: 'crate', x: -2, z: 6, s: 0.6 },
  { type: 'rock', x: 6.5, z: 5, s: 0.5 },
  { type: 'crate', x: -6, z: 1, s: 0.7 },
  { type: 'rock', x: 2, z: -5, s: 0.45 },
];

for (const item of debrisItems) {
  let mesh;
  if (item.type === 'rock') {
    // Irregular rock — dodecahedron scaled randomly
    mesh = new THREE.Mesh(
      new THREE.DodecahedronGeometry(item.s, 0),
      new THREE.MeshStandardMaterial({
        color: debrisColors[Math.floor(Math.random() * 3)],
        roughness: 0.95,
      })
    );
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  } else {
    // Wooden crate — box
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(item.s, item.s, item.s),
      new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.9 })
    );
  }
  mesh.position.set(item.x, item.s * 0.4, item.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// --- FENCE POSTS ---
// Simple post fence around the clearing perimeter — visual boundary marker.
const postGeom = new THREE.BoxGeometry(0.15, 1.2, 0.15);
const postMat = new THREE.MeshStandardMaterial({ color: 0x1a120a, roughness: 0.95 });
const fenceRadius = 7;
const fencePosts = 16;
for (let i = 0; i < fencePosts; i++) {
  const angle = (i / fencePosts) * Math.PI * 2;
  const px = Math.cos(angle) * fenceRadius;
  const pz = Math.sin(angle) * fenceRadius;
  const post = new THREE.Mesh(postGeom, postMat);
  post.position.set(px, 0.6, pz);
  post.rotation.y = Math.random() * 0.3 - 0.15; // Slight lean for age
  post.castShadow = true;
  post.receiveShadow = true;
  scene.add(post);
}

console.log('  Structures: farmhouse + barn + 8 debris items + 16 fence posts');

// ============================================================================
// EASTER EGG: Low-poly cow (PSX style) — click to hear moo
// ============================================================================
// A Holstein cow built from geometric primitives. Hidden in the cornfield.
// Click detection via raycaster. Moo sound loaded via Howler.js.
//
// Proportions: body length ~1.5u, height to back ~1.2u, total height ~1.5u.

const cow = new THREE.Group();
cow.name = 'cow';

// Materials
const cowWhite = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.8, flatShading: true });
const cowBlack = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8, flatShading: true });
const cowPink  = new THREE.MeshStandardMaterial({ color: 0xcc9988, roughness: 0.9, flatShading: true });

// Body — main torso, taller than before (1.0u vs 0.7u) to fix squished look
const cowBody = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.9), cowWhite);
cowBody.position.y = 0.7;
cowBody.castShadow = true;
cow.add(cowBody);

// Black patch on body (big spot)
const patch1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.5), cowBlack);
patch1.position.set(0.25, 1.0, 0);
cow.add(patch1);

const patch2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.35), cowBlack);
patch2.position.set(-0.35, 1.05, -0.2);
cow.add(patch2);

// Head — at front of body, same height as top of body
const cowHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.6), cowWhite);
cowHead.position.set(0, 1.0, 0.8);
cowHead.castShadow = true;
cow.add(cowHead);

// Snout — pink square at front of head
const snout = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.15), cowPink);
snout.position.set(0, 0.9, 1.1);
cow.add(snout);

// Eyes — tiny black spheres on head sides
const cowEyeGeom = new THREE.SphereGeometry(0.05, 4, 4);
const eyeL = new THREE.Mesh(cowEyeGeom, cowBlack);
eyeL.position.set(-0.15, 1.15, 1.0);
cow.add(eyeL);
const eyeR = new THREE.Mesh(cowEyeGeom, cowBlack);
eyeR.position.set(0.15, 1.15, 1.0);
cow.add(eyeR);

// Legs — 4 thin cylinders, shorter than before (0.6u vs 0.7u), better proportion
const cowLegGeom = new THREE.CylinderGeometry(0.1, 0.1, 0.6, 6);
const legPositions = [
  [-0.5, 0.45, -0.25], [0.5, 0.45, -0.25],
  [-0.5, 0.45, 0.25],  [0.5, 0.45, 0.25],
];
for (const [lx, ly, lz] of legPositions) {
  const leg = new THREE.Mesh(cowLegGeom, cowWhite);
  leg.position.set(lx, ly, lz);
  leg.castShadow = true;
  cow.add(leg);
  // Small black hoof at bottom of leg
  const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.12), cowBlack);
  hoof.position.set(lx, 0.12, lz);
  cow.add(hoof);
}

// Horns — two tiny cones on top of head
const cowHornGeom = new THREE.ConeGeometry(0.04, 0.2, 4);
const hornL = new THREE.Mesh(cowHornGeom, cowBlack);
hornL.position.set(-0.15, 1.3, 0.75);
hornL.rotation.z = 0.5;
cow.add(hornL);
const hornR = new THREE.Mesh(cowHornGeom, cowBlack);
hornR.position.set(0.15, 1.3, 0.75);
hornR.rotation.z = -0.5;
cow.add(hornR);

// Udder — small pink sphere between hind legs
const udder = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), cowPink);
udder.position.set(0, 0.45, -0.35);
cow.add(udder);

// Tail — thin cylinder at rear
const tailStick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 4), cowBlack);
tailStick.position.set(0, 0.7, -0.55);
tailStick.rotation.x = -0.5;
cow.add(tailStick);

// Place cow in the cornfield — discovery spot far from the farmhouse
cow.position.set(20, 0.02, -18);
cow.rotation.y = -1.2;
scene.add(cow);

console.log('  🐄 Cow placed in cornfield at (20, -18) — go find her!');

// ============================================================================
// G004: ANOMALIES — 5 collectible objects hidden in the cornfield
// ============================================================================
// Five anomalous objects with distinct geometric shapes and glowing/emissive
// materials. Each emits a faint PointLight to be visible through the fog.
// Placed at fixed positions within the cornfield, away from the central clearing.
//
// When the player gets within COLLECT_DISTANCE units, the anomaly is collected:
// it becomes invisible and its light extinguishes.
//
// TUNING PARAMETERS:
//   - COLLECT_DISTANCE: proximity threshold for collection (units)
//   - ANOMALY_GLOW_RADIUS: how far the PointLight reaches through fog
//   - ANOMALY_GLOW_INTENSITY: brightness of the PointLight

const COLLECT_DISTANCE = 2.0;
const ANOMALY_GLOW_RADIUS = 8;
const ANOMALY_GLOW_INTENSITY = 2.5;

const anomalies = [];

/**
 * Create a single anomaly with a unique geometry and emissive material.
 * @param {THREE.BufferGeometry} geometry — distinct shape for this anomaly
 * @param {number} color — emissive/glow color (hex)
 * @param {number} x, z — world position (y is auto-set to ~1.5 above ground)
 * @param {string} name — label for debugging
 */
function createAnomaly(geometry, color, x, z, name) {
  // Emissive material — appears self-illuminated even in low ambient light
  const material = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 1.5,
    roughness: 0.3,
    metalness: 0.5,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, 1.5, z); // Float at eye-ish height
  mesh.castShadow = true;
  mesh.name = name;
  scene.add(mesh);

  // PointLight for visibility through fog — creates an eerie glow halo
  const glowLight = new THREE.PointLight(color, ANOMALY_GLOW_INTENSITY, ANOMALY_GLOW_RADIUS);
  glowLight.position.copy(mesh.position);
  scene.add(glowLight);

  const anomaly = {
    mesh,
    glowLight,
    collected: false,
    name,
    position: { x, z },
    rotSpeed: 0.3 + Math.random() * 0.7,      // Radians/sec — each spins differently
    pulseFreq: 1.5 + Math.random() * 2.5,       // Hz — each pulses at different rate
  };
  anomalies.push(anomaly);

  console.log(`  Anomaly placed: ${name} at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  return anomaly;
}

// --- Place 5 anomalies at scattered positions within the cornfield ---
// Each uses a distinct geometric primitive for easy greybox identification.
// Positions are chosen to be deep enough in the field to require exploration,
// but not overlapping the central clearing (radius 5).

// 1. Sphere — floating orb, pale blue glow
createAnomaly(
  new THREE.SphereGeometry(0.5, 8, 8),   // Low-poly: 8x8 instead of 16x16
  0x4488ff,
  FIELD_HALF * 0.6,   // ~27 units out
  FIELD_HALF * 0.5,   // ~22 units out
  'Orb of Whispers'
);

// 2. Torus Knot — intricate twisted ring, sickly green
createAnomaly(
  new THREE.TorusKnotGeometry(0.4, 0.1, 32, 6, 2, 3),  // Low-poly: 32x6 instead of 64x8
  0x44ff44,
  -FIELD_HALF * 0.55,
  FIELD_HALF * 0.65,
  'Verdant Knot'
);

// 3. Icosahedron — crystalline shard, violet pulse
createAnomaly(
  new THREE.IcosahedronGeometry(0.5, 0),
  0x9944ff,
  FIELD_HALF * 0.7,
  -FIELD_HALF * 0.4,
  'Violet Shard'
);

// 4. Cone — triangular beacon, amber warning
createAnomaly(
  new THREE.ConeGeometry(0.4, 1.0, 8, 1),
  0xffaa22,
  -FIELD_HALF * 0.4,
  -FIELD_HALF * 0.7,
  'Amber Spire'
);

// 5. Dodecahedron — complex polyhedron, blood red
createAnomaly(
  new THREE.DodecahedronGeometry(0.45, 0),
  0xff3344,
  -FIELD_HALF * 0.15,
  -FIELD_HALF * 0.2,
  'Crimson Polyhedron'
);

// ============================================================================
// G005: STALKER — Alien entity with chase AI, stare mechanic, and visibility
// ============================================================================
// The stalker is a tall, dark, elongated figure with glowing eyes that pursues
// the player through the cornfield. It becomes visible only when illuminated
// by the flashlight or when extremely close.
//
// GAME OVER triggers on:
//   (A) CONTACT — stalker distance < STALKER_KILL_DISTANCE
//   (B) STARE   — player looks directly at stalker for > STARE_TIME_MAX seconds
//
// TUNING PARAMETERS:
//   - STALKER_SPEED_FAR / STALKER_SPEED_CLOSE: chase speed at range
//   - STALKER_KILL_DISTANCE: contact Game Over threshold
//   - STALKER_VISIBLE_DISTANCE: always visible when closer than this
//   - STALKER_FLASHLIGHT_CONE: visible when within flashlight angle
//   - STARE_DOT_THRESHOLD: how directly player must look (1.0 = perfect center)
//   - STARE_TIME_MAX: seconds of staring before Game Over
//   - STARE_DECAY_RATE: how fast stare meter empties when looking away

const STALKER_SPEED_FAR = 2.5;        // Speed when far from player (units/sec)
const STALKER_SPEED_CLOSE = 5.0;      // Speed when very close (units/sec)
const STALKER_KILL_DISTANCE = 1.5;    // Contact kill radius
const STALKER_VISIBLE_DISTANCE = 6.0; // Always visible within this range
const STALKER_FLASHLIGHT_CONE = Math.PI / 10; // Same as flashlight cone (18°)
const STARE_DOT_THRESHOLD = 0.75;     // cos(angle) — ~41° cone of "looking at"
const STARE_TIME_MAX = 4.0;           // Seconds before Game Over from staring
const STARE_DECAY_RATE = 1.5;         // How fast stare decays when looking away

// --- Stalker state ---
let stareTime = 0.0;

// ============================================================================
// G005 VISUAL REWORK: Classic Grey Alien (green variant) — CORRECTED PROPORTIONS
// ============================================================================
// Proportions based on classic Grey alien depictions (Communion cover,
// Roswell descriptions, pop culture): head ~28% of total height, thin body,
// large almond eyes. Total height: ~4.0 units.
//
// Reference: en.wikipedia.org/wiki/Grey_alien
// "disproportionately large heads" but NOT 50%+ — typically 25-30% of height.
// Eyes are "very large, opaque, black" — about 30% of face height.
// Body "small chest, lacking muscular definition", legs "shorter".

const stalkerGroup = new THREE.Group();
stalkerGroup.name = 'stalker';

// --- Material definitions ---
const skinGreen = new THREE.MeshStandardMaterial({
  color: 0x3d7a2e, roughness: 0.7, metalness: 0.05, flatShading: true,
});
const limbGreen = new THREE.MeshStandardMaterial({
  color: 0x2a5a1e, roughness: 0.75, metalness: 0.05, flatShading: true,
});
const eyeBlack = new THREE.MeshStandardMaterial({
  color: 0x020202, roughness: 0.1, metalness: 0.0, flatShading: true,
});

// --- HEAD: bulbous ellipsoid, ~1.15 units tall (~28% of 4.0 total) ---
// Radius 0.5, Y scale 1.15 → diameter 1.0 × 1.15 = 1.15u head height.
// Slightly squished on X, narrow front-to-back (teardrop shape).
const headGeom = new THREE.SphereGeometry(0.5, 10, 8);
const headMesh = new THREE.Mesh(headGeom, skinGreen);
headMesh.scale.set(0.85, 1.15, 0.7);
headMesh.position.y = 3.25;
headMesh.castShadow = true;
headMesh.name = 'stalkerHead';
stalkerGroup.add(headMesh);

// --- EYES: large almond-shaped black ovals (~30% of face) ---
// Radius 0.22 × scale 1.4 → ~0.62 wide, ~0.22 tall — classic almond shape.
const eyeGeom = new THREE.SphereGeometry(0.22, 8, 6);
const eyeLeftMesh = new THREE.Mesh(eyeGeom, eyeBlack);
eyeLeftMesh.scale.set(1.4, 0.85, 0.3);
eyeLeftMesh.position.set(-0.25, 3.45, 0.28);
eyeLeftMesh.name = 'stalkerEyeL';
stalkerGroup.add(eyeLeftMesh);

const eyeRightMesh = new THREE.Mesh(eyeGeom, eyeBlack);
eyeRightMesh.scale.set(1.4, 0.85, 0.3);
eyeRightMesh.position.set(0.25, 3.45, 0.28);
eyeRightMesh.name = 'stalkerEyeR';
stalkerGroup.add(eyeRightMesh);

// Eye glow lights — green, visible through fog
const eyeGlowL = new THREE.PointLight(0x44aa22, 0.8, 4, 2);
eyeGlowL.position.copy(eyeLeftMesh.position);
stalkerGroup.add(eyeGlowL);
const eyeGlowR = new THREE.PointLight(0x44aa22, 0.8, 4, 2);
eyeGlowR.position.copy(eyeRightMesh.position);
stalkerGroup.add(eyeGlowR);
const eyeGlowLight = new THREE.PointLight(0x55cc33, 2.0, 12, 2);
eyeGlowLight.position.set(0, 3.45, 0.28);
eyeGlowLight.name = 'stalkerEyeGlow';
stalkerGroup.add(eyeGlowLight);

// --- NECK: thin connector, ~0.2u ---
const neckGeom = new THREE.CylinderGeometry(0.08, 0.12, 0.25, 6);
const neck = new THREE.Mesh(neckGeom, limbGreen);
neck.position.y = 2.55;
neck.name = 'stalkerNeck';
stalkerGroup.add(neck);

// --- BODY: thin tapered torso, ~1.05u (25% of height) ---
const bodyGeom = new THREE.CylinderGeometry(0.22, 0.28, 1.05, 8);
const bodyMesh = new THREE.Mesh(bodyGeom, skinGreen);
bodyMesh.position.y = 1.85;
bodyMesh.castShadow = true;
bodyMesh.name = 'stalkerBody';
stalkerGroup.add(bodyMesh);

// --- ARMS: thin, reach to mid-thigh, ~1.3u each ---
const armGeom = new THREE.CylinderGeometry(0.06, 0.05, 1.3, 6);
const armL = new THREE.Mesh(armGeom, limbGreen);
armL.position.set(-0.36, 1.75, 0);
armL.rotation.z = 0.25;
armL.castShadow = true;
armL.name = 'stalkerArmL';
stalkerGroup.add(armL);
const armR = new THREE.Mesh(armGeom, limbGreen);
armR.position.set(0.36, 1.75, 0);
armR.rotation.z = -0.25;
armR.castShadow = true;
armR.name = 'stalkerArmR';
stalkerGroup.add(armR);

// --- LEGS: short, thin, ~1.1u each ---
const legGeom = new THREE.CylinderGeometry(0.08, 0.06, 1.1, 6);
const legL = new THREE.Mesh(legGeom, limbGreen);
legL.position.set(-0.16, 0.5, 0);
legL.castShadow = true;
legL.name = 'stalkerLegL';
stalkerGroup.add(legL);
const legR = new THREE.Mesh(legGeom, limbGreen);
legR.position.set(0.16, 0.5, 0);
legR.castShadow = true;
legR.name = 'stalkerLegR';
stalkerGroup.add(legR);

// --- Spawn stalker at a random map edge position ---
// Spawns on the map boundary, at least 20 units from player.
function randomEdgePosition() {
  const edge = Math.floor(Math.random() * 4); // 0=N, 1=S, 2=E, 3=W
  const halfField = FIELD_HALF - 2;
  let x, z;
  switch (edge) {
    case 0: x = (Math.random() - 0.5) * halfField * 2; z = halfField; break;
    case 1: x = (Math.random() - 0.5) * halfField * 2; z = -halfField; break;
    case 2: x = halfField; z = (Math.random() - 0.5) * halfField * 2; break;
    case 3: x = -halfField; z = (Math.random() - 0.5) * halfField * 2; break;
  }
  return { x, z };
}

const spawnPos = randomEdgePosition();
stalkerGroup.position.set(spawnPos.x, 0.05, spawnPos.z);

// Scale entire alien to Grey-appropriate height: ~1.4u (~35% of original 4.0u).
// Classic Greys are 1.0-1.5m — at or below the player's eye level (1.7u).
// This puts the top of the alien's head roughly at the player's chest.
stalkerGroup.scale.set(0.35, 0.35, 0.35);

scene.add(stalkerGroup);

console.log(`  Stalker spawned at (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);

// --- Helper: direction from stalker to player (XZ plane) ---
const stalkerToPlayer = new THREE.Vector3();
const playerToStalker = new THREE.Vector3();
const stalkerPos = new THREE.Vector3();

/**
 * Update stalker AI each frame: move toward player, track stare, check kills.
 * @param {number} delta — frame delta time in seconds
 * @param {THREE.Vector3} playerForward — camera forward direction (XZ)
 */
function updateStalker(delta, playerForward) {
  // Get stalker and player positions (XZ plane, ignore Y)
  const sx = stalkerGroup.position.x;
  const sz = stalkerGroup.position.z;
  const px = camera.position.x;
  const pz = camera.position.z;

  // --- Distance check ---
  const dx = px - sx;
  const dz = pz - sz;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // --- GAME OVER: CONTACT ---
  if (dist < STALKER_KILL_DISTANCE) {
    triggerGameOver('The stalker caught you.');
    return;
  }

  // --- GAME OVER: STARE (checked below) ---
  if (stareTime >= STARE_TIME_MAX) {
    triggerGameOver('You stared too long into the void.');
    return;
  }

  // --- CHASE AI: move toward player ---
  // Speed scales with proximity: faster when closer (tension ramp)
  const speedRange = STALKER_SPEED_CLOSE - STALKER_SPEED_FAR;
  const proximityFactor = Math.max(0, 1 - dist / 30); // 0 at 30+ units, 1 at 0
  const speed = STALKER_SPEED_FAR + speedRange * proximityFactor;

  // Move stalker toward player (XZ only, stalker stays on ground)
  if (dist > 0.01) {
    const moveX = (dx / dist) * speed * delta;
    const moveZ = (dz / dist) * speed * delta;
    stalkerGroup.position.x += moveX;
    stalkerGroup.position.z += moveZ;
  }

  // --- VISIBILITY: stalker only visible in flashlight or very close ---
  const visible = isStalkerVisible(dist);
  headMesh.visible = visible;
  bodyMesh.visible = visible;
  eyeLeftMesh.visible = visible;
  eyeRightMesh.visible = visible;
  neck.visible = visible;
  armL.visible = visible;
  armR.visible = visible;
  legL.visible = visible;
  legR.visible = visible;
  eyeGlowLight.intensity = visible ? 2.0 : 0;
  eyeGlowL.intensity = visible ? 0.8 : 0;
  eyeGlowR.intensity = visible ? 0.8 : 0;

  // --- IDLE SWAY: subtle organic motion when standing/moving ---
  // Head bobs independently for a more disturbing, lifelike feel.
  const swayTime = performance.now() * 0.001;
  headMesh.rotation.z = Math.sin(swayTime * 0.6 + 1.0) * 0.06;
  bodyMesh.rotation.z = Math.sin(swayTime * 0.8) * 0.03;
  // Arms sway slightly
  armL.rotation.z = 0.3 + Math.sin(swayTime * 0.7) * 0.08;
  armR.rotation.z = -0.3 + Math.sin(swayTime * 0.7 + 1.5) * 0.08;

  // --- EYE PULSE: emissive intensity breathes slowly ---
  // (eyes are black with no emissive, so this affects the glow lights instead)
  const eyePulse = 1.6 + Math.sin(swayTime * 1.5) * 0.6;
  eyeGlowLight.intensity = visible ? 2.0 * eyePulse / 1.6 : 0;
  if (visible) {
    eyeGlowL.intensity = 0.8 * eyePulse / 1.6;
    eyeGlowR.intensity = 0.8 * eyePulse / 1.6;
  }

  // --- STARE DETECTION ---
  // Check if player is looking at the stalker AND the stalker is visible
  stalkerToPlayer.set(dx, 0, dz).normalize();
  playerToStalker.set(-dx, 0, -dz).normalize(); // Direction from player to stalker

  // Dot product: how directly player is looking at stalker
  const stareDot = playerForward.dot(playerToStalker);

  // Only accumulate stare if stalker is visible (player can see what they're staring at)
  if (stareDot > STARE_DOT_THRESHOLD && visible) {
    stareTime += delta;
    if (stareTime >= STARE_TIME_MAX) {
      stareTime = STARE_TIME_MAX;
      triggerGameOver('You stared too long into the void.');
      return;
    }
  } else {
    // Decay stare when looking away or stalker not visible
    stareTime = Math.max(0, stareTime - STARE_DECAY_RATE * delta);
  }

  // --- Update stare meter HUD ---
  const starePercent = (stareTime / STARE_TIME_MAX) * 100;
  stareMeterEl.style.width = starePercent + '%';
  // Color shift: green → yellow → red as stare accumulates
  if (starePercent > 70) {
    stareMeterEl.style.background = 'rgba(255, 40, 20, 0.9)';
    stareMeterEl.style.boxShadow = '0 0 10px rgba(255, 0, 0, 0.6)';
  } else if (starePercent > 30) {
    stareMeterEl.style.background = 'rgba(255, 180, 30, 0.8)';
  } else {
    stareMeterEl.style.background = 'rgba(255, 100, 40, 0.4)';
  }

  // --- Rotate stalker to face player ---
  const angle = Math.atan2(dx, dz);
  stalkerGroup.rotation.y = angle;
}

/**
 * Determine if the stalker is visible to the player.
 * Visible when:
 *   1. Within STALKER_VISIBLE_DISTANCE (very close — player can sense it)
 *   2. OR within the flashlight cone (illuminated by player's flashlight)
 *
 * @param {number} dist — distance from player to stalker
 * @returns {boolean}
 */
function isStalkerVisible(dist) {
  // Always visible when very close (panic range)
  if (dist < STALKER_VISIBLE_DISTANCE) return true;

  // Check if within flashlight cone:
  // Get flashlight world position and direction
  const flashWorldPos = new THREE.Vector3();
  flashlight.getWorldPosition(flashWorldPos);

  const flashDir = new THREE.Vector3(0, 0, -1);
  flashDir.applyQuaternion(camera.quaternion); // Flashlight attached to camera

  // Direction from flashlight to stalker
  const toStalker = new THREE.Vector3(
    stalkerGroup.position.x - flashWorldPos.x,
    1.5 - flashWorldPos.y, // Eyes are at ~1.5 height
    stalkerGroup.position.z - flashWorldPos.z
  ).normalize();

  const angle = flashDir.angleTo(toStalker);

  // Within flashlight cone AND close enough for light to reach
  return angle < STALKER_FLASHLIGHT_CONE && dist < flashlight.distance;
}

/**
 * Update atmospheric dust particles — drift, age, and recycle.
 * Particles slowly drift upward and outward from the flashlight center.
 * When a particle's age exceeds its maxAge, it is reset to a new random
 * position within the flashlight cone, creating continuous motion.
 * @param {number} delta — frame delta time
 */
function updateParticles(delta) {
  const pos = particleGeom.attributes.position.array;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const pd = particleData[i];
    pd.age += delta;

    // Drift upward and slightly outward
    pos[i * 3 + 1] += pd.speed * delta * 1.5;          // Y: upward drift
    pos[i * 3] += (Math.cos(pd.baseAngle) * 0.15 * delta);   // X: slight lateral
    pos[i * 3 + 2] += -pd.speed * delta * 0.3;          // Z: drift away from camera

    // Reset particle when it drifts too far or ages out
    const dist = Math.sqrt(
      pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2
    );
    if (pd.age > pd.maxAge || Math.abs(pos[i * 3 + 1]) > 8 || dist > PARTICLE_MAX_DIST) {
      // Regenerate at new random position within cone
      pd.age = 0;
      pd.maxAge = 3 + Math.random() * 8;
      pd.speed = 0.2 + Math.random() * PARTICLE_DRIFT_SPEED;
      const angle = Math.random() * PARTICLE_CONE_ANGLE;
      const azimuth = Math.random() * Math.PI * 2;
      const radius = 0.5 + Math.random() * PARTICLE_MAX_DIST;
      const r = Math.tan(angle) * radius;
      pd.baseAngle = azimuth;
      pd.baseRadius = r;
      pos[i * 3] = Math.cos(azimuth) * r;
      pos[i * 3 + 1] = Math.sin(azimuth) * r;
      pos[i * 3 + 2] = -radius;
    }
  }
  particleGeom.attributes.position.needsUpdate = true;
}

/**
 * Trigger Game Over with a reason message.
 * @param {string} reason — displayed on the Game Over screen
 */
// ============================================================================
// ABDUCTION SEQUENCE — state + update + trigger
// ============================================================================
// When the player dies (contact or stare), instead of immediate Game Over,
// a UFO descends, a light beam shines down, and the camera floats upward
// into the beam — classic alien abduction cinematic. Total: ~2.3 seconds.

const abduction = {
  active: false,
  elapsed: 0,
  reason: '',
  startY: 0,      // Camera Y at abduction start
  ufoStartY: 30,  // UFO starting height
};

/**
 * Start the abduction sequence.
 * @param {string} reason — displayed on Game Over screen after abduction
 */
function triggerGameOver(reason) {
  if (abduction.active) return; // Already abducting
  abduction.active = true;
  abduction.elapsed = 0;
  abduction.reason = reason;
  abduction.startY = camera.position.y;
  gameState = 'ABDUCTING';
  // Show UFO above the player
  ufo.position.set(camera.position.x, 30, camera.position.z);
  ufo.visible = true;
  // Stop stalker chase
  updateStalker = () => {}; // Disable stalker AI during abduction
  // Stop audio
  if (audioState.ambience) audioState.ambience.stop();
  if (audioState.static) audioState.static.stop();
  setStaticIntensity(0);
  console.log('ABDUCTION:', reason);
}

/**
 * Update abduction animation each frame. Called from main animation loop.
 * FAST PACED (~2.3s total): 0-0.6s UFO descends → 0.6-1.6s float → 1.6-2.3s fade
 * @param {number} delta
 */
function updateAbduction(delta) {
  if (!abduction.active) return;
  abduction.elapsed += delta;
  const t = abduction.elapsed;

  // Phase 1: UFO descends (0 → 0.6s) — fast, dramatic drop
  if (t < 0.6) {
    const progress = t / 0.6;
    const eased = 1 - Math.pow(1 - progress, 2); // Quadratic ease-out
    ufo.position.set(camera.position.x, 30 - eased * 22, camera.position.z); // 30 → 8
    beamLight.intensity = eased * 10;
    beam.material.opacity = eased * 0.2;
  } else {
    ufo.position.set(camera.position.x, 8, camera.position.z);
    beamLight.intensity = 10;
    beam.material.opacity = 0.2;
  }

  // Phase 2: Camera floats up into the beam (0.6 → 1.6s)
  if (t > 0.6 && t < 1.6) {
    const floatProgress = (t - 0.6) / 1.0;
    const eased = floatProgress * floatProgress; // Accelerates upward
    camera.position.y = abduction.startY + eased * 10;
    camera.rotation.x = -eased * 0.7;
    camera.fov = 75 - eased * 30;
    camera.updateProjectionMatrix();
  }

  // Phase 3: Screen fades to white (1.6 → 2.3s)
  if (t > 1.6 && t < 2.3) {
    const fadeProgress = (t - 1.6) / 0.7;
    const opacity = Math.min(fadeProgress * fadeProgress, 1);
    const overlay = document.getElementById('abduction-overlay');
    if (overlay) {
      overlay.style.opacity = opacity;
      overlay.style.display = 'block';
    }
  }

  // Phase 4: Show Game Over screen (after 2.3s)
  if (t > 2.3) {
    finishAbduction();
  }
}

function finishAbduction() {
  abduction.active = false;
  gameState = 'GAME_OVER';
  // Release pointer so player can click restart buttons
  controls.unlock();
  ufo.visible = false;
  beamLight.intensity = 0;
  beam.material.opacity = 0.12;
  // Hide white overlay
  const overlay = document.getElementById('abduction-overlay');
  if (overlay) overlay.style.display = 'none';
  // Reset camera
  camera.rotation.x = 0;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  // Update title
  if (abduction.reason.includes('stare')) {
    gameOverTitle.textContent = 'YOU STARED TOO LONG';
  } else {
    gameOverTitle.textContent = 'GAME OVER';
  }
  gameOverReason.textContent = abduction.reason;
  gameOverScreen.classList.remove('hidden');
  hudEl.style.display = 'none';
  console.log('GAME OVER:', abduction.reason);
}

// ============================================================================
// GAME START
// ============================================================================

// Spawn player at the farmhouse position (center, slightly offset).
// camera.position is already (0, 1.7, 0) from setup above.
camera.position.set(0, PLAYER_HEIGHT, 0);

animate();

// ============================================================================
// PSX: Apply retro styling to all scene materials
// ============================================================================
// Walk the scene after everything is created and force flatShading + NearestFilter
// on all materials. This catches any material defined inline.

scene.traverse((node) => {
  if (node.isMesh && node.material) {
    // Handle single material or material array
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of materials) {
      if (mat.isMeshStandardMaterial || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial) {
        mat.flatShading = true;
        mat.needsUpdate = true;
      }
      // NearestFilter on any texture map
      if (mat.map) {
        mat.map.magFilter = THREE.NearestFilter;
        mat.map.minFilter = THREE.NearestFilter;
        mat.map.needsUpdate = true;
      }
    }
  }
});

console.log('[PSX] Flat shading + NearestFilter applied to all scene materials');

// ============================================================================
// AUDIO: Howler.js — ambient, footsteps, TV static
// ============================================================================
// All sounds loaded lazily from the sounds/ directory.
// Uses window.Howl (loaded via CDN script tag in index.html).

const Howl = window.Howl;
let audioReady = false;
const audioState = { ambience: null, static: null, footstepTimer: 0 };

// --- Load sounds ---
// Ambience: looping night forest track, low volume (atmospheric background).
function initAudio() {
  if (audioReady) return;
  audioReady = true;

  // Night ambience
  audioState.ambience = new Howl({
    src: ['sounds/night_forest_ambience.mp3', 'sounds/crickets_ambient.mp3'],
    loop: true,
    volume: 0.25,
    autoplay: false,
  });

  // TV static — single short clip that can be faded in/out
  audioState.static = new Howl({
    src: ['sounds/tv_static.mp3'],
    loop: true,
    volume: 0,
    autoplay: false,
  });

  // Cow moo — single short clip, triggered on click
  audioState.moo = new Howl({
    src: ['sounds/cow_moo.mp3'],
    volume: 0.8,
  });

  // Footstep sounds — pick randomly from available grass steps
  const stepNames = [];
  for (let i = 0; i <= 9; i++) {
    stepNames.push(`sounds/step_grass_${i}.ogg`);
  }
  stepNames.push('sounds/mud02.ogg');
  audioState.footsteps = stepNames.map(src => new Howl({
    src: [src],
    volume: 0.5,
  }));
  audioState.lastStep = 0;

  console.log(`[Audio] ${audioState.footsteps.length} footstep variants loaded`);
}

// --- Play one random footstep ---
function playFootstep() {
  if (!audioReady) return;
  const steps = audioState.footsteps;
  // Vary pitch slightly for organic feel (rate 0.9-1.1)
  const idx = Math.floor(Math.random() * steps.length);
  const rate = 0.9 + Math.random() * 0.2;
  steps[idx].rate(rate).play();
}

// --- TV static: set intensity (0 = silent, 1 = full) ---
function setStaticIntensity(level) {
  if (!audioReady || !audioState.static) return;
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped > 0.01 && !audioState.static.playing()) {
    audioState.static.play();
  }
  audioState.static.volume(clamped * 0.6); // Max volume 60%
  if (clamped < 0.01 && audioState.static.playing()) {
    audioState.static.stop();
  }
}

// --- Play cow moo sound ---
function playMoo() {
  if (!audioReady || !audioState.moo) return;
  // Slight pitch variation for variety
  const rate = 0.85 + Math.random() * 0.3;
  audioState.moo.rate(rate).play();
  console.log('🐄 MOO!');
}

// --- Raycaster for cow click detection ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

renderer.domElement.addEventListener('mousedown', (event) => {
  if (!controls.isLocked || gameState !== 'PLAYING') return; // Only when actively playing

  // Convert click to normalized device coordinates
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Check intersection with cow and its children
  const intersects = raycaster.intersectObjects(cow.children, true);
  if (intersects.length > 0) {
    playMoo();
  }
});

console.log('[Audio] System ready — ambient, footsteps, TV static, MOO');

// ============================================================================
// ABDUCTION: UFO + light beam for Game Over cinematic
// ============================================================================
// Classic flying saucer: wide disc body + dome on top + lights around rim.
// Light beam is a transparent cone with a bright PointLight inside.
// The UFO starts hidden (offscreen above), descends during Game Over.

const ufo = new THREE.Group();
ufo.visible = false;
ufo.name = 'ufo';

// --- Main saucer body (wide tapered disc) ---
const saucerBody = new THREE.Mesh(
  new THREE.CylinderGeometry(1.2, 2.0, 0.5, 16),
  new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4, metalness: 0.8, flatShading: true })
);
saucerBody.position.y = 0;
saucerBody.castShadow = true;
ufo.add(saucerBody);

// --- Dome (half sphere on top of saucer) ---
const dome = new THREE.Mesh(
  new THREE.SphereGeometry(0.65, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x667788, roughness: 0.3, metalness: 0.7, flatShading: true })
);
dome.position.y = 0.2;
dome.castShadow = true;
ufo.add(dome);

// --- Bottom protrusion (small cylinder under saucer) ---
const under = new THREE.Mesh(
  new THREE.CylinderGeometry(0.15, 0.3, 0.4, 8),
  new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.5, metalness: 0.6, flatShading: true })
);
under.position.y = -0.45;
ufo.add(under);

// --- Rim lights (small glowing orbs around the saucer edge) ---
const rimLightGeom = new THREE.SphereGeometry(0.08, 6, 6);
const rimLightMat = new THREE.MeshStandardMaterial({ color: 0xaaccff, emissive: 0xaaccff, emissiveIntensity: 2.0 });
const rimLightsCount = 8;
for (let i = 0; i < rimLightsCount; i++) {
  const angle = (i / rimLightsCount) * Math.PI * 2;
  const light = new THREE.Mesh(rimLightGeom, rimLightMat);
  light.position.set(Math.cos(angle) * 1.6, -0.15, Math.sin(angle) * 1.6);
  ufo.add(light);
}

// --- Light beam (transparent cone from bottom of UFO to ground) ---
const beamGeom = new THREE.CylinderGeometry(0.1, 3.0, 20, 16, 1, true);
const beamMat = new THREE.MeshBasicMaterial({
  color: 0xaaddff,
  transparent: true,
  opacity: 0.12,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const beam = new THREE.Mesh(beamGeom, beamMat);
beam.position.y = -10.2; // extends from UFO down to ground
beam.name = 'abductionBeam';
ufo.add(beam);

// --- Bright PointLight at bottom of UFO (inside beam) ---
const beamLight = new THREE.PointLight(0xaaddff, 0, 30);
beamLight.position.y = -1;
beamLight.name = 'beamLight';
ufo.add(beamLight);

// --- UFO position: starts high above, hidden ---
ufo.position.set(0, 30, 0);
scene.add(ufo);

console.log('[UFO] Abduction saucer + beam built (starts hidden)');

// ============================================================================
// G006: GAME LOOP — HUD, states, restart
// ============================================================================
// HUD elements (crosshair, anomaly counter, stare meter) are already wired
// in G001-G005. This section adds restart functionality and ensures all
// game states (MENU → PLAYING → GAME_OVER / WIN) transition correctly.

// --- RESTART HANDLERS ---
// Simple page reload resets all state cleanly (Three.js, PRNG seed, positions).
function restartGame() {
  window.location.reload();
}

restartBtn.addEventListener('click', restartGame);
restartBtnWin.addEventListener('click', restartGame);

// Keyboard shortcut: press R to restart when game is over
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && (gameState === 'GAME_OVER' || gameState === 'WIN')) {
    restartGame();
  }
});

console.log('[Signs: Harvest Night] G006 game loop initialized.');
console.log('  States: MENU → PLAYING → GAME_OVER | WIN');
console.log('  Restart: button click or press R');
console.log('  Fog: FogExp2 density 0.08');
console.log('  Ambient: 0x111133 @ 0.3');
console.log('  Flashlight: SpotLight cone π/10, penumbra 0.3');
console.log('  Ground: 80x80 farm earth');
console.log('  Anomalies: 5 placed, collect distance ' + COLLECT_DISTANCE + ' units');
console.log('  Renderer:', renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1');
