/**
 * demo-cursor.js —— 演示模式的模拟鼠标（three.js 正交叠加层）
 * 用途：?demo=segN 录制答辩演示视频时，隐藏系统光标，由编排器驱动
 * 一个 three.js 渲染的指针平滑移动 + 点击涟漪（与开场动画同一视觉语言）。
 * API：
 *   const cur = await initCursor();
 *   await cur.moveTo(x, y, ms);   // 平滑移动到屏幕坐标（easeInOutCubic）
 *   await cur.click(x, y);        // 在屏幕坐标播放点击涟漪（约 450ms）
 */
import * as THREE from "./vendor/three.module.min.js";

export async function initCursor() {
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "fixed", inset: "0", zIndex: 99998, pointerEvents: "none" });
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  let W = innerWidth, H = innerHeight;
  const camera = new THREE.OrthographicCamera(0, W, H, 0, -10, 10); // y 向上；世界 y = H - 屏幕y
  camera.position.z = 1;

  // 光标箭头纹理（经典指针形，朝左上；白填充 + 深描边）
  function arrowTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 48;
    const g = c.getContext("2d");
    g.translate(2, 2);
    g.beginPath();
    g.moveTo(2, 2); g.lineTo(2, 30); g.lineTo(9.5, 23.5); g.lineTo(14, 34);
    g.lineTo(19, 31.7); g.lineTo(14.5, 21.5); g.lineTo(24, 21); g.closePath();
    g.fillStyle = "rgba(255,255,255,.96)";
    g.strokeStyle = "rgba(10,25,35,.9)";
    g.lineWidth = 2.4; g.lineJoin = "round";
    g.fill(); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // 柔光圆点纹理（涟漪/点击点用，与 intro.html 同款手法）
  function glowTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(76,195,214,.9)");
    grad.addColorStop(0.55, "rgba(76,195,214,.28)");
    grad.addColorStop(1, "rgba(76,195,214,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const texArrow = arrowTexture(), texGlow = glowTexture();

  const pointer = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texArrow, transparent: true, depthWrite: false,
  }));
  pointer.scale.set(26, 26, 1);
  pointer.position.set(-100, -100, 0);
  scene.add(pointer);

  // ---- 简易 tween 引擎（统一 rAF） ----
  const tweens = [];
  const effects = []; // 点击涟漪等自驱效果
  const easeInOut = (k) => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  function tween(dur, fn) {
    return new Promise((res) => tweens.push({ t0: performance.now(), dur, fn, res }));
  }
  const toWorld = (x, y) => ({ wx: x, wy: H - y });
  let px = -100, py = -100;

  function spawnRipple(x, y) {
    const { wx, wy } = toWorld(x, y);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0x4cc3d6, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.position.set(wx, wy, 0);
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texGlow, transparent: true, depthWrite: false, opacity: 1,
    }));
    dot.position.set(wx, wy, 0);
    dot.scale.set(22, 22, 1);
    scene.add(ring, dot);
    effects.push({ ring, dot, t0: performance.now() });
  }

  function resize() {
    W = innerWidth; H = innerHeight;
    camera.left = 0; camera.right = W; camera.top = H; camera.bottom = 0;
    camera.updateProjectionMatrix();
    renderer.setSize(W, H);
  }
  addEventListener("resize", resize);
  resize();

  (function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      const k = Math.min(1, (now - t.t0) / t.dur);
      t.fn(k);
      if (k >= 1) { tweens.splice(i, 1); t.res(); }
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const k = (now - e.t0) / 450;
      if (k >= 1) {
        scene.remove(e.ring, e.dot);
        e.ring.geometry.dispose(); e.ring.material.dispose();
        e.dot.material.dispose();
        effects.splice(i, 1); continue;
      }
      e.ring.scale.setScalar(4 + (1 - Math.pow(1 - k, 2.2)) * 34); // 先快后慢，与 intro 同款节奏
      e.ring.material.opacity = (1 - k) * 0.9;
      e.dot.scale.setScalar(22 * (1 - k) + 4);
      e.dot.material.opacity = 1 - k;
    }
    const { wx, wy } = toWorld(px, py);
    pointer.position.set(wx, wy, 1);
    renderer.render(scene, camera);
  })();

  return {
    async moveTo(x, y, ms = 650) {
      const x0 = px, y0 = py;
      await tween(ms, (k) => {
        const e = easeInOut(k);
        px = x0 + (x - x0) * e;
        py = y0 + (y - y0) * e;
      });
    },
    async click(x, y) {
      px = x; py = y;
      spawnRipple(x, y);
      await new Promise((r) => setTimeout(r, 260)); // 涟漪先可见再返回，节奏稳
    },
  };
}
