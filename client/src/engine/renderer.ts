import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { QualityPreset } from './quality';

// Materials that write their own emissive MRT output. The MRT node must only be
// attached while the bloom pipeline is active, otherwise WebGL complains about
// missing fragment outputs.
const bloomSources: Array<{ material: THREE.NodeMaterial; node: THREE.Node }> = [];
let bloomActive = false;
export function registerBloomSource(material: THREE.NodeMaterial, node: THREE.Node): void {
  bloomSources.push({ material, node });
  material.mrtNode = bloomActive ? (node as THREE.MRTNode) : null;
}
function setBloomSources(on: boolean) {
  bloomActive = on;
  for (const s of bloomSources) {
    s.material.mrtNode = on ? (s.node as THREE.MRTNode) : null;
    s.material.needsUpdate = true;
  }
}

export interface RendererInfo {
  backend: 'WebGPU' | 'WebGL2';
  gpu: string;
}

export class GameRenderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly info: RendererInfo;
  private pipeline: THREE.RenderPipeline | null = null;
  private bloomEnabled = false;
  bloomStrength = 0.9;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private constructor(renderer: THREE.WebGPURenderer, info: RendererInfo, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.info = info;
    this.scene = scene;
    this.camera = camera;
  }

  static async create(container: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Promise<GameRenderer> {
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL, powerPreference: 'high-performance' });
    await renderer.init();
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;
    container.appendChild(renderer.domElement);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = (renderer as any).backend;
    const isWebGPU = !!backend?.isWebGPUBackend;
    let gpu = '';
    try {
      if (isWebGPU) {
        const ai = backend.adapter?.info;
        gpu = [ai?.vendor, ai?.architecture, ai?.description].filter(Boolean).join(' ');
      } else {
        const gl: WebGL2RenderingContext | undefined = backend?.gl;
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        gpu = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? '');
      }
    } catch {
      /* ignore */
    }
    return new GameRenderer(renderer, { backend: isWebGPU ? 'WebGPU' : 'WebGL2', gpu }, scene, camera);
  }

  applyQuality(q: QualityPreset): void {
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap) * q.renderScale);
    r.shadowMap.enabled = q.shadows;
    this.setBloom(q.bloom);
    this.resize();
  }

  private setBloom(on: boolean): void {
    if (on === this.bloomEnabled && (this.pipeline !== null) === on) return;
    this.bloomEnabled = on;
    setBloomSources(on);
    if (!on) {
      this.pipeline?.dispose();
      this.pipeline = null;
      return;
    }
    const scenePass = pass(this.scene, this.camera);
    // Only things with emissive (VFX, sun disk, lanterns) feed the bloom, so the
    // painterly base image stays crisp.
    scenePass.setMRT(mrt({ output, emissive }));
    const color = scenePass.getTextureNode('output');
    const glow = scenePass.getTextureNode('emissive');
    const b = bloom(glow, this.bloomStrength, 0.5, 0);
    this.pipeline = new THREE.RenderPipeline(this.renderer, color.add(b));
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.info.reset();
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
