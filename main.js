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

// --- RENDERER ---
// Using WebGLRenderer with antialiasing for smooth edges on geometric primitives.
// Shadow map will be enabled in G002 when we add the flashlight.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap for perf
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Soft shadows for flashlight
renderer.toneMapping = THREE.ACESFilmicToneMapping; // Cinematic tone mapping
renderer.toneMappingExposure = 0.8;
document.body.appendChild(renderer.domElement);

// --- SCENE ---
const scene = new THREE.Scene();

// --- CAMERA ---
// FOV 75 for claustrophobic feel common in horror games.
// Near clip at 0.1, far clip at 80 — fog will obscure beyond ~40.
const camera = new THREE.PerspectiveCamera(
  75,                                             // FOV
  window.innerWidth / window.innerHeight,          // Aspect
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
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// ANIMATION LOOP
// ============================================================================

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.1); // Cap delta to avoid tunneling

  // --- MOVEMENT (WASD relative to camera facing) ---
  // Only apply movement when pointer is locked and game is in PLAYING state.
  if (controls.isLocked && gameState === 'PLAYING') {
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
  }

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
scene.fog = new THREE.FogExp2(0x0a0a18, 0.08); // Exponential fog: dark blue-grey, thick

// --- AMBIENT LIGHT ---
// Minimal global illumination — just enough to perceive silhouettes at very close range.
// This keeps the cornfield oppressive and forces flashlight reliance.
const ambientLight = new THREE.AmbientLight(0x111133, 0.3);
scene.add(ambientLight);

// --- MOONLIGHT (faint directional) ---
// Subtle directional light from above to cast faint shadows and provide minimal
// silhouette definition. Low intensity so flashlight remains the primary light source.
const moonLight = new THREE.DirectionalLight(0x8899cc, 0.4);
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
const flashlight = new THREE.SpotLight(0xfff8e7, 45, 25, Math.PI / 10, 0.3, 1.5);
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
const moonGeom = new THREE.CircleGeometry(3, 32);
const moonMat = new THREE.MeshBasicMaterial({
  color: 0xeeeedd,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.7,
});
const moon = new THREE.Mesh(moonGeom, moonMat);
moon.position.set(25, 42, -35);
// Tilt moon to face the play area
moon.lookAt(new THREE.Vector3(0, 42, 0));
moon.name = 'moon';
scene.add(moon);

// Subtle moon glow halo
const haloGeom = new THREE.CircleGeometry(4.5, 32);
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

const starMat = new THREE.PointsMaterial({
  size: 0.5,
  map: starTexture,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
  opacity: 0.7,
  color: 0xaaccff,
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
//   - STALK_COUNT: total number of stalks
//   - FIELD_HALF: half-width of the square field
//   - SPACING: distance between stalk centers
//   - CLEARING_RADIUS: open area around player spawn
//   - STALK_HEIGHT: base stalk height (scaled per instance)
//   - STALK_RADIUS_BASE / STALK_RADIUS_TOP: cylinder taper

const STALK_COUNT = 3600;
const FIELD_HALF = 45;          // Field extends from -45 to +45 on X and Z
const SPACING = 1.5;            // Grid spacing between stalks
const CLEARING_RADIUS = 5;      // Open area around origin (player spawn)
const STALK_HEIGHT = 4.0;       // Base stalk height in units
const STALK_RADIUS_BASE = 0.06; // Bottom radius (slightly thicker)
const STALK_RADIUS_TOP = 0.04;  // Top radius (tapered)

// --- Stalk geometry ---
// Low-poly cylinder (6 sides) to keep draw calls light.
// Tapered: base wider than top for a more organic corn-stalk silhouette.
const stalkGeom = new THREE.CylinderGeometry(
  STALK_RADIUS_TOP,
  STALK_RADIUS_BASE,
  STALK_HEIGHT,
  6,  // Radial segments
  1   // Height segments
);

// --- Stalk material ---
// Dark green-brown base. Per-instance color variation is applied via instanceColor
// (green for healthy stalks, yellow-brown for dry/dying ones) to break the
// monotony of a single-color field.
const stalkMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,      // White base — instanceColor multiplies this
  roughness: 0.85,
  metalness: 0.0,
});

// --- InstancedMesh ---
const cornfield = new THREE.InstancedMesh(stalkGeom, stalkMat, STALK_COUNT);
cornfield.castShadow = true;
cornfield.receiveShadow = true;
cornfield.name = 'cornfield';

