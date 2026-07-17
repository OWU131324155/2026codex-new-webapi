import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

type PanelKind = 'cases' | 'ai' | 'trophies' | 'archive' | 'system';
type InteractionKind = PanelKind | 'small';
type ChatRole = 'user' | 'assistant';

interface AchievementItem {
  id: string;
  icon: string;
  name: string;
  description: string;
  lockedDescription: string;
  stat: string;
  threshold: number;
  unlocked: boolean;
  progress: number;
}

interface AchievementSnapshot {
  items: AchievementItem[];
  state: {
    caseClears: number;
    miniSuccesses: number;
    miniFailures: number;
    unlocked: string[];
  };
  unlockedCount: number;
  totalCount: number;
}

interface DetectiveAchievementsBridge {
  getSnapshot: () => AchievementSnapshot;
  isDebugEnabled?: () => boolean;
  debugRecord?: (stat: string) => void;
  debugReset?: () => void;
}

interface SolvedCaseArchiveEntry {
  id: string;
  title: string;
  location?: string;
  summary?: string;
  solvedAt?: string;
  turn?: number;
  explanation?: string;
  truth?: {
    culprit?: string;
    motive?: string;
    trick?: string;
    decisiveEvidence?: string;
  };
  evidence?: Array<{ name?: string; type?: string; detail?: string }>;
  testimonies?: Array<{ speaker?: string; claim?: string }>;
  miniResults?: Array<{ label?: string; success?: boolean; grade?: string; summary?: string; turn?: number }>;
}

interface DetectiveArchiveBridge {
  getEntries: () => SolvedCaseArchiveEntry[];
  getEntry: (id: string) => SolvedCaseArchiveEntry | null;
}

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface Interaction {
  kind: InteractionKind;
  title: string;
  description: string;
  message?: string;
}

interface CaseFile {
  id: string;
  title: string;
  difficulty: string;
  atmosphere: string;
  summary: string;
  status: string;
}

interface DetectiveSimBridge {
  hasActiveCase: () => boolean;
  resumeCase: () => boolean;
  abandonCase: () => void;
  getOfficeSummary: () => { active: boolean; label: string; title?: string; turn?: number; status?: string };
}

interface InteractiveMesh extends THREE.Object3D {
  userData: {
    interaction?: Interaction;
    halo?: THREE.Object3D;
    baseEmissive?: number;
  };
}

const stage = document.getElementById('officeStage') as HTMLElement | null;
const canvas = document.getElementById('officeCanvas') as HTMLCanvasElement | null;

class DetectiveOffice {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(66, 1, 0.1, 80);
  private readonly controls: PointerLockControls;
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly interactables: InteractiveMesh[] = [];
  private readonly animated: Array<(elapsed: number, delta: number) => void> = [];
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly move = new THREE.Vector3();
  private focused: InteractiveMesh | null = null;
  private readonly panels = new PanelController();
  private readonly ambience = new Ambience();

  private readonly focusName = document.getElementById('officeFocusName');
  private readonly focusDescription = document.getElementById('officeFocusDescription');
  private readonly officeLog = document.getElementById('officeLog');
  private readonly playerDot = document.getElementById('officePlayerDot') as HTMLElement | null;
  private readonly timeLabel = document.getElementById('officeTimeLabel');
  private readonly lockPrompt = document.getElementById('officeLockPrompt');
  private showPromptOnNextUnlock = false;

  private readonly materials = {
    wall: this.material(0x233039, 0.72, 0.2),
    floor: this.material(0x3e3021, 0.58, 0.42),
    wood: this.material(0x76502e, 0.44, 0.36),
    darkWood: this.material(0x352318, 0.5, 0.42),
    brass: this.material(0xd99b35, 0.27, 0.42),
    paper: this.material(0xe7dcc6, 0.82, 0.04),
    leather: this.material(0x241817, 0.42, 0.18),
    black: this.material(0x081014, 0.48, 0.18),
    cyan: this.material(0x66d8f0, 0.28, 0.08, 0.65),
    red: this.material(0xd95d5d, 0.48, 0.12, 0.2),
    glass: this.material(0x79c7e8, 0.08, 0.02, 0.38, true),
  };

  constructor(private readonly root: HTMLElement, private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.controls = new PointerLockControls(this.camera, document.body);
    this.camera.position.set(0, 1.58, 3.65);
    this.scene.add(this.controls.object);
  }

  start(): void {
    this.scene.background = new THREE.Color(0x05090b);
    this.scene.fog = new THREE.Fog(0x05090b, 8, 20);
    this.raycaster.far = 8.0;

    this.buildLights();
    this.buildRoom();
    this.buildHubObjects();
    this.buildAtmosphere();
    this.bindEvents();
    this.startClock();
    this.resize();
    this.animate();
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('office:return-from-case', () => {
      this.lockPrompt?.classList.add('hidden');
      this.setLog('事件画面から事務所へ戻りました。クリックで探索を再開できます。');
      this.resize();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.panels.isOpen()) {
        this.showPromptOnNextUnlock = true;
        return;
      }
      this.keys.add(event.key.toLowerCase());
    });
    document.addEventListener('keyup', (event) => this.keys.delete(event.key.toLowerCase()));

