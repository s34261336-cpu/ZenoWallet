import * as THREE from "three";
import { Reflector } from "https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/objects/Reflector.js";

const root = document.querySelector(".mining-scene");
const canvas = document.querySelector("#mining-canvas");

if (root && canvas) {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080d1c);
    scene.fog = new THREE.Fog(0x080d1c, 7.5, 17);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 40);
    camera.position.set(0, 2.25, 6.4);

    const clock = new THREE.Clock();
    const cameraTarget = new THREE.Vector3(0, 1.0, 0);
    const cameraLookAt = new THREE.Vector3();
    const textureCache = new Map();
    const particles = [];
    const particleGeometry = new THREE.BoxGeometry(0.075, 0.075, 0.075);
    const particleMaterial = new THREE.MeshStandardMaterial({
      color: 0x9cecf0,
      emissive: 0x1f7890,
      emissiveIntensity: 0.8,
      roughness: 0.55,
      transparent: true,
      opacity: 0,
    });
    const state = {
      className: "stone",
      hits: 0,
      hitsRequired: 8,
      blockBroken: 0,
      hitElapsed: -1,
      burstElapsed: -1,
      cameraShake: 0,
      visible: false,
    };

    const palette = {
      stone: { base: "#596671", dark: "#202832", glow: "#7da4b4", accent: "#d1e6ea" },
      crystal: { base: "#737a7e", dark: "#292e35", glow: "#bd3d3f", accent: "#f2ad9f" },
      gold: { base: "#695226", dark: "#261a0b", glow: "#f6d267", accent: "#fff1a3" },
      obsidian: { base: "#211d42", dark: "#0a0a1d", glow: "#9d79ff", accent: "#dfceff" },
      path: { base: "#4f5a61", dark: "#1e252c", glow: "#8e3f3f", accent: "#d8d2c7" },
    };

    function makePixelTexture(className) {
      if (textureCache.has(className)) return textureCache.get(className);
      const colors = palette[className] || palette.stone;
      const size = 128;
      const textureCanvas = document.createElement("canvas");
      textureCanvas.width = size;
      textureCanvas.height = size;
      const context = textureCanvas.getContext("2d");
      context.fillStyle = colors.base;
      context.fillRect(0, 0, size, size);
      const seed = className.length * 19;
      for (let y = 0; y < 16; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          const value = (x * 17 + y * 31 + seed) % 11;
          if (value < 3) {
            context.fillStyle = value === 0 ? colors.accent : colors.glow;
            context.globalAlpha = value === 0 ? 0.9 : 0.56;
            context.fillRect(x * 8 + 1, y * 8 + 1, 5 + (value % 3), 3 + (value % 4));
          } else if (value === 4) {
            context.fillStyle = colors.dark;
            context.globalAlpha = 0.62;
            context.fillRect(x * 8, y * 8 + 5, 8, 2);
          }
        }
      }
      context.globalAlpha = 1;
      const texture = new THREE.CanvasTexture(textureCanvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestMipmapNearestFilter;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textureCache.set(className, texture);
      return texture;
    }

    function makeMaterial(className) {
      const colors = palette[className] || palette.stone;
      return new THREE.MeshStandardMaterial({
        map: makePixelTexture(className),
        color: 0xffffff,
        roughness: 0.7,
        metalness: 0.08,
        emissive: new THREE.Color(colors.dark),
        emissiveIntensity: 0.32,
      });
    }

    scene.add(new THREE.HemisphereLight(0x91b7d8, 0x090c16, 1.5));
    const moonLight = new THREE.DirectionalLight(0xbad9ff, 2.6);
    moonLight.position.set(-4, 8, 5);
    scene.add(moonLight);
    const blockLight = new THREE.PointLight(0xbd3d3f, 1.7, 5, 2);
    blockLight.position.set(0, 1.25, -1.0);
    scene.add(blockLight);

    const stars = [];
    for (let index = 0; index < 105; index += 1) {
      const angle = index * 2.39996;
      const radius = 5.5 + (index % 9) * 0.65;
      stars.push(
        Math.cos(angle) * radius,
        2.6 + (index % 13) * 0.36,
        -3.5 - Math.sin(angle) * radius * 0.45,
      );
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xe3faff,
      size: 0.035,
      transparent: true,
      opacity: 0.74,
      sizeAttenuation: true,
    });
    scene.add(new THREE.Points(starGeometry, starMaterial));

    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 24, 18),
      new THREE.MeshStandardMaterial({
        color: 0xd9eafa,
        emissive: 0x8ea6d3,
        emissiveIntensity: 1.6,
        roughness: 1,
      }),
    );
    moon.position.set(2.65, 4.3, -4.4);
    scene.add(moon);

    const shoreMaterial = new THREE.MeshStandardMaterial({
      color: 0x182d3e,
      roughness: 0.95,
      metalness: 0.04,
    });
    const shoreDetails = new THREE.MeshStandardMaterial({
      color: 0x42636a,
      roughness: 0.84,
    });
    for (let index = 0; index < 12; index += 1) {
      const width = 0.42 + (index % 4) * 0.18;
      const rock = new THREE.Mesh(
        new THREE.BoxGeometry(width, 0.22 + (index % 3) * 0.16, 0.5 + (index % 5) * 0.13),
        index % 3 === 0 ? shoreDetails : shoreMaterial,
      );
      const side = index % 2 === 0 ? -1 : 1;
      rock.position.set(side * (2.1 + (index % 4) * 0.48), 0.13, -1.35 - (index % 5) * 0.42);
      rock.rotation.y = index * 0.63;
      scene.add(rock);
    }

    const pathGroup = new THREE.Group();
    scene.add(pathGroup);
    const pathMaterials = [
      makeMaterial("path"),
      new THREE.MeshStandardMaterial({ color: 0x657078, roughness: 0.92 }),
      new THREE.MeshStandardMaterial({ color: 0x37434c, roughness: 0.95 }),
    ];
    for (let index = 0; index < 16; index += 1) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.82 + (index % 3) * 0.1, 0.12, 0.55 + (index % 4) * 0.07),
        pathMaterials[index % pathMaterials.length],
      );
      tile.position.set(
        Math.sin(index * 1.7) * 0.1,
        0.11 + (index % 2) * 0.015,
        1.28 - index * 0.48,
      );
      tile.rotation.y = Math.sin(index * 3.2) * 0.08;
      pathGroup.add(tile);
    }

    const cloudMaterial = new THREE.MeshStandardMaterial({
      color: 0x9ea9b6,
      emissive: 0x1a2237,
      emissiveIntensity: 0.22,
      roughness: 1,
    });
    const cloudPositions = [
      [-2.8, 3.3, -3.8, 1.25],
      [2.2, 3.55, -3.0, 1.05],
      [-0.4, 4.05, -5.0, 0.92],
    ];
    cloudPositions.forEach(([x, y, z, scale], cloudIndex) => {
      const cloud = new THREE.Group();
      cloud.position.set(x, y, z);
      for (let index = 0; index < 4; index += 1) {
        const puff = new THREE.Mesh(
          new THREE.BoxGeometry((0.75 + (index % 2) * 0.35) * scale, 0.12, 0.4 * scale),
          cloudMaterial,
        );
        puff.position.set((index - 1.5) * 0.38 * scale, (index % 2) * 0.07, (index % 3) * 0.08);
        cloud.add(puff);
      }
      cloud.rotation.y = cloudIndex * 0.3;
      scene.add(cloud);
    });

    const waterGeometry = new THREE.PlaneGeometry(13, 13, 64, 64);
    const waterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x16384e) },
        uDeepColor: { value: new THREE.Color(0x070f24) },
      },
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vUv = uv;
          vec3 transformed = position;
          float wave =
            sin(position.x * 2.4 + uTime * 1.7) * 0.026 +
            cos(position.y * 3.1 - uTime * 1.15) * 0.018 +
            sin((position.x + position.y) * 5.2 + uTime * 0.9) * 0.01;
          transformed.z += wave;
          vWave = wave;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uDeepColor;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          float bands = sin((vUv.x + vUv.y) * 84.0 + vWave * 250.0) * 0.5 + 0.5;
          vec3 color = mix(uDeepColor, uColor, 0.42 + bands * 0.32);
          gl_FragColor = vec4(color, 0.66);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const water = new THREE.Mesh(waterGeometry, waterMaterial);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.055;
    water.renderOrder = 2;
    scene.add(water);

    const waterReflection = new Reflector(new THREE.PlaneGeometry(12.5, 12.5), {
      clipBias: 0.003,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x1b3147,
    });
    waterReflection.rotation.x = -Math.PI / 2;
    waterReflection.position.y = 0.035;
    waterReflection.renderOrder = 1;
    scene.add(waterReflection);

    const blockGroup = new THREE.Group();
    blockGroup.position.set(0, 1.06, -1.65);
    blockGroup.rotation.y = -0.12;
    scene.add(blockGroup);
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.72, 1.72, 1.72), makeMaterial("stone"));
    block.castShadow = true;
    block.receiveShadow = true;
    blockGroup.add(block);
    const blockEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.74, 1.74, 1.74)),
      new THREE.LineBasicMaterial({
        color: 0x8eeef0,
        transparent: true,
        opacity: 0.2,
      }),
    );
    blockGroup.add(blockEdges);

    const crackMaterial = new THREE.LineBasicMaterial({
      color: 0xc5f2f0,
      transparent: true,
      opacity: 0.78,
    });
    const crackGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.52, 0.45, 0.87),
      new THREE.Vector3(-0.14, 0.08, 0.88),
      new THREE.Vector3(-0.38, -0.32, 0.88),
      new THREE.Vector3(0.1, -0.55, 0.88),
      new THREE.Vector3(0.31, -0.18, 0.88),
      new THREE.Vector3(0.61, -0.42, 0.88),
    ]);
    blockGroup.add(new THREE.Line(crackGeometry, crackMaterial));

    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 256;
    labelCanvas.height = 76;
    const labelContext = labelCanvas.getContext("2d");
    labelContext.fillStyle = "rgba(14, 16, 17, 0.88)";
    labelContext.fillRect(10, 8, 236, 60);
    labelContext.strokeStyle = "#e7d52d";
    labelContext.lineWidth = 4;
    labelContext.strokeRect(10, 8, 236, 60);
    labelContext.fillStyle = "#f4ec45";
    labelContext.font = "700 34px sans-serif";
    labelContext.textAlign = "center";
    labelContext.textBaseline = "middle";
    labelContext.fillText("★ 876", 128, 39);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    const blockLabel = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false }),
    );
    blockLabel.position.set(0, -0.1, 0.9);
    blockLabel.scale.set(0.9, 0.27, 1);
    blockGroup.add(blockLabel);

    const miner = new THREE.Group();
    miner.position.set(-1.72, 0.1, 0.72);
    const minerBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.56, 0.32),
      new THREE.MeshStandardMaterial({ color: 0xa77a47, roughness: 0.85 }),
    );
    minerBody.position.y = 0.45;
    miner.add(minerBody);
    const minerHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.38, 0.36),
      new THREE.MeshStandardMaterial({ color: 0xe3a676, roughness: 0.8 }),
    );
    minerHead.position.y = 0.94;
    miner.add(minerHead);
    const minerHair = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.12, 0.38),
      new THREE.MeshStandardMaterial({ color: 0x4c2c20, roughness: 1 }),
    );
    minerHair.position.y = 1.17;
    miner.add(minerHair);
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xf7dc45 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.025), eyeMaterial);
      eye.position.set(side * 0.095, 0.96, 0.185);
      miner.add(eye);
    }
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.3, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x8d6b3d, roughness: 1 }),
      );
      leg.position.set(side * 0.12, 0.03, 0);
      miner.add(leg);
    }
    scene.add(miner);

    for (let index = 0; index < 30; index += 1) {
      const piece = new THREE.Mesh(particleGeometry, particleMaterial.clone());
      piece.visible = false;
      piece.userData.seed = index;
      scene.add(piece);
      particles.push(piece);
    }

    const pickaxe = new THREE.Group();
    pickaxe.position.set(0.96, -0.73, -1.28);
    pickaxe.rotation.set(-0.32, -0.08, -0.58);
    camera.add(pickaxe);
    scene.add(camera);
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a5227,
      roughness: 0.68,
      metalness: 0.02,
    });
    const steelMaterial = new THREE.MeshStandardMaterial({
      color: 0x39d7d3,
      emissive: 0x1b7d84,
      emissiveIntensity: 0.48,
      metalness: 0.8,
      roughness: 0.26,
    });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.11, 2.15, 10), woodMaterial);
    handle.rotation.z = -0.19;
    handle.position.set(0.1, -0.27, 0);
    pickaxe.add(handle);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.15, 0.18), steelMaterial);
    head.rotation.z = 0.17;
    head.position.set(-0.08, 0.64, 0);
    pickaxe.add(head);
    for (const side of [-1, 1]) {
      const point = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.34, 8), steelMaterial);
      point.rotation.z = side * Math.PI / 2;
      point.position.set(side * 0.66, 0.64, 0);
      pickaxe.add(point);
    }
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.28, 10), steelMaterial);
    grip.rotation.z = -0.19;
    grip.position.set(0.25, -1.25, 0);
    pickaxe.add(grip);
    const pickaxeBase = {
      position: pickaxe.position.clone(),
      rotation: pickaxe.rotation.clone(),
    };

    const pointer = { active: false, x: 0, y: 0, targetX: 0, targetY: 0 };
    let running = false;
    let frame = 0;
    let elapsed = 0;
    let orbitAngle = 0;
    let resizeObserver;

    function resize() {
      const bounds = root.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (waterReflection.getRenderTarget?.()) {
        waterReflection.getRenderTarget().setSize(
          Math.max(256, Math.floor(width * pixelRatio)),
          Math.max(256, Math.floor(height * pixelRatio)),
        );
      }
    }

    function burstParticles() {
      const colors = palette[state.className] || palette.stone;
      const particleColor = new THREE.Color(colors.accent);
      particles.forEach((particle, index) => {
        const row = index % 6;
        const col = Math.floor(index / 6);
        particle.position.set(
          (row - 2.5) * 0.12,
          1.2 + (col - 2) * 0.12,
          0.74 + ((index % 3) - 1) * 0.07,
        );
        particle.userData.velocity = new THREE.Vector3(
          (row - 2.5) * 0.45 + Math.sin(index * 5.1) * 0.22,
          1.1 + (index % 5) * 0.16,
          0.2 + (index % 4) * 0.2,
        );
        particle.userData.spin = (index % 2 ? 1 : -1) * (1.4 + (index % 4) * 0.35);
        particle.userData.life = 0.7 + (index % 5) * 0.05;
        particle.material.color.copy(particleColor);
        particle.material.emissive.copy(particleColor).multiplyScalar(0.3);
        particle.material.opacity = 0.95;
        particle.visible = true;
      });
      state.burstElapsed = 0;
    }

    function hit() {
      if (state.hitElapsed >= 0 && state.hitElapsed < 0.14) return;
      state.hitElapsed = 0;
      state.cameraShake = 0.2;
      burstParticles();
    }

    function resolveHit(result) {
      if (result?.broken) {
        state.blockBroken = 0.12;
        burstParticles();
      }
      state.hitElapsed = Math.max(state.hitElapsed, 0);
    }

    function setState(nextState) {
      Object.assign(state, nextState);
      const nextMaterial = makeMaterial(state.className);
      block.material.dispose();
      block.material = nextMaterial;
      const colors = palette[state.className] || palette.stone;
      blockEdges.material.color.set(colors.accent);
      blockLight.color.set(colors.glow);
      crackMaterial.color.set(colors.accent);
      const strength = Math.max(0, Math.min(1, Number(state.hits || 0) / Math.max(1, Number(state.hitsRequired || 8))));
      crackMaterial.opacity = 0.22 + strength * 0.72;
    }

    function update(delta) {
      elapsed += delta;
      waterMaterial.uniforms.uTime.value = elapsed;
      orbitAngle += delta * 0.16;
      pointer.x += (pointer.targetX - pointer.x) * Math.min(1, delta * 5);
      pointer.y += (pointer.targetY - pointer.y) * Math.min(1, delta * 5);

      const radius = 5.6;
      const cameraX = Math.sin(orbitAngle) * 0.58 + pointer.x * 0.6;
      const cameraZ = Math.cos(orbitAngle) * 0.16 + radius;
      const shake = state.cameraShake;
      state.cameraShake = Math.max(0, state.cameraShake - delta * 1.65);
      camera.position.set(
        cameraX + Math.sin(elapsed * 48) * shake * 0.05,
        2.02 + pointer.y * 0.24 + Math.cos(elapsed * 44) * shake * 0.035,
        cameraZ,
      );
      cameraTarget.set(pointer.x * 0.12, 0.88 + pointer.y * 0.06, -0.45);
      cameraLookAt.lerp(cameraTarget, Math.min(1, delta * 5));
      camera.lookAt(cameraLookAt);

      blockGroup.rotation.y = -0.12 + Math.sin(elapsed * 0.24) * 0.08;
      blockGroup.position.y = 1.06 + Math.sin(elapsed * 1.2) * 0.045;
      block.rotation.x = Math.sin(elapsed * 0.33) * 0.025;
      moon.position.x = 2.65 + Math.sin(elapsed * 0.08) * 0.1;

      if (state.hitElapsed >= 0) {
        state.hitElapsed += delta;
        const progress = Math.min(1, state.hitElapsed / 0.42);
        const swing = Math.sin(progress * Math.PI);
        pickaxe.position.copy(pickaxeBase.position);
        pickaxe.rotation.copy(pickaxeBase.rotation);
        pickaxe.rotation.x -= swing * 0.72;
        pickaxe.rotation.z += swing * 0.62;
        pickaxe.position.x -= swing * 0.08;
        if (progress >= 1) state.hitElapsed = -1;
      } else {
        pickaxe.position.copy(pickaxeBase.position);
        pickaxe.rotation.copy(pickaxeBase.rotation);
        pickaxe.rotation.z += Math.sin(elapsed * 1.8) * 0.015;
      }

      if (state.blockBroken > 0) {
        state.blockBroken += delta;
        const brokenProgress = Math.min(1, state.blockBroken / 0.28);
        blockGroup.scale.setScalar(1 - brokenProgress * 0.22);
        blockGroup.rotation.z = brokenProgress * 0.18;
        if (brokenProgress >= 1) state.blockBroken = -1;
      } else if (state.blockBroken < 0) {
        state.blockBroken = 0;
        blockGroup.scale.setScalar(1);
        blockGroup.rotation.z = 0;
      }

      particles.forEach((particle) => {
        if (!particle.visible) return;
        const velocity = particle.userData.velocity;
        particle.userData.life -= delta;
        particle.position.addScaledVector(velocity, delta);
        velocity.y -= 2.65 * delta;
        particle.rotation.x += particle.userData.spin * delta;
        particle.rotation.y += particle.userData.spin * 0.7 * delta;
        particle.material.opacity = Math.max(0, Math.min(1, particle.userData.life * 1.8));
        if (particle.userData.life <= 0) particle.visible = false;
      });
    }

    function renderLoop(now) {
      if (!running) return;
      const delta = Math.min(0.05, Math.max(0.001, (now - clock.oldTime) / 1000));
      clock.oldTime = now;
      update(delta);
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(renderLoop);
    }

    function setVisible(visible) {
      state.visible = visible;
      if (!visible) {
        running = false;
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      resize();
      if (!running) {
        running = true;
        clock.oldTime = performance.now();
        frame = window.requestAnimationFrame(renderLoop);
      }
    }

    canvas.addEventListener("pointerdown", (event) => {
      pointer.active = true;
      pointer.x = pointer.targetX = ((event.clientX / root.clientWidth) - 0.5) * 2;
      pointer.y = pointer.targetY = ((event.clientY / root.clientHeight) - 0.5) * -2;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pointer.active) return;
      pointer.targetX = Math.max(-1, Math.min(1, ((event.clientX / root.clientWidth) - 0.5) * 2));
      pointer.targetY = Math.max(-1, Math.min(1, ((event.clientY / root.clientHeight) - 0.5) * -2));
    });
    canvas.addEventListener("pointerup", () => {
      pointer.active = false;
    });
    canvas.addEventListener("pointercancel", () => {
      pointer.active = false;
    });

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    root.classList.add("three-ready");
    window.miningScene3D = {
      hit,
      resolveHit,
      setState,
      setVisible,
    };
    setVisible(document.body.classList.contains("screen-mining"));
  } catch (error) {
    console.warn("3D mining scene unavailable; using the CSS fallback.", error);
  }
}