// Enable per-instance color variation
cornfield.instanceColor = new THREE.InstancedBufferAttribute(
  new Float32Array(STALK_COUNT * 3), 3
);

// --- Pseudo-random number generator (seeded for reproducibility) ---
// Using a simple mulberry32 PRNG so cornfield layout is consistent across reloads.
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42); // Seed 42 — change to re-randomize layout

// --- Instance matrix and helpers ---
const dummy = new THREE.Object3D();
const stalkPositions = []; // Store positions for anomaly placement (G004)
let placedCount = 0;

// Generate stalks in a grid pattern.
// We iterate over a larger grid than needed and skip positions in the clearing
// and random gaps to create natural-looking density variation.
const gridCells = Math.ceil((FIELD_HALF * 2) / SPACING);

for (let ix = 0; ix < gridCells && placedCount < STALK_COUNT; ix++) {
  for (let iz = 0; iz < gridCells && placedCount < STALK_COUNT; iz++) {
    // Convert grid index to world position (centered)
    const wx = (ix - gridCells / 2) * SPACING;
    const wz = (iz - gridCells / 2) * SPACING;

    // Skip if inside the central clearing (player spawn area)
    const distFromCenter = Math.sqrt(wx * wx + wz * wz);
    if (distFromCenter < CLEARING_RADIUS) continue;

    // Random thinning: ~15% chance to skip a stalk for organic gaps
    if (rng() < 0.15) continue;

    // Slight random offset from grid position for organic feel (±0.3 units)
    const offsetX = (rng() - 0.5) * 0.6;
    const offsetZ = (rng() - 0.5) * 0.6;
    const posX = wx + offsetX;
    const posZ = wz + offsetZ;

    // Random Y rotation (stalk faces random direction — subtle for cylinders)
    const rotY = rng() * Math.PI * 2;

    // Random scale variation (±15% height, ±20% width)
    const scaleY = 0.85 + rng() * 0.3;  // 0.85–1.15
    const scaleXZ = 0.8 + rng() * 0.4;  // 0.8–1.2

    dummy.position.set(posX, (STALK_HEIGHT / 2) * scaleY, posZ);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(scaleXZ, scaleY, scaleXZ);
    dummy.updateMatrix();

    cornfield.setMatrixAt(placedCount, dummy.matrix);

    // Per-instance color: blend between green, yellow-green, and brown
    // based on a random factor — simulates healthy vs dry corn stalks.
    const colorRoll = rng();
    const r = 0.18 + colorRoll * 0.22;  // 0.18–0.40
    const g = 0.22 + colorRoll * 0.08;  // 0.22–0.30
    const b = 0.10 + colorRoll * 0.04;  // 0.10–0.14
    cornfield.instanceColor.setXYZ(placedCount, r, g, b);

    stalkPositions.push({ x: posX, z: posZ });
    placedCount++;
  }
}

// Update the actual instance count if we placed fewer than STALK_COUNT
cornfield.count = placedCount;
cornfield.instanceMatrix.needsUpdate = true;
cornfield.instanceColor.needsUpdate = true;

scene.add(cornfield);

console.log(`  Cornfield: ${placedCount} stalks placed`);

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
  new THREE.SphereGeometry(0.5, 16, 16),
  0x4488ff,
  FIELD_HALF * 0.6,   // ~27 units out
  FIELD_HALF * 0.5,   // ~22 units out
  'Orb of Whispers'
);