    this.canvas.addEventListener('click', () => {
      if (this.panels.isOpen()) return;
      if (!this.controls.isLocked) {
        this.controls.lock();
        this.ambience.start();
        return;
      }
      this.activateFocused();
    });
    document.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || this.panels.isOpen() || !this.controls.isLocked) return;
      this.activateFocused();
    });

    this.controls.addEventListener('lock', () => {
      document.body.classList.add('office-pointer-locked');
      this.lockPrompt?.classList.add('hidden');
    });
    this.controls.addEventListener('unlock', () => {
      document.body.classList.remove('office-pointer-locked');
      if (!this.panels.isOpen() && this.showPromptOnNextUnlock) this.lockPrompt?.classList.remove('hidden');
      this.showPromptOnNextUnlock = false;
    });

    this.panels.onClose(() => {
      this.lockPrompt?.classList.add('hidden');
      this.setLog('3D事務所へ戻りました。気になる対象に照準を合わせて調査を続けられます。');
    });
  }

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0x8fa3a6, 0.38));
    this.scene.add(new THREE.HemisphereLight(0x9ec5d6, 0x2a1c15, 0.88));

    const moon = new THREE.DirectionalLight(0x8ec5ff, 1.55);
    moon.position.set(4, 5.5, 2.5);
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    this.scene.add(moon);

    const desk = new THREE.SpotLight(0xffc982, 6.2, 10, Math.PI / 4.8, 0.55, 1.15);
    desk.position.set(-0.65, 3.0, -0.15);
    desk.target.position.set(-0.55, 0.9, -1.25);
    desk.castShadow = true;
    desk.shadow.mapSize.set(1024, 1024);
    this.scene.add(desk, desk.target);
    this.animated.push((elapsed) => {
      desk.intensity = 6.0 + Math.sin(elapsed * 1.7) * 0.16;
    });

    const fill = new THREE.DirectionalLight(0xffe1ad, 0.48);
    fill.position.set(-3.5, 3.6, 3.2);
    this.scene.add(fill);

    const ai = new THREE.PointLight(0x58def0, 2.65, 6.4, 1.45);
    ai.position.set(2.55, 1.25, -0.35);
    this.scene.add(ai);
    this.animated.push((elapsed) => {
      ai.intensity = 2.0 + Math.sin(elapsed * 2.4) * 0.35;
    });
  }

  private buildRoom(): void {
    this.box('floor', [10, 0.12, 9], [0, -0.06, 0], this.materials.floor, true);
    this.box('ceiling', [10, 0.12, 9], [0, 4.18, 0], this.material(0x121b20, 0.76, 0.08), true);
    this.box('backWall', [10, 4.2, 0.14], [0, 2.04, -4.5], this.materials.wall, true);
    this.box('leftWall', [0.14, 4.2, 9], [-5, 2.04, 0], this.materials.wall, true);
    this.box('rightWall', [0.14, 4.2, 9], [5, 2.04, 0], this.materials.wall, true);

    this.box('rug', [3.7, 0.035, 2.45], [0, 0.025, 0.7], this.material(0x743f43, 0.52, 0.05), false);
    this.box('rugTrimA', [3.85, 0.045, 0.08], [0, 0.055, -0.55], this.materials.brass, false);
    this.box('rugTrimB', [3.85, 0.045, 0.08], [0, 0.055, 1.96], this.materials.brass, false);

    this.buildWindow();
    this.buildDoorAndEntry();
    this.buildSofaArea();
    this.buildProps();
  }

  private buildWindow(): void {
    this.box('windowFrame', [2.65, 1.75, 0.1], [3.0, 2.22, -4.38], this.materials.black, true);
    const pane = this.box('rainWindow', [2.42, 1.52, 0.04], [3.0, 2.22, -4.30], this.materials.glass, false);
    this.animated.push((elapsed) => {
      const mat = pane.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.36 + Math.sin(elapsed * 1.8) * 0.06;
    });
    for (let i = 0; i < 9; i += 1) {
      const light = this.box(`cityLight${i}`, [0.08 + (i % 3) * 0.06, 0.18, 0.03], [2.0 + i * 0.24, 1.65 + (i % 4) * 0.18, -4.25], this.material(i % 2 ? 0xff5f7e : 0x4cc9f0, 0.18, 0.05, 0.9), false);
      this.animated.push((elapsed) => {
        (light.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.45 + Math.sin(elapsed * (1.5 + i * 0.2)) * 0.25;
      });
    }
  }

  private buildDoorAndEntry(): void {
    this.interactive('door', [1.15, 2.4, 0.12], [-3.55, 1.2, -4.34], this.material(0x4b2f1e, 0.46, 0.18), {
      kind: 'cases',
      title: '入口のドア',
      description: '依頼人が訪ねてくるドア。事件依頼を確認できます。',
    });
    this.interactive('mailSlot', [0.64, 0.18, 0.06], [-3.55, 1.2, -4.23], this.materials.brass, {
      kind: 'cases',
      title: '郵便受け',
      description: '新しい依頼書が届いています。',
    });
    this.box('coatRackPole', [0.08, 1.75, 0.08], [-4.28, 0.88, -3.35], this.materials.brass, false);
    this.interactive('umbrellaStand', [0.38, 0.45, 0.38], [-4.0, 0.22, -3.25], this.materials.black, {
      kind: 'small',
      title: '傘立て',
      description: '濡れた傘が一本。誰かが来たばかりです。',
      message: '傘の先から水滴が落ちています。雨の日の依頼は、だいたい厄介です。',
    });
  }

  private buildHubObjects(): void {
    this.buildDesk();
    this.buildAiAssistant();
    this.buildTrophyShelf();
    this.buildLibrary();
    this.buildCaseBoard();
    this.buildForensicTable();
  }

  private buildDesk(): void {
    this.interactive('mainDesk', [2.65, 0.82, 1.25], [-0.45, 0.46, -1.05], this.materials.wood, {
      kind: 'cases',
      title: 'メインデスク',
      description: '事件選択、再開、新事件追加を行う探偵デスクです。',
    });
    this.box('deskTop', [2.82, 0.14, 1.38], [-0.45, 0.94, -1.05], this.material(0x9c6734, 0.42, 0.3), true);
    this.interactive('laptop', [0.75, 0.08, 0.5], [-0.95, 1.05, -1.08], this.materials.black, {
      kind: 'cases',
      title: 'ノートPC',
      description: 'メール、依頼、事件ファイルを確認します。',
    });
    const screen = this.box('laptopScreen', [0.75, 0.52, 0.06], [-0.95, 1.35, -1.29], this.materials.cyan, false);
    screen.rotation.x = -0.28;
    this.animated.push((elapsed) => {
      (screen.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.56 + Math.sin(elapsed * 3.2) * 0.18;
    });
    this.interactive('phone', [0.32, 0.12, 0.48], [0.42, 1.08, -1.24], this.materials.black, {
      kind: 'cases',
      title: '電話',
      description: '依頼人からの着信。事件依頼を開きます。',
    });
    this.interactive('coffee', [0.22, 0.24, 0.22], [0.86, 1.15, -0.72], this.material(0xeee0c4, 0.62, 0.04), {
      kind: 'small',
      title: 'コーヒー',
      description: '少し冷めた深煎りコーヒー。',
      message: '苦い香りで少し集中できます。時計の音と雨音が事務所に戻ってきます。',
    });
    this.interactive('caseFile', [0.72, 0.06, 0.42], [-0.12, 1.07, -0.52], this.materials.paper, {
      kind: 'cases',
      title: '事件ファイル',
      description: '現在扱える事件を確認します。',
    });
    this.interactive('deskHotspot', [2.4, 1.05, 0.08], [-0.42, 1.24, -1.82], this.hotspotMaterial(), {
      kind: 'cases',
      title: 'メインデスク',
      description: 'クリックで事件選択、再開、新事件追加を開きます。',
    });
    this.label('CASE DESK', [-0.45, 2.02, -1.52], 0.62);
  }

  private buildAiAssistant(): void {
    this.interactive('aiTerminal', [1.08, 0.32, 0.76], [2.58, 0.28, -0.12], this.materials.black, {
      kind: 'ai',
      title: 'AI助手端末',
      description: '証拠考察、容疑者整理、ヒント、雑談ができます。',
    });
    const holo = this.interactive('aiHologram', [1.12, 1.0, 0.05], [2.58, 1.08, -0.32], this.materials.cyan, {
      kind: 'ai',
      title: 'AIホログラム',
      description: '自然言語で推理相談できます。',
    });
    holo.rotation.y = -0.18;
    this.animated.push((elapsed) => {
      holo.rotation.y = -0.18 + Math.sin(elapsed * 1.6) * 0.05;
      (holo.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.62 + Math.sin(elapsed * 3) * 0.18;
    });
    this.label('AI助手', [2.58, 1.78, -0.32], 0.5);
    this.interactive('aiHotspot', [1.55, 1.5, 0.08], [2.58, 1.08, -0.72], this.hotspotMaterial(), {
      kind: 'ai',
      title: 'AI助手端末',
      description: 'クリックでAIチャット画面を開きます。',
    });
  }

  private buildTrophyShelf(): void {
    this.interactive('trophyShelf', [1.55, 1.75, 0.5], [4.0, 0.92, 1.45], this.materials.darkWood, {
      kind: 'trophies',
      title: 'コレクション棚',
      description: '解除した実績と未解除のコレクションを確認できます。',
    });
    for (let i = 0; i < 6; i += 1) {
      const trophy = this.box(`trophy${i}`, [0.18, 0.36, 0.18], [3.38 + i * 0.24, 1.28 + (i % 2) * 0.42, 1.22], this.materials.brass, false);
      const lod = new THREE.LOD();
      lod.addLevel(trophy, 0);
      this.animated.push((elapsed) => {
        (trophy.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.08 + Math.sin(elapsed * 2.5 + i) * 0.04;
        trophy.rotation.y += 0.004;
      });
    }
  }

  private buildLibrary(): void {
    const shelfMaterial = this.material(0xb47a3a, 0.42, 0.22, 0.03);
    this.interactive('library', [1.55, 2.15, 0.48], [-4.18, 1.08, 0.9], shelfMaterial, {
      kind: 'archive',
      title: '本棚',
      description: '解決済み事件だけが記録される事件アーカイブです。',
    });
    const bookGeometry = new THREE.BoxGeometry(0.08, 0.48, 0.18);
    const bookMaterial = this.material(0x9f3f45, 0.56, 0.02);
    const books = new THREE.InstancedMesh(bookGeometry, bookMaterial, 28);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 28; i += 1) {
      matrix.makeTranslation(-4.82 + (i % 14) * 0.1, 0.62 + Math.floor(i / 14) * 0.72 + (i % 3) * 0.02, 0.66);
      books.setMatrixAt(i, matrix);
    }
    books.castShadow = true;
    books.receiveShadow = true;
    this.scene.add(books);
    this.label('本棚', [-4.18, 2.42, 0.72], 0.48);
  }

  private buildCaseBoard(): void {
    this.interactive('caseBoard', [2.55, 1.6, 0.12], [-3.55, 2.25, -2.9], this.material(0x6a5236, 0.58, 0.12), {
      kind: 'system',
      title: '事件ボード',
      description: '遊び方、設定、操作説明、アップデート情報を表示します。',
    });
    const photos = [
      [-4.18, 2.55, -2.79], [-3.42, 2.7, -2.78], [-2.9, 2.25, -2.79],
      [-4.08, 1.92, -2.78], [-3.28, 1.88, -2.79],
    ];
    photos.forEach((position, index) => {
      this.box(`boardPhoto${index}`, [0.36, 0.28, 0.035], position as [number, number, number], index % 2 ? this.materials.paper : this.material(0xd8e0e1, 0.72, 0.05), false);
    });
    this.thread([-4.18, 2.55, -2.73], [-3.42, 2.7, -2.73]);
    this.thread([-3.42, 2.7, -2.73], [-2.9, 2.25, -2.73]);
    this.thread([-4.08, 1.92, -2.73], [-3.28, 1.88, -2.73]);
    this.label('事件ボード', [-3.55, 3.2, -2.75], 0.62);
  }

  private buildForensicTable(): void {
    this.interactive('forensicTable', [1.35, 0.68, 0.9], [1.8, 0.36, 2.35], this.material(0x4b3426, 0.48, 0.18), {
      kind: 'trophies',
      title: 'コレクション棚',
      description: '実績・コレクションを確認できます。',
    });
    [[1.42, 0.76, 2.15], [1.86, 0.77, 2.45], [2.18, 0.78, 2.18]].forEach((position, index) => {
      const tile = this.box(`forensicPanel${index}`, [0.34, 0.035, 0.26], position as [number, number, number], index === 1 ? this.materials.red : this.materials.cyan, false);
      this.animated.push((elapsed) => {
        (tile.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.32 + Math.sin(elapsed * 3 + index) * 0.12;
      });
    });
    this.label('コレクション棚', [1.8, 1.22, 2.35], 0.5);
  }

  private buildSofaArea(): void {
    this.interactive('sofa', [1.72, 0.48, 0.78], [-2.8, 0.34, 2.15], this.materials.leather, {
      kind: 'small',
      title: '革ソファ',
      description: '依頼人が座る場所。新聞と古いレコードが置かれています。',
      message: 'ソファには誰かが座った跡があります。依頼人の緊張がまだ残っているようです。',
    });
    this.box('sofaBack', [1.78, 0.72, 0.18], [-2.8, 0.76, 2.5], this.materials.leather, true);
    this.box('coffeeTable', [1.16, 0.22, 0.62], [-2.8, 0.24, 1.28], this.materials.wood, true);
    this.interactive('newspaper', [0.58, 0.035, 0.34], [-2.72, 0.38, 1.24], this.materials.paper, {
      kind: 'archive',
      title: '新聞',
      description: '過去の事件記事を確認します。',
    });
  }

  private buildProps(): void {
    this.interactive('safe', [0.7, 0.72, 0.58], [4.1, 0.36, -3.45], this.materials.black, {
      kind: 'small',
      title: '金庫',
      description: '古い事件資料と未公開証拠が入っています。',
      message: 'ダイヤルは重い。今はまだ開ける必要はなさそうです。',
    });
    this.interactive('clock', [0.52, 0.52, 0.06], [0.3, 2.72, -4.35], this.materials.brass, {
      kind: 'small',
      title: '壁掛け時計',
      description: '秒針が静かに事務所の時間を刻みます。',
      message: '午前0時17分。事件が動き出すには十分すぎる時間です。',
    });
    this.box('plantPot', [0.38, 0.34, 0.38], [-4.25, 0.17, 3.25], this.material(0x5a3322, 0.62, 0.02), true);
    const leaves = this.box('plantLeaves', [0.7, 0.62, 0.7], [-4.25, 0.7, 3.25], this.material(0x315235, 0.72, 0.02), false);
    this.animated.push((elapsed) => {
      leaves.rotation.y = Math.sin(elapsed * 0.9) * 0.05;
    });
  }

  private buildAtmosphere(): void {
    const rainGeometry = new THREE.BufferGeometry();
    const drops = 220;
    const positions = new Float32Array(drops * 3);
    for (let i = 0; i < drops; i += 1) {
      positions[i * 3] = 1.7 + Math.random() * 3.0;
      positions[i * 3 + 1] = 0.2 + Math.random() * 3.5;
      positions[i * 3 + 2] = -4.18 + Math.random() * 0.32;
    }
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const rain = new THREE.Points(rainGeometry, new THREE.PointsMaterial({
      color: 0x9bd5ff,
      size: 0.035,
      transparent: true,
      opacity: 0.72,
    }));
    this.scene.add(rain);
    this.animated.push((_elapsed, delta) => {
      for (let i = 0; i < drops; i += 1) {
        const y = i * 3 + 1;
        positions[y] -= delta * 3.8;
        if (positions[y] < 0.1) positions[y] = 3.6;
      }
      rainGeometry.attributes.position.needsUpdate = true;
    });
  }

  private animate(): void {
    const delta = Math.min(this.clock.getDelta(), 0.04);
    const elapsed = this.clock.elapsedTime;
    if (this.controls.isLocked && !this.panels.isOpen()) this.updateMovement(delta);
    this.updateFocus();
    this.animated.forEach((animate) => animate(elapsed, delta));
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.animate());
  }

  private updateMovement(delta: number): void {
    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();
    this.right.crossVectors(this.forward, this.camera.up).normalize();
    this.move.set(0, 0, 0);
    if (this.keys.has('w') || this.keys.has('arrowup')) this.move.add(this.forward);
    if (this.keys.has('s') || this.keys.has('arrowdown')) this.move.sub(this.forward);
    if (this.keys.has('d') || this.keys.has('arrowright')) this.move.add(this.right);
    if (this.keys.has('a') || this.keys.has('arrowleft')) this.move.sub(this.right);
    if (this.move.lengthSq() === 0) return;
    const speed = this.keys.has('shift') ? 5.1 : 3.1;
    this.move.normalize().multiplyScalar(speed * delta);
    this.controls.moveRight(this.move.dot(this.right));
    this.controls.moveForward(this.move.dot(this.forward));
    const object = this.controls.object;
    object.position.x = THREE.MathUtils.clamp(object.position.x, -4.35, 4.35);
    object.position.z = THREE.MathUtils.clamp(object.position.z, -3.75, 3.65);
    this.updateMiniMap(object.position);
  }

  private updateFocus(): void {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects(this.interactables, false)[0];
    const next = (hit?.object as InteractiveMesh | undefined) ?? this.findNearbyTarget();
    if (next === this.focused) return;
    this.setFocused(next ?? null);
  }

  private setFocused(mesh: InteractiveMesh | null): void {
    if (this.focused?.userData.halo) this.focused.userData.halo.visible = false;
    this.focused = mesh;
    if (mesh?.userData.halo) mesh.userData.halo.visible = true;
    const interaction = mesh?.userData.interaction;
    this.setFocus(interaction?.title ?? '事務所を探索中', interaction?.description ?? '近づいて左クリックで調べます。Escで視点ロック解除。');
  }

  private activateFocused(): void {
    const target = this.focused ?? this.findNearbyTarget();
    const interaction = target?.userData.interaction;
    if (!interaction) {
      this.controls.unlock();
      this.setLog('調査できる対象に照準を合わせてください。');
      return;
    }
    this.controls.unlock();
    if (interaction.kind === 'small') {
      this.setLog(interaction.message ?? interaction.description);
      return;
    }
    this.panels.open(interaction.kind, interaction.title);
  }

  private findNearbyTarget(): InteractiveMesh | null {
    this.camera.getWorldDirection(this.forward);
    this.forward.normalize();
    const cameraPosition = new THREE.Vector3();
    this.camera.getWorldPosition(cameraPosition);
    let best: { mesh: InteractiveMesh; score: number } | null = null;
    for (const mesh of this.interactables) {
      const direction = mesh.position.clone().sub(cameraPosition);
      const distance = direction.length();
      if (distance > 8.0) continue;
      direction.normalize();
      const facing = direction.dot(this.forward);
      if (facing < 0.54) continue;
      const score = facing * 2.2 - distance * 0.22;
      if (!best || score > best.score) best = { mesh, score };
    }
    return best?.mesh ?? null;
  }

  private resize(): void {
    const rect = this.root.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private updateMiniMap(position: THREE.Vector3): void {
    if (!this.playerDot) return;
    const x = THREE.MathUtils.mapLinear(position.x, -4.35, 4.35, 18, 122);
    const y = THREE.MathUtils.mapLinear(position.z, -3.75, 3.65, 18, 88);
    this.playerDot.style.left = `${x}px`;
    this.playerDot.style.top = `${y}px`;
  }

  private startClock(): void {
    const update = (): void => {
      if (!this.timeLabel) return;
      this.timeLabel.textContent = new Intl.DateTimeFormat('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    };
    update();
    window.setInterval(update, 1000);
  }

  private setFocus(title: string, description: string): void {
    if (this.focusName) this.focusName.textContent = title;
    if (this.focusDescription) this.focusDescription.textContent = description;
  }

  private setLog(message: string): void {
    if (this.officeLog) this.officeLog.textContent = message;
  }

  private interactive(name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material, interaction: Interaction): THREE.Mesh {
    const mesh = this.box(name, size, position, material, true) as InteractiveMesh;
    mesh.userData.interaction = interaction;
    mesh.userData.halo = this.createHalo(size, position);
    this.interactables.push(mesh);
    return mesh as THREE.Mesh;
  }

  private box(name: string, size: [number, number, number], position: [number, number, number], material: THREE.Material, castShadow: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    return mesh;
  }

  private createHalo(size: [number, number, number], position: [number, number, number]): THREE.Object3D {
    const halo = new THREE.Mesh(
      new THREE.BoxGeometry(size[0] + 0.09, size[1] + 0.09, size[2] + 0.09),
      new THREE.MeshBasicMaterial({ color: 0xffd279, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    halo.position.set(...position);
    halo.visible = false;
    this.scene.add(halo);
    this.animated.push((elapsed) => {
      const material = halo.material as THREE.MeshBasicMaterial;
      material.opacity = 0.12 + Math.sin(elapsed * 4) * 0.05;
    });
    return halo;
  }

  private thread(start: [number, number, number], end: [number, number, number]): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...start), new THREE.Vector3(...end)]);
    this.scene.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xd95d5d })));
  }

  private label(text: string, position: [number, number, number], scale: number): void {
    const texture = this.labelTexture(text);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.position.set(...position);
    sprite.scale.set(scale * 2.4, scale * 0.72, 1);
    this.scene.add(sprite);
  }

  private labelTexture(text: string): THREE.CanvasTexture {
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512;
    labelCanvas.height = 160;
    const ctx = labelCanvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is unavailable');
    ctx.fillStyle = 'rgba(10, 18, 21, 0.78)';
    ctx.strokeStyle = 'rgba(255, 230, 174, 0.72)';
    ctx.lineWidth = 4;
    ctx.roundRect(18, 28, 476, 94, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff0c4';
    ctx.font = 'bold 46px "Yu Gothic UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 76);
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private material(color: number, roughness: number, metalness: number, emissive = 0, transparent = false): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      transparent,
      opacity: transparent ? 0.58 : 1,
      emissive: new THREE.Color(color),
      emissiveIntensity: emissive,
    });
  }

  private hotspotMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
  }
}

class PanelController {
  private readonly panel = document.getElementById('officePanel');
  private readonly title = document.getElementById('officePanelTitle');
  private readonly kicker = document.getElementById('officePanelKicker');
  private readonly body = document.getElementById('officePanelBody');
  private readonly close = document.getElementById('officePanelClose');
  private closeCallbacks: Array<() => void> = [];
  private assistantHistory: ChatMessage[] = [];
  private generatingCases = false;
  private caseFiles: CaseFile[] = [
    {
      id: 'demo-macaron',
      title: '消えたマカロン',
      status: '進行中',
      difficulty: '低',
      atmosphere: '放課後カフェ、雨、甘い違和感',
      summary: '放課後のカフェで限定マカロンが消えた。店員、常連客、配達員の証言に小さな矛盾がある。',
    },
    {
      id: 'future-broadcast',
      title: '未来放送の夜',
      status: '未着手',
      difficulty: '中',
      atmosphere: '文化祭前夜、無人の放送室',
      summary: '文化祭前夜、まだ起きていない事件を告げる放送が無人の放送室から流れた。',
    },
    {
      id: 'hotel-13',
      title: '13階の招待状',
      status: '保留',
      difficulty: '高',
      atmosphere: '古いホテル、存在しない階',
      summary: '存在しないはずの13階ボタンが光る古いホテル。差出人不明の鍵が残されている。',
    },
  ];