// 2. Torus Knot — intricate twisted ring, sickly green
createAnomaly(
  new THREE.TorusKnotGeometry(0.4, 0.1, 64, 8, 2, 3),
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

// --- Stalker group (body + eyes) ---
const stalkerGroup = new THREE.Group();
stalkerGroup.name = 'stalker';

// Body: tall dark box — elongated, inhuman silhouette
// Made slightly taller and narrower for a more unsettling, thin alien figure.
const bodyGeom = new THREE.BoxGeometry(0.4, 5.5, 0.3);
const bodyMat = new THREE.MeshStandardMaterial({
  color: 0x050505,
  roughness: 0.9,
  metalness: 0.1,
});
const body = new THREE.Mesh(bodyGeom, bodyMat);
body.position.y = 2.75; // Center of box at half height
body.castShadow = true;
body.name = 'stalkerBody';
stalkerGroup.add(body);

// Head: small dark sphere on top — adds a faint silhouette detail
const headGeom = new THREE.SphereGeometry(0.18, 8, 8);
const headMat = new THREE.MeshStandardMaterial({
  color: 0x050505,
  roughness: 0.9,
  metalness: 0.1,
});
const head = new THREE.Mesh(headGeom, headMat);
head.position.y = 5.5;
head.castShadow = true;
head.name = 'stalkerHead';
stalkerGroup.add(head);

// Eyes: two small bright glowing spheres — alien, unsettling
// Brighter and slightly larger for more visibility through fog.
const eyeGeom = new THREE.SphereGeometry(0.15, 8, 8);
const eyeMat = new THREE.MeshStandardMaterial({
  color: 0xffcc00,
  emissive: 0xffcc00,
  emissiveIntensity: 4.0,
  roughness: 0.1,
});
const eyeLeft = new THREE.Mesh(eyeGeom, eyeMat);
eyeLeft.position.set(-0.13, 5.6, 0.15);
eyeLeft.name = 'stalkerEyeL';
stalkerGroup.add(eyeLeft);

const eyeRight = new THREE.Mesh(eyeGeom, eyeMat);
eyeRight.position.set(0.13, 5.6, 0.15);
eyeRight.name = 'stalkerEyeR';
stalkerGroup.add(eyeRight);

// Eye glow PointLight — faint amber halo visible through fog at distance
const eyeGlowLight = new THREE.PointLight(0xffaa00, 1.5, 10, 2);
eyeGlowLight.position.set(0, 5.6, 0.15);
eyeGlowLight.name = 'stalkerEyeGlow';
stalkerGroup.add(eyeGlowLight);

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
  body.visible = visible;
  head.visible = visible;
  eyeLeft.visible = visible;
  eyeRight.visible = visible;
  eyeGlowLight.intensity = visible ? 1.5 : 0;

  // --- IDLE SWAY: subtle organic motion when standing/moving ---
  // A slow sinusoidal sway on the body makes the figure feel alive even
  // at distance — more unsettling than a rigid sliding box.
  const swayTime = performance.now() * 0.001;
  body.rotation.z = Math.sin(swayTime * 0.8) * 0.04;
  head.rotation.z = Math.sin(swayTime * 0.6 + 1.0) * 0.06;

  // --- EYE PULSE: emissive intensity breathes slowly ---
  const eyePulse = 3.5 + Math.sin(swayTime * 1.5) * 0.8;
  eyeLeft.material.emissiveIntensity = eyePulse;
  eyeRight.material.emissiveIntensity = eyePulse;

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
function triggerGameOver(reason) {
  gameState = 'GAME_OVER';
  controls.unlock();
  gameOverReason.textContent = reason;
  gameOverScreen.classList.remove('hidden');
  hudEl.style.display = 'none';
  console.log('GAME OVER:', reason);
}

// ============================================================================
// GAME START
// ============================================================================

// Spawn player at the farmhouse position (center, slightly offset).
// camera.position is already (0, 1.7, 0) from setup above.
camera.position.set(0, PLAYER_HEIGHT, 0);

animate();

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

// --- Adjust Game Over title based on cause ---
// triggerGameOver() is called from G005 with a reason string.
// We patch it to also update the title for specific causes.
const originalTriggerGameOver = triggerGameOver;
triggerGameOver = function(reason) {
  if (reason.includes('contact') || reason.includes('caught')) {
    gameOverTitle.textContent = 'GAME OVER';
    gameOverTitle.style.color = '#cc3333';
  } else if (reason.includes('stare') || reason.includes('void')) {
    gameOverTitle.textContent = 'YOU STARED TOO LONG';
    gameOverTitle.style.color = '#ff6644';
  }
  originalTriggerGameOver(reason);
};

console.log('[Signs: Harvest Night] G006 game loop initialized.');
console.log('  States: MENU → PLAYING → GAME_OVER | WIN');
console.log('  Restart: button click or press R');
console.log('  Fog: FogExp2 density 0.08');
console.log('  Ambient: 0x111133 @ 0.3');
console.log('  Flashlight: SpotLight cone π/10, penumbra 0.3');
console.log('  Ground: 80x80 farm earth');
console.log('  Anomalies: 5 placed, collect distance ' + COLLECT_DISTANCE + ' units');
console.log('  Renderer:', renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1');