  constructor() {
    this.close?.addEventListener('click', () => this.hide());
  }

  isOpen(): boolean {
    return !this.panel?.classList.contains('hidden');
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  open(kind: PanelKind, sourceTitle: string): void {
    if (!this.panel || !this.body || !this.title || !this.kicker) return;
    const panel = this.panel;
    const body = this.body;
    const title = this.title;
    const kicker = this.kicker;
    document.body.classList.add('office-transitioning');
    window.setTimeout(() => {
      kicker.textContent = sourceTitle;
      title.textContent = this.titleFor(kind);
      body.innerHTML = this.render(kind);
      panel.classList.remove('hidden');
      this.bind(kind);
      document.body.classList.remove('office-transitioning');
    }, 280);
  }

  private hide(): void {
    document.body.classList.add('office-returning');
    window.setTimeout(() => {
      this.panel?.classList.add('hidden');
      document.body.classList.remove('office-returning');
      this.closeCallbacks.forEach((callback) => callback());
    }, 260);
  }

  private titleFor(kind: PanelKind): string {
    return {
      cases: '事件画面',
      ai: 'AIチャット画面',
            trophies: '実績・コレクション画面',
      archive: '事件アーカイブ',
      system: 'システム画面',
    }[kind];
  }

  private render(kind: PanelKind): string {
    if (kind === 'cases') return this.renderCases();
    if (kind === 'ai') return this.renderAi();
    if (kind === 'trophies') return this.renderTrophies();
    if (kind === 'archive') return this.renderArchive();
    return this.renderSystem();
  }

  private renderCases(): string {
    const active = this.getDetectiveSim()?.getOfficeSummary();
    const activeBlock = active?.active ? `
      <article class="hub-card active-case-card">
        <span class="hud-kicker">Active Investigation</span>
        <strong>${this.escape(active.title || '進行中事件')}</strong>
        <p>Turn ${active.turn || 1} / ${this.escape(active.status || '捜査中')}</p>
        <div class="actions">
          <button class="hub-button primary" data-resume-active-case type="button">進行中の事件を再開</button>
          <button class="hub-button ghost" data-abandon-active-case type="button">事件を放棄</button>
        </div>
      </article>
    ` : '';
    const cards = this.caseFiles.map((file, index) => `
      <article class="hub-card">
        <span class="hud-kicker">${this.escape(file.status)} / 難易度 ${this.escape(file.difficulty)}</span>
        <strong>${this.escape(file.title)}</strong>
        <span>${this.escape(file.atmosphere)}</span>
        <p>${this.escape(file.summary)}</p>
        <div class="actions">
          <button class="hub-button primary" data-case-start="${index}" type="button">この事件を受注</button>
          <button class="hub-button ghost" data-case-select="${index}" type="button">事件詳細</button>
        </div>
      </article>
    `).join('');
    return `
      ${activeBlock}
      <div class="screen-grid">${cards}</div>
      <div class="actions">
        <button class="hub-button primary" data-generate-cases type="button">OpenAIで3件を新規生成</button>
        <button class="hub-button" data-resume-case type="button">最後の事件を再開</button>
      </div>
    `;
  }

  private renderCaseGenerationShell(): string {
    const active = this.getDetectiveSim()?.getOfficeSummary();
    const activeBlock = active?.active ? `
      <article class="hub-card active-case-card">
        <span class="hud-kicker">Active Investigation</span>
        <strong>${this.escape(active.title || '進行中事件')}</strong>
        <p>Turn ${active.turn || 1} / ${this.escape(active.status || '捜査中')}</p>
        <div class="actions">
          <button class="hub-button ghost" data-resume-active-case type="button">進行中の事件を再開</button>
        </div>
      </article>
    ` : '';
    return `
      ${activeBlock}
      <article class="hub-card case-loading-card">
        <span class="hud-kicker">OpenAI API</span>
        <strong>新しい事件候補を生成中</strong>
        <p>毎回違う舞台、人物、動機、トリック、証拠を持つ3件の事件ファイルを作成しています。</p>
        <div class="loading-bar"><i></i></div>
      </article>
    `;
  }

  private renderAi(): string {
    return `
      <div class="assistant-chat-shell">
        <aside class="assistant-side">
          <span class="hud-kicker">Partner AI</span>
          <strong>相棒AI</strong>
          <span class="assistant-status" id="officeAssistantStatus">待機中</span>
          <button class="hub-button ghost" data-ai-chip="今の事件で次に見るべき場所を一つだけ教えて" type="button">次の一手</button>
          <button class="hub-button ghost" data-ai-chip="証拠を3行で整理して" type="button">証拠整理</button>
          <button class="hub-button ghost" data-ai-chip="ミニゲームが苦手な時の進め方を教えて" type="button">操作相談</button>
        </aside>
        <section class="assistant-main">
          <div class="chat-log assistant-chat-log" id="officeChatLog" aria-live="polite">
            ${this.renderChatHistory()}
          </div>
          <form class="chat-form" id="officeChatForm">
            <input id="officeChatInput" type="text" placeholder="相棒AIに相談する" autocomplete="off" maxlength="600">
            <button class="hub-button primary" type="submit">送信</button>
          </form>
        </section>
      </div>
    `;
  }

  private renderTrophies(): string {
    const snapshot = this.getAchievements()?.getSnapshot();
    if (!snapshot) {
      return '<article class="hub-card"><strong>実績データ読み込み中</strong><p>事件画面の初期化後にもう一度コレクション棚を開いてください。</p></article>';
    }
    const rate = snapshot.totalCount ? Math.round((snapshot.unlockedCount / snapshot.totalCount) * 100) : 0;
    const debugPanel = this.getAchievements()?.isDebugEnabled?.() ? `
      <div class="achievement-debug">
        <span class="hud-kicker">Achievement Check</span>
        <strong>確認用操作</strong>
        <div class="actions">
          <button class="hub-button primary" data-achievement-debug="caseClears" type="button">事件解決 +1</button>
          <button class="hub-button primary" data-achievement-debug="miniSuccesses" type="button">ミニ成功 +1</button>
          <button class="hub-button primary" data-achievement-debug="miniFailures" type="button">ミニ失敗 +1</button>
          <button class="hub-button ghost" data-achievement-reset type="button">実績をリセット</button>
        </div>
      </div>
    ` : '';
    return `
      <div class="collection-cabinet">
        <div class="collection-rate">
          <b>${rate}%</b>
          <div>
            <span class="hud-kicker">Collection Rate</span>
            <div class="meter"><i style="width: ${rate}%"></i></div>
          </div>
        </div>
        <div class="collection-stats">
          <span>事件解決 ${snapshot.state.caseClears}</span>
          <span>捜査成功 ${snapshot.state.miniSuccesses}</span>
          <span>捜査失敗 ${snapshot.state.miniFailures}</span>
          <span>${snapshot.unlockedCount}/${snapshot.totalCount} 解除</span>
        </div>
      </div>
      ${debugPanel}
      <div class="achievement-grid">${snapshot.items.map((item) => `
        <article class="achievement-card ${item.unlocked ? 'unlocked' : 'locked'}">
          <div class="achievement-icon">${item.unlocked ? this.escape(item.icon) : '🔒'}</div>
          <div>
            <span class="hud-kicker">${item.unlocked ? 'Unlocked' : `Progress ${item.progress}/${item.threshold}`}</span>
            <strong>${item.unlocked ? '✅ ' : '🔒 '}${this.escape(item.name)}</strong>
            <p>${this.escape(item.unlocked ? item.description : item.lockedDescription)}</p>
          </div>
        </article>
      `).join('')}</div>
    `;
  }

  private getAchievements(): DetectiveAchievementsBridge | undefined {
    return (window as Window & { detectiveAchievements?: DetectiveAchievementsBridge }).detectiveAchievements;
  }

  private renderArchive(): string {
    const solved = this.getArchive()?.getEntries() || [];
    if (!solved.length) {
      return `
        <article class="archive-empty">
          <span class="hud-kicker">Case Archive</span>
          <strong>まだ記録された事件はありません</strong>
          <p>事件を解決すると、真相、証拠、証言、ミニゲーム結果がこの本棚へ初めて記録されます。</p>
        </article>
      `;
    }
    return `
      <div class="archive-list">${solved.map((entry) => `
        <article class="archive-row">
          <div>
            <strong>${this.escape(entry.title)}</strong>
            <span>${this.formatArchiveDate(entry.solvedAt)} / Turn ${entry.turn || '-'}</span>
            <span>${this.escape(entry.location || '現場未記録')} / 証拠 ${entry.evidence?.length || 0} / 証言 ${entry.testimonies?.length || 0} / 捜査結果 ${entry.miniResults?.length || 0}</span>
          </div>
          <button class="hub-button ghost" type="button" data-archive-open="${this.escape(entry.id)}">閲覧</button>
        </article>
      `).join('')}</div>
    `;
  }

  private getArchive(): DetectiveArchiveBridge | undefined {
    return (window as Window & { detectiveArchive?: DetectiveArchiveBridge }).detectiveArchive;
  }

  private renderArchiveDetail(entry: SolvedCaseArchiveEntry): string {
    const truth = entry.truth || {};
    const evidence = entry.evidence || [];
    const testimonies = entry.testimonies || [];
    const minis = entry.miniResults || [];
    return `
      <div class="archive-detail">
        <button class="hub-button ghost" data-archive-back type="button">一覧へ戻る</button>
        <section class="archive-case-file">
          <span class="hud-kicker">Solved Case File</span>
          <strong>${this.escape(entry.title)}</strong>
          <p>${this.escape(entry.summary || '概要未記録')}</p>
          <div class="archive-facts">
            <span>${this.formatArchiveDate(entry.solvedAt)}</span>
            <span>${this.escape(entry.location || '現場未記録')}</span>
            <span>Turn ${entry.turn || '-'}</span>
          </div>
        </section>
        <section class="archive-case-file">
          <span class="hud-kicker">Truth</span>
          <p>${this.escape(entry.explanation || '真相メモは未記録です。')}</p>
          <div class="archive-facts">
            <span>犯人: ${this.escape(truth.culprit || '未記録')}</span>
            <span>動機: ${this.escape(truth.motive || '未記録')}</span>
            <span>トリック: ${this.escape(truth.trick || '未記録')}</span>
            <span>決定的証拠: ${this.escape(truth.decisiveEvidence || '未記録')}</span>
          </div>
        </section>
        <div class="archive-columns">
          <section class="archive-case-file">
            <span class="hud-kicker">Evidence</span>
            ${evidence.length ? evidence.map((item) => `<p><b>${this.escape(item.name || '証拠')}</b> ${this.escape(item.detail || item.type || '')}</p>`).join('') : '<p>証拠は記録されていません。</p>'}
          </section>
          <section class="archive-case-file">
            <span class="hud-kicker">Testimony</span>
            ${testimonies.length ? testimonies.map((item) => `<p><b>${this.escape(item.speaker || '証言者')}</b> ${this.escape(item.claim || '')}</p>`).join('') : '<p>証言は記録されていません。</p>'}
          </section>
          <section class="archive-case-file">
            <span class="hud-kicker">Mini Games</span>
            ${minis.length ? minis.map((item) => `<p><b>${this.escape(item.label || '捜査')}</b> ${item.success ? '成功' : '失敗'} / ${this.escape(item.grade || '')} ${this.escape(item.summary || '')}</p>`).join('') : '<p>ミニゲーム結果はありません。</p>'}
          </section>
        </div>
      </div>
    `;
  }

  private formatArchiveDate(value?: string): string {
    if (!value) return '記録日時なし';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
  }

  private renderSystem(): string {
    return `
      <div class="system-dashboard">
        <nav class="system-menu" aria-label="システムメニュー">
          <button class="system-tile active" data-system-action="settings" type="button"><strong>設定</strong><span>音量 / 演出 / 照準 / 会話速度</span></button>
          <button class="system-tile" data-system-action="howto" type="button"><strong>遊び方</strong><span>事務所と事件画面の流れ</span></button>
          <button class="system-tile" data-system-action="controls" type="button"><strong>操作説明</strong><span>WASD / Shift / Mouse / Esc</span></button>
          <button class="system-tile" data-system-action="update" type="button"><strong>アップデート</strong><span>3D事務所 + 2D捜査</span></button>
          <button class="system-tile" data-system-action="credits" type="button"><strong>クレジット</strong><span>技術構成</span></button>
        </nav>
        <section class="system-detail" id="systemDetail">
          ${this.renderSystemDetail('settings')}
        </section>
      </div>
    `;
  }

  private renderSystemDetail(kind: string): string {
    if (kind === 'settings') {
      return `
        <span class="hud-kicker">Settings</span>
        <strong>プレイ設定</strong>
        <label class="system-control">音量 <input id="systemVolume" type="range" min="0" max="100" value="55"></label>
        <label class="system-control">画面演出 <select id="systemFx"><option>標準</option><option>控えめ</option><option>強め</option></select></label>
        <label class="system-control inline"><input id="systemReticle" type="checkbox" checked> 照準表示</label>
        <label class="system-control">会話速度 <input id="systemSpeed" type="range" min="1" max="5" value="3"></label>
        <p id="systemApplyText">変更はこの画面で即時反映されます。</p>
      `;
    }
    if (kind === 'howto') {
      return '<span class="hud-kicker">How To</span><strong>遊び方</strong><div class="system-steps"><b>1. メインデスクで事件受注</b><b>2. 聞き込みかミニゲームで捜査</b><b>3. Turn 4から最終推理</b><b>4. 解決後にリザルト確認</b></div>';
    }
    if (kind === 'controls') {
      return '<span class="hud-kicker">Controls</span><strong>操作説明</strong><div class="key-grid"><b>WASD</b><span>移動</span><b>Shift</b><span>早歩き</span><b>Mouse</b><span>視点</span><b>Left Click</b><span>調査</span><b>Esc</b><span>メニューへ</span></div>';
    }
    if (kind === 'update') {
      return '<span class="hud-kicker">Update</span><strong>アップデート</strong><p>ホームを3D探偵事務所へ統合し、事件受注、AI生成、2D捜査、ミニゲーム、最終推理、リザルト画面を一連の体験として再構成しました。</p>';
    }
    return '<span class="hud-kicker">Credits</span><strong>クレジット</strong><p>AI探偵シミュレーション UI prototype</p><div class="tech-list"><span>Node.js</span><span>Express</span><span>OpenAI API</span><span>Three.js</span></div>';
  }

  private bind(kind: PanelKind): void {
    if (kind === 'cases') this.bindCases(true);
    if (kind === 'ai') this.bindAi();
    if (kind === 'trophies') this.bindTrophies();
    if (kind === 'archive') this.bindArchive();
    if (kind === 'system') this.bindSystem();
  }

  private bindTrophies(): void {
    const achievements = this.getAchievements();
    this.body?.querySelectorAll<HTMLElement>('[data-achievement-debug]').forEach((button) => {
      button.addEventListener('click', () => {
        achievements?.debugRecord?.(button.dataset.achievementDebug || '');
        this.refreshTrophies();
      });
    });
    this.body?.querySelector<HTMLElement>('[data-achievement-reset]')?.addEventListener('click', () => {
      achievements?.debugReset?.();
      this.refreshTrophies();
    });
  }

  private refreshTrophies(): void {
    if (!this.body) return;
    this.body.innerHTML = this.renderTrophies();
    this.bindTrophies();
  }

  private bindCases(autoGenerate = false): void {
    this.body?.querySelectorAll<HTMLElement>('[data-case-start]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.caseStart ?? 0);
        const file = this.caseFiles[index] ?? this.caseFiles[0];
        this.startOrConfirmCase(file);
      });
    });
    this.body?.querySelectorAll<HTMLElement>('[data-case-select]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.caseSelect ?? 0);
        const file = this.caseFiles[index] ?? this.caseFiles[0];
        this.notice(`事件詳細: ${file.title} / 難易度 ${file.difficulty} / ${file.atmosphere}`);
      });
    });
    this.body?.querySelector('[data-generate-cases]')?.addEventListener('click', () => {
      void this.generateCases();
    });
    this.body?.querySelector('[data-resume-case]')?.addEventListener('click', () => {
      if (!this.getDetectiveSim()?.resumeCase()) {
        this.startOrConfirmCase(this.caseFiles[0]);
      }
      this.hide();
    });
    this.body?.querySelector('[data-resume-active-case]')?.addEventListener('click', () => {
      this.getDetectiveSim()?.resumeCase();
      this.hide();
    });
    this.body?.querySelector('[data-abandon-active-case]')?.addEventListener('click', () => {
      this.confirmAbandonOnly();
    });
    if (autoGenerate) void this.generateCases(true);
  }

  private startOrConfirmCase(file: CaseFile): void {
    const sim = this.getDetectiveSim();
    if (!sim?.hasActiveCase()) {
      window.dispatchEvent(new CustomEvent('detective:start-case', { detail: file }));
      this.hide();
      return;
    }
    if (!this.body) return;
    const active = sim.getOfficeSummary();
    this.body.innerHTML = `
      <article class="hub-card active-case-card">
        <span class="hud-kicker">Confirm Abandon</span>
        <strong>進行中の事件を放棄しますか？</strong>
        <p>現在の事件: ${this.escape(active.title || '進行中事件')} / Turn ${active.turn || 1}</p>
        <p>新しい事件「${this.escape(file.title)}」を始めると、現在の捜査は放棄扱いになります。</p>
        <div class="actions">
          <button class="hub-button primary" data-confirm-abandon-start type="button">放棄して新事件を始める</button>
          <button class="hub-button ghost" data-resume-active-case type="button">今の事件を再開</button>
          <button class="hub-button" data-cancel-abandon type="button">戻る</button>
        </div>
      </article>
    `;
    this.body.querySelector('[data-confirm-abandon-start]')?.addEventListener('click', () => {
      sim.abandonCase();
      window.dispatchEvent(new CustomEvent('detective:start-case', { detail: file }));
      this.hide();
    });
    this.body.querySelector('[data-resume-active-case]')?.addEventListener('click', () => {
      sim.resumeCase();
      this.hide();
    });
    this.body.querySelector('[data-cancel-abandon]')?.addEventListener('click', () => {
      this.body!.innerHTML = this.renderCases();
      this.bindCases(false);
    });
  }

  private confirmAbandonOnly(): void {
    const sim = this.getDetectiveSim();
    if (!sim?.hasActiveCase() || !this.body) return;
    const active = sim.getOfficeSummary();
    this.body.innerHTML = `
      <article class="hub-card active-case-card">
        <span class="hud-kicker">Confirm</span>
        <strong>事件を放棄しますか？</strong>
        <p>${this.escape(active.title || '進行中事件')} / Turn ${active.turn || 1}</p>
        <div class="actions">
          <button class="hub-button primary" data-confirm-abandon-only type="button">放棄する</button>
          <button class="hub-button ghost" data-cancel-abandon type="button">戻る</button>
        </div>
      </article>
    `;
    this.body.querySelector('[data-confirm-abandon-only]')?.addEventListener('click', () => {
      sim.abandonCase();
      this.body!.innerHTML = this.renderCases();
      this.bindCases(false);
    });
    this.body.querySelector('[data-cancel-abandon]')?.addEventListener('click', () => {
      this.body!.innerHTML = this.renderCases();
      this.bindCases(false);
    });
  }

  private async generateCases(isInitial = false): Promise<void> {
    if (!this.body) return;
    if (this.generatingCases) return;
    this.generatingCases = true;
    const previousTitles = this.caseFiles.map((file) => file.title).filter(Boolean);
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (isInitial) {
      this.body.innerHTML = this.renderCaseGenerationShell();
      this.body.querySelector('[data-resume-active-case]')?.addEventListener('click', () => {
        this.getDetectiveSim()?.resumeCase();
        this.hide();
      });
    }
    const button = this.body.querySelector<HTMLButtonElement>('[data-generate-cases]');
    if (button) {
      button.disabled = true;
      button.textContent = isInitial ? '最新事件を取得中...' : 'AI生成中...';
    }
    const loadingCard = isInitial ? null : document.createElement('article');
    if (loadingCard) {
      loadingCard.className = 'hub-card';
      loadingCard.innerHTML = '<span class="hud-kicker">OpenAI API</span><strong>事件候補を生成中</strong><p>毎回違う3件の事件ファイルを組み立てています。</p>';
      this.body.appendChild(loadingCard);
    }
    try {
      const response = await fetch('/api/detective', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'case-options',
          generation: {
            requestId,
            requestedAt: new Date().toISOString(),
            previousTitles,
          },
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || response.statusText);
      }
      const payload = await response.json();
      if (!Array.isArray(payload.cases) || payload.cases.length < 3) {
        throw new Error('事件候補の形式が不正です。');
      }
      this.caseFiles = payload.cases.slice(0, 3).map((file: Partial<CaseFile>, index: number) => ({
        id: file.id || `ai-case-${Date.now()}-${index}`,
        title: file.title || `未命名事件 ${index + 1}`,
        difficulty: file.difficulty || '中',
        atmosphere: file.atmosphere || 'ノワール',
        summary: file.summary || 'AIが生成した新しい事件。',
        status: '新規',
      }));
      this.body.innerHTML = this.renderCases();
      this.bindCases(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成に失敗しました。';
      this.notice(`AI事件生成に失敗しました。${this.formatChatError(message)}`);
      if (button) {
        button.disabled = false;
        button.textContent = 'OpenAIで3件を新規生成';
      }
    } finally {
      this.generatingCases = false;
    }
  }

  private getDetectiveSim(): DetectiveSimBridge | undefined {
    return (window as Window & { detectiveSim?: DetectiveSimBridge }).detectiveSim;
  }

  private bindAi(): void {
    const form = this.body?.querySelector<HTMLFormElement>('#officeChatForm');
    const input = this.body?.querySelector<HTMLInputElement>('#officeChatInput');
    const log = this.body?.querySelector<HTMLElement>('#officeChatLog');
    const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
    const status = this.body?.querySelector<HTMLElement>('#officeAssistantStatus') ?? null;
    const send = async (text: string): Promise<void> => {
      if (!text || !log) return;
      this.appendChatLine(log, 'user', text);
      this.assistantHistory.push({ role: 'user', content: text });
      const thinking = this.appendChatLine(log, 'assistant', '通信回線を開いています...');
      log.scrollTop = log.scrollHeight;
      this.setChatBusy(true, input, submitButton, status);
      try {
        const response = await fetch('/api/assistant-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            history: this.assistantHistory.slice(0, -1),
            context: this.collectGameContext(),
          }),
        });
        if (!response.ok) {
          const errorText = await response.text();
          let message = errorText || response.statusText;
          try {
            const error = JSON.parse(errorText);
            message = error.error || message;
          } catch {
            message = errorText || response.statusText;
          }
          throw new Error(message);
        }
        const payload = await response.json();
        const reply = String(payload.reply || '返答を取得できませんでした。');
        thinking.textContent = reply;
        this.assistantHistory.push({ role: 'assistant', content: reply });
      } catch (error) {
        const message = error instanceof Error ? error.message : '通信に失敗しました。';
        thinking.textContent = `AI助手: 通信に失敗しました。${this.formatChatError(message)}`;
      } finally {
        this.assistantHistory = this.assistantHistory.slice(-16);
        this.setChatBusy(false, input, submitButton, status);
        log.scrollTop = log.scrollHeight;
      }
    };
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input?.value.trim() ?? '';
      if (input) input.value = '';
      void send(text);
    });
    this.body?.querySelectorAll<HTMLElement>('[data-ai-chip]').forEach((button) => {
      button.addEventListener('click', () => {
        const text = button.dataset.aiChip ?? '相談したい';
        if (input) input.value = text;
        void send(text);
      });
    });
    if (log) log.scrollTop = log.scrollHeight;
  }

  private bindArchive(): void {
    this.body?.querySelectorAll<HTMLElement>('[data-archive-open]').forEach((button) => {
      button.addEventListener('click', () => {
        const entry = this.getArchive()?.getEntry(button.dataset.archiveOpen || '');
        if (!entry || !this.body) return;
        this.body.innerHTML = this.renderArchiveDetail(entry);
        this.body.querySelector('[data-archive-back]')?.addEventListener('click', () => {
          this.body!.innerHTML = this.renderArchive();
          this.bindArchive();
        });
      });
    });
  }

  private bindSystem(): void {
    const detail = this.body?.querySelector<HTMLElement>('#systemDetail');
    const bindDetailControls = (): void => {
      this.body?.querySelector<HTMLInputElement>('#systemReticle')?.addEventListener('change', (event) => {
        const checked = (event.currentTarget as HTMLInputElement).checked;
        document.querySelector<HTMLElement>('.office-reticle')?.classList.toggle('hidden', !checked);
      });
      this.body?.querySelector<HTMLInputElement>('#systemVolume')?.addEventListener('input', (event) => {
        const text = this.body?.querySelector<HTMLElement>('#systemApplyText');
        if (text) text.textContent = `音量 ${Math.round(Number((event.currentTarget as HTMLInputElement).value))}% に設定しました。`;
      });
      this.body?.querySelector<HTMLSelectElement>('#systemFx')?.addEventListener('change', (event) => {
        document.body.dataset.fx = (event.currentTarget as HTMLSelectElement).value;
      });
      this.body?.querySelector<HTMLInputElement>('#systemSpeed')?.addEventListener('input', (event) => {
        const text = this.body?.querySelector<HTMLElement>('#systemApplyText');
        if (text) text.textContent = `会話速度 ${Number((event.currentTarget as HTMLInputElement).value)} に設定しました。`;
      });
    };
    this.body?.querySelectorAll<HTMLElement>('[data-system-action]').forEach((button) => {
      button.addEventListener('click', () => {
        this.body?.querySelectorAll<HTMLElement>('.system-tile').forEach((tile) => tile.classList.toggle('active', tile === button));
        if (detail) detail.innerHTML = this.renderSystemDetail(button.dataset.systemAction || 'settings');
        bindDetailControls();
      });
    });
    bindDetailControls();
  }

  private notice(message: string): void {
    const item = document.createElement('article');
    item.className = 'hub-card';
    item.innerHTML = `<strong>操作ログ</strong><p>${this.escape(message)}</p>`;
    this.body?.appendChild(item);
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private renderChatHistory(): string {
    if (!this.assistantHistory.length) {
      return '<div class="chat-line assistant">AI助手: こんばんは。事件中ならヒント、証拠整理、推理相談、操作説明を手伝います。まずは気になる証拠や詰まっている点を聞かせてください。</div>';
    }
    return this.assistantHistory.slice(-6).map((item) => {
      const label = item.role === 'user' ? 'あなた' : 'AI助手';
      return `<div class="chat-line ${item.role}">${label}: ${this.escape(item.content)}</div>`;
    }).join('');
  }

  private appendChatLine(log: HTMLElement, role: ChatRole, text: string): HTMLElement {
    const line = document.createElement('div');
    line.className = `chat-line ${role}`;
    line.textContent = `${role === 'user' ? 'あなた' : 'AI助手'}: ${text}`;
    log.appendChild(line);
    return line;
  }

  private setChatBusy(isBusy: boolean, input: HTMLInputElement | null | undefined, submitButton: HTMLButtonElement | null, status: HTMLElement | null): void {
    if (input) input.disabled = isBusy;
    if (submitButton) submitButton.disabled = isBusy;
    if (status) status.textContent = isBusy ? '思考中' : '待機中';
  }

  private collectGameContext(): Record<string, unknown> {
    const state = (window as Window & { detectiveSimState?: Record<string, unknown> }).detectiveSimState;
    if (!state) return { caseName: '事務所待機中' };
    return {
      caseName: (state.case as { title?: string } | undefined)?.title || '事務所待機中',
      turn: state.turn,
      lastChoice: 'AI助手相談',
      scene: { location: (state.case as { location?: string } | undefined)?.location || '3D探偵事務所' },
      evidence: state.evidence,
      testimonies: state.testimonies,
      contradictions: state.miniResults,
    };
  }

  private formatChatError(message: string): string {
    if (/OPENAI_API_KEY|API_KEY/i.test(message)) return 'サーバー側のOPENAI_API_KEYを確認してください。';
    if (/Unsupported method|<!DOCTYPE/i.test(message)) return 'ExpressサーバーのURLから開いてください。';
    return message;
  }

  private escape(value: unknown): string {
    return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] ?? char));
  }
}

class Ambience {
  private context: AudioContext | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioCtor();
      this.noise(0.018, 900, 'lowpass');
      this.tick();
      this.hum();
    } catch {
      this.context = null;
    }
  }

  private noise(volume: number, frequency: number, filterType: BiquadFilterType): void {
    if (!this.context) return;
    const bufferSize = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) data[i] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(this.context.destination);
    source.start();
  }

  private hum(): void {
    if (!this.context) return;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = 'sine';
    osc.frequency.value = 55;
    gain.gain.value = 0.012;
    osc.connect(gain).connect(this.context.destination);
    osc.start();
  }

  private tick(): void {
    if (!this.context) return;
    const run = () => {
      if (!this.context) return;
      const now = this.context.currentTime;
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      osc.frequency.value = 1300;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.025, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
      osc.connect(gain).connect(this.context.destination);
      osc.start(now);
      osc.stop(now + 0.05);
      window.setTimeout(run, 1000);
    };
    run();
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

if (stage && canvas) {
  new DetectiveOffice(stage, canvas).start();
}
