import { useCallback, useEffect, useRef, useState } from 'react';

import { isBrowserRuntime } from '../runtime.js';

// ── Types ──────────────────────────────────────────────────────

type AgentStatus = 'waiting' | 'running' | 'done' | 'error';
type StageStatus = 'waiting' | 'running' | 'done';
type PipelineStatus = 'idle' | 'running' | 'done' | 'error';
type PanelMode = 'single' | 'pick';
type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface AgentPanelState {
  name: string;
  model: string;
  status: AgentStatus;
  result: string;
}

interface StagePanelState {
  id: string;
  label: string;
  status: StageStatus;
  agents: AgentPanelState[];
  summary: string;
}

interface PipelineState {
  status: PipelineStatus;
  stages: StagePanelState[];
  errorMessage: string;
}

interface ComplaintJob {
  id: number;
  title: string;
  content: string;
  status: JobStatus;
  currentStageId: string;
  result: {
    category?: string;
    finalDraft?: string;
  };
  error?: string;
}

interface PickableComplaint {
  id: number;
  title: string;
  content: string;
}

// ── Camera transform (written by OfficeCanvas every rAF frame) ──

interface PixelAgentsCamera {
  offsetX: number;   // device-pixel canvas X where world (0,0) is drawn
  offsetY: number;   // device-pixel canvas Y where world (0,0) is drawn
  zoom: number;      // pixels per tile (device pixels)
  tileSize: number;  // base tile size in world units (16)
  dpr: number;       // window.devicePixelRatio
}

function getCamera(): PixelAgentsCamera | null {
  return (window as unknown as { __pixelAgentsCamera?: PixelAgentsCamera }).__pixelAgentsCamera ?? null;
}

// Convert tile (col, row) to CSS-pixel position on the overlay canvas
function tileToOverlay(col: number, row: number, cam: PixelAgentsCamera): { x: number; y: number } {
  const s = cam.tileSize * cam.zoom;    // px per tile in canvas buffer (DPR-scaled)
  return {
    x: (cam.offsetX + col * s) / cam.dpr,
    y: (cam.offsetY + row * s) / cam.dpr,
  };
}

// ── Canvas Agent Character (waypoint-based rAF animation) ──────
// Positions are stored as tile-space (col/row), converted to CSS px each frame.

interface AgentCharacter {
  id: string;               // `${stageId}:${agentName}` — unique per complaint run
  stageId: string;
  agentName: string;
  charIndex: number;        // 0–5 sprite sheet index
  col: number;              // current column (float, for smooth movement)
  row: number;              // current row (float, for smooth movement)
  targetCol: number;        // next waypoint column
  targetRow: number;
  waypointTiles: Array<{ col: number; row: number }>;
  state: 'entering' | 'working' | 'moving_to_rest' | 'resting';
  speed: number;            // tiles per second (converted to per-frame in loop)
  isReviewer: boolean;      // use read animation instead of type
  restCol: number;          // sofa/rest tile column
  restRow: number;
}

type SseEvent =
  | { type: 'pipeline_start'; stages: string[] }
  | { type: 'stage_start'; stageId: string; stage: string; agents: Array<{ name: string; model: string }> }
  | { type: 'agent_start'; stageId: string; agent: string; model: string }
  | { type: 'agent_result'; stageId: string; agent: string; result: string }
  | { type: 'stage_complete'; stageId: string; stage: string; summary: string; category?: string }
  | { type: 'final_draft'; draft: string }
  | { type: 'pipeline_complete' }
  | { type: 'pipeline_error'; message: string };

// ── Constants ──────────────────────────────────────────────────

const INITIAL_PIPELINE: PipelineState = { status: 'idle', stages: [], errorMessage: '' };

const SAMPLE_POOL: PickableComplaint[] = [
  { id: 1, title: '아파트 인근 공사장 야간 소음 민원', content: '저는 ○○아파트에 거주하고 있는 주민입니다. 인근 공사장에서 야간(22시 이후)에도 공사를 진행하여 소음으로 인한 수면 방해가 심각합니다. 조속한 단속과 제재를 요청드립니다.' },
  { id: 2, title: '도로 포트홀 긴급 수리 요청', content: '○○로 123번지 앞 도로에 대형 포트홀(직경 약 30cm)이 발생하여 차량 통행에 위험이 있습니다. 자전거 이용 시 넘어질 위험도 있어 신속한 보수를 요청드립니다.' },
  { id: 3, title: '음식점 불법 간판 단속 요청', content: '○○동 456번지 소재 음식점에서 허가 면적을 초과하는 불법 간판을 설치하였습니다. 옥외광고물법 위반으로 단속을 요청드립니다.' },
  { id: 4, title: '불법 주정차 단속 요청', content: '○○동 789번지 앞 이면도로에 상시 불법 주정차 차량으로 인해 소방차 등 긴급차량 통행이 불가능한 상황입니다. 지속적인 단속을 요청드립니다.' },
  { id: 5, title: '공원 청결 상태 개선 요청', content: '○○공원 내 화장실 및 산책로 주변 쓰레기 처리 상태가 불량하여 악취가 심합니다. 청소 주기 증가 및 쓰레기통 추가 설치를 요청드립니다.' },
  { id: 6, title: '주택가 불법 축사 악취 민원', content: '○○로 234번지 인근 주택가에 무허가 축사가 운영되고 있어 심한 악취가 발생합니다. 악취방지법 및 관련 법규에 따른 즉각적인 단속을 요청드립니다.' },
];

const MAX_PICK = 3;
const DRAWER_WIDTH = 460;
const TOOLBAR_HEIGHT = 56;

// Office entry point — just outside the left wall of the work room
// Default layout: 21×22 tiles, work room left edge ≈ col 1–10
const ENTRY_COL = 0.5;
const ENTRY_ROW = 15;

// Per-stage desk positions in game-world tile coordinates (col, row).
// Derived from default-layout-1.json:
//   DESK_FRONT col:2 row:12  (left desk) — chars stand at row 13
//   DESK_FRONT col:6 row:12  (right desk) — chars stand at row 13
//   TABLE_FRONT col:4 row:16 (meeting table) — chairs at rows 16,18
const STAGE_TILE_POSITIONS: Record<string, ReadonlyArray<{ col: number; row: number }>> = {
  classify:  [{ col: 3, row: 13 }, { col: 7, row: 13 }, { col: 5, row: 12 }],
  search:    [{ col: 4, row: 13 }],
  write:     [{ col: 3, row: 13 }, { col: 7, row: 13 }, { col: 4, row: 15 }],
  review:    [{ col: 3, row: 17 }, { col: 5, row: 17 }, { col: 7, row: 17 }, { col: 4, row: 19 }],
  integrate: [{ col: 5, row: 18 }],
};

// Rest positions: sofa area (right lounge, cols 13–17, rows 13–17)
//   SOFA_FRONT col:14 row:13, SOFA_SIDE col:13 row:14, SOFA_BACK col:14 row:16,
//   SOFA_SIDE:left col:16 row:14, COFFEE_TABLE col:14 row:14
const REST_TILE_POSITIONS = [
  { col: 14, row: 14 }, { col: 15, row: 14 }, { col: 13, row: 15 },
  { col: 15, row: 15 }, { col: 16, row: 15 }, { col: 14, row: 17 },
  { col: 13, row: 17 }, { col: 15, row: 17 }, { col: 16, row: 16 },
  { col: 14, row: 13 }, { col: 16, row: 13 }, { col: 15, row: 16 },
] as const;

// Sprite sheet: char_N.png — 112×96px original, 7 frames × 3 rows, 16×32px each
// Row 0 (srcY=0): facing down — idle/type/read frames
// Row 2 (srcY=64): facing right — walk frames
// Frame order: walk1(0) walk2(1) walk3(2) type1(3) type2(4) read1(5) read2(6)
const SPRITE_W = 16;   // source frame width
const SPRITE_H = 32;   // source frame height
const DRAW_W = 32;     // drawn width (2× upscale)
const DRAW_H = 64;     // drawn height (2× upscale)

const STAGE_LABEL_MAP: Record<string, string> = {
  classify: '민원분류',
  search: '검색',
  write: '작성',
  review: '검수',
  integrate: '최종통합',
};

const WORKER_COLORS = [
  'var(--color-accent)',
  'var(--color-status-success)',
  'var(--color-warning)',
  'var(--color-status-active)',
  'var(--color-accent-bright)',
  'var(--color-danger)',
] as const;

// Speed variation: tiles per second at ~60fps. Chars get slightly different speeds.
const CHAR_SPEEDS_TILES_PER_SEC = [3.0, 4.0, 3.5, 2.5, 4.5, 3.2, 2.8, 3.8, 4.2, 2.4, 3.0, 3.5] as const;

// ── SSE Reader ────────────────────────────────────────────────

async function readSSE(response: Response, onEvent: (data: string) => void): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) onEvent(line.slice(6).trim());
    }
  }
  if (buffer.startsWith('data: ')) onEvent(buffer.slice(6).trim());
}

// ── Pipeline State Reducer ─────────────────────────────────────

function applyPipelineEvent(prev: PipelineState, event: SseEvent): PipelineState {
  switch (event.type) {
    case 'pipeline_start':
      return { ...INITIAL_PIPELINE, status: 'running' };
    case 'stage_start': {
      if (prev.stages.some((s) => s.id === event.stageId)) return prev;
      return {
        ...prev,
        stages: [
          ...prev.stages,
          {
            id: event.stageId,
            label: event.stage,
            status: 'running',
            agents: event.agents.map((a) => ({
              name: a.name,
              model: a.model,
              status: 'waiting' as const,
              result: '',
            })),
            summary: '',
          },
        ],
      };
    }
    case 'agent_start':
      return {
        ...prev,
        stages: prev.stages.map((s) =>
          s.id !== event.stageId
            ? s
            : { ...s, agents: s.agents.map((a) => a.name === event.agent ? { ...a, status: 'running' as const } : a) },
        ),
      };
    case 'agent_result':
      return {
        ...prev,
        stages: prev.stages.map((s) =>
          s.id !== event.stageId
            ? s
            : { ...s, agents: s.agents.map((a) => a.name === event.agent ? { ...a, status: 'done' as const, result: event.result } : a) },
        ),
      };
    case 'stage_complete':
      return {
        ...prev,
        stages: prev.stages.map((s) =>
          s.id === event.stageId ? { ...s, status: 'done' as const, summary: event.summary } : s,
        ),
      };
    case 'pipeline_complete':
      return { ...prev, status: 'done' };
    case 'pipeline_error':
      return { ...prev, status: 'error', errorMessage: event.message };
    default:
      return prev;
  }
}

// ── Canvas drawing helper ──────────────────────────────────────

function getFrameCoords(
  char: Pick<AgentCharacter, 'state' | 'isReviewer'>,
  now: number,
): { srcX: number; srcY: number } {
  const { state, isReviewer } = char;
  if (state === 'entering' || state === 'moving_to_rest') {
    // walk row (row 2 = srcY 64), cycle 3 frames every 167ms
    return { srcX: (Math.floor(now / 167) % 3) * SPRITE_W, srcY: 64 };
  }
  if (state === 'working' && isReviewer) {
    // read animation: row 0, frames 5–6, 400ms cycle
    return { srcX: (5 + Math.floor(now / 400) % 2) * SPRITE_W, srcY: 0 };
  }
  if (state === 'working') {
    // type animation: row 0, frames 3–4, 275ms cycle
    return { srcX: (3 + Math.floor(now / 275) % 2) * SPRITE_W, srcY: 0 };
  }
  // resting / idle: row 0, frame 0
  return { srcX: 0, srcY: 0 };
}

// ── MinjeonPanel ───────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function MinjeonPanel({ isOpen, onClose }: Props) {
  const [mode, setMode] = useState<PanelMode>('pick');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE);
  const [jobs, setJobs] = useState<ComplaintJob[]>([]);
  const [batchStatus, setBatchStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [batchError, setBatchError] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set([1, 2, 3]));
  const [copiedJobId, setCopiedJobId] = useState<number | null>(null);

  // Canvas-based character animation (mutated directly by rAF loop + SSE handlers)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const charsRef = useRef<AgentCharacter[]>([]);
  const imagesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const rafRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  // Preload sprite sheets once on mount
  useEffect(() => {
    for (let i = 0; i < 6; i++) {
      const img = new Image();
      img.src = `/assets/characters/char_${i}.png`;
      imagesRef.current.set(i, img);
    }
  }, []);

  // rAF loop — runs while panel is open, reads + mutates charsRef directly
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let lastTime = 0;

    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1); // seconds, capped at 100ms
      lastTime = now;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Resize canvas pixel buffer to match CSS size (no DPR — overlay uses CSS px)
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) { rafRef.current = requestAnimationFrame(loop); return; }
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;

      // Read camera transform from OfficeCanvas (updated every game rAF frame)
      const cam = getCamera();
      if (!cam) { rafRef.current = requestAnimationFrame(loop); return; }

      for (const char of charsRef.current) {
        // Movement update (tile-space, dt-based)
        if (char.state === 'entering' || char.state === 'moving_to_rest') {
          const dcol = char.targetCol - char.col;
          const drow = char.targetRow - char.row;
          const dist = Math.sqrt(dcol * dcol + drow * drow);
          const step = char.speed * dt;
          if (dist <= step || dist < 0.01) {
            char.col = char.targetCol;
            char.row = char.targetRow;
            const next = char.waypointTiles.shift();
            if (next) {
              char.targetCol = next.col;
              char.targetRow = next.row;
            } else {
              char.state = char.state === 'entering' ? 'working' : 'resting';
            }
          } else {
            char.col += dcol / dist * step;
            char.row += drow / dist * step;
          }
        }

        // Convert tile position to overlay CSS-pixel position
        // Character anchor = center-bottom of the tile
        const pos = tileToOverlay(char.col + 0.5, char.row + 1, cam);
        const drawX = Math.round(pos.x - DRAW_W / 2);
        const drawY = Math.round(pos.y - DRAW_H);

        // Clip to canvas bounds (don't draw off-screen)
        if (drawX + DRAW_W < 0 || drawX > w || drawY + DRAW_H < 0 || drawY > h) continue;

        // Draw sprite
        const img = imagesRef.current.get(char.charIndex);
        if (!img?.complete || img.naturalWidth === 0) continue;

        const { srcX, srcY } = getFrameCoords(char, now);
        ctx.drawImage(img, srcX, srcY, SPRITE_W, SPRITE_H, drawX, drawY, DRAW_W, DRAW_H);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isOpen]);

  // ── SSE event dispatcher (shared by single + batch) ───────────

  const handleSseEvent = useCallback((ev: SseEvent, complaintId: number) => {
    setPipeline((prev) => applyPipelineEvent(prev, ev));

    if (ev.type === 'stage_start') {
      setJobs((prev) => prev.map((j) => j.id === complaintId ? { ...j, currentStageId: ev.stageId } : j));
    }

    if (ev.type === 'agent_start') {
      const existing = charsRef.current;
      const agentIndexInStage = existing.filter((c) => c.stageId === ev.stageId).length;
      const deskTile = STAGE_TILE_POSITIONS[ev.stageId]?.[agentIndexInStage]
        ?? { col: 4 + (existing.length % 4) * 2, row: 13 };
      const restTile = REST_TILE_POSITIONS[existing.length % REST_TILE_POSITIONS.length]!;
      const speed = CHAR_SPEEDS_TILES_PER_SEC[existing.length % CHAR_SPEEDS_TILES_PER_SEC.length]!;

      const newChar: AgentCharacter = {
        id: `${ev.stageId}:${ev.agent}`,
        stageId: ev.stageId,
        agentName: ev.agent,
        charIndex: existing.length % 6,
        col: ENTRY_COL,
        row: ENTRY_ROW,
        targetCol: deskTile.col,
        targetRow: deskTile.row,
        waypointTiles: [],
        state: 'entering',
        speed,
        isReviewer: ev.stageId === 'review',
        restCol: restTile.col,
        restRow: restTile.row,
      };
      charsRef.current = [...existing, newChar];
    }

    if (ev.type === 'agent_result') {
      charsRef.current = charsRef.current.map((c) => {
        if (c.id !== `${ev.stageId}:${ev.agent}`) return c;
        return {
          ...c,
          state: 'moving_to_rest' as const,
          targetCol: c.restCol,
          targetRow: c.restRow,
          waypointTiles: [],
        };
      });
    }
  }, []);

  // ── Single generate ────────────────────────────────────────────

  const handleSingleGenerate = useCallback(() => {
    if (!title.trim() || !content.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const singleJob: ComplaintJob = {
      id: -1,
      title: title.trim(),
      content: content.trim(),
      status: 'processing',
      currentStageId: '',
      result: {},
    };
    setJobs([singleJob]);
    charsRef.current = [];
    setBatchStatus('running');
    setBatchError('');
    setPipeline({ ...INITIAL_PIPELINE, status: 'running' });

    let draft = '';
    let cat = '';

    const run = async (): Promise<void> => {
      const res = await fetch('/api/minjeon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`서버 오류: ${res.status}`);
      await readSSE(res, (raw) => {
        try {
          const ev = JSON.parse(raw) as SseEvent;
          handleSseEvent(ev, -1);
          if (ev.type === 'final_draft') draft = ev.draft;
          if (ev.type === 'stage_complete' && ev.stageId === 'classify' && ev.category) cat = ev.category;
        } catch { /* malformed */ }
      });
      setJobs((prev) => prev.map((j) => j.id === -1
        ? { ...j, status: 'completed', currentStageId: '', result: { finalDraft: draft, category: cat || undefined } }
        : j));
      setBatchStatus('done');
    };

    run().catch((err: unknown) => {
      if ((err as { name?: string }).name === 'AbortError') return;
      setPipeline((prev) => ({ ...prev, status: 'error', errorMessage: String(err) }));
      setJobs((prev) => prev.map((j) => j.id === -1 ? { ...j, status: 'failed', error: String(err) } : j));
      setBatchStatus('error');
      setBatchError(String(err));
    });
  }, [title, content, handleSseEvent]);

  // ── Batch start ────────────────────────────────────────────────

  const handleBatchStart = useCallback(() => {
    const complaints = SAMPLE_POOL.filter((c) => selected.has(c.id));
    if (complaints.length === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setJobs(complaints.map((c) => ({
      id: c.id,
      title: c.title,
      content: c.content,
      status: 'pending' as const,
      currentStageId: '',
      result: {},
    })));
    charsRef.current = [];
    setBatchStatus('running');
    setBatchError('');
    setPipeline(INITIAL_PIPELINE);

    const run = async (): Promise<void> => {
      for (const complaint of complaints) {
        setJobs((prev) => prev.map((j) => j.id === complaint.id ? { ...j, status: 'processing' } : j));
        charsRef.current = [];
        setPipeline({ ...INITIAL_PIPELINE, status: 'running' });

        let draft = '';
        let cat = '';
        let failed = false;
        let errorMsg = '';

        try {
          const res = await fetch('/api/minjeon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: complaint.title, content: complaint.content }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`서버 오류: ${res.status}`);

          await readSSE(res, (raw) => {
            try {
              const ev = JSON.parse(raw) as SseEvent;
              handleSseEvent(ev, complaint.id);
              if (ev.type === 'final_draft') draft = ev.draft;
              if (ev.type === 'stage_complete' && ev.stageId === 'classify' && ev.category) cat = ev.category;
              if (ev.type === 'pipeline_error') { failed = true; errorMsg = ev.message; }
            } catch { /* malformed */ }
          });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') throw err;
          failed = true;
          errorMsg = String(err);
        }

        setJobs((prev) => prev.map((j) => j.id === complaint.id
          ? {
              ...j,
              status: failed ? 'failed' : 'completed',
              currentStageId: '',
              result: { category: cat || undefined, finalDraft: draft || undefined },
              error: failed ? errorMsg : undefined,
            }
          : j));
      }
      setBatchStatus('done');
    };

    run().catch((err: unknown) => {
      if ((err as { name?: string }).name !== 'AbortError') {
        setBatchStatus('error');
        setBatchError(String(err));
      }
    });
  }, [selected, handleSseEvent]);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_PICK) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleCopyJob = useCallback((jobId: number, draft: string) => {
    void navigator.clipboard.writeText(draft).then(() => {
      setCopiedJobId(jobId);
      setTimeout(() => setCopiedJobId(null), 2000);
    });
  }, []);

  // All hooks above this line
  if (!isBrowserRuntime || !isOpen) return null;

  const isRunning = pipeline.status === 'running' || batchStatus === 'running';
  const activeJob = jobs.find((j) => j.status === 'processing');
  const activeStage = pipeline.stages.find((s) => s.status === 'running');
  const doneStageCount = pipeline.stages.filter((s) => s.status === 'done').length;
  const completedJobs = jobs.filter((j) => j.status === 'completed' || j.status === 'failed');
  const allDoneCount = jobs.filter((j) => j.status === 'completed').length;

  return (
    <>
      {/* ── Canvas overlay: animated rAF pixel-art characters ── */}
      <canvas
        ref={canvasRef}
        className="fixed top-0 left-0 z-40 pointer-events-none"
        style={{ right: DRAWER_WIDTH, bottom: TOOLBAR_HEIGHT }}
      />

      {/* ── Right Drawer ── */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 bg-bg border-l-2 border-border overflow-y-auto"
        style={{ width: DRAWER_WIDTH }}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-12 py-8 bg-bg-dark border-b-2 border-border shadow-pixel">
          <span className="text-sm text-text font-pixel">민원 초안 생성 AI</span>
          <div className="flex items-center gap-8">
            <span className="text-2xs text-text-muted font-pixel">Multi-Agent</span>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text cursor-pointer border-0 bg-transparent text-base font-pixel px-4"
            >
              X
            </button>
          </div>
        </div>

        <div className="p-12 flex flex-col gap-12">

          {/* ── Live status bar ── */}
          {isRunning && (
            <div className="border-2 border-accent p-8 bg-bg-dark">
              <div className="flex items-center gap-8 mb-6">
                <span className="text-2xs text-accent pixel-pulse font-pixel">● 처리 중</span>
                {activeStage && (
                  <span className="text-2xs text-text font-pixel">{activeStage.label}</span>
                )}
                {pipeline.stages.length > 0 && (
                  <span className="text-2xs text-text-muted font-pixel">
                    {doneStageCount}/{pipeline.stages.length}
                  </span>
                )}
              </div>
              <div className="flex gap-4">
                {pipeline.stages.length > 0
                  ? pipeline.stages.map((s) => (
                      <div
                        key={s.id}
                        className={[
                          'flex-1 h-4 border',
                          s.status === 'done' ? 'bg-status-success border-status-success' :
                          s.status === 'running' ? 'bg-accent border-accent' :
                          'bg-transparent border-border',
                        ].join(' ')}
                      />
                    ))
                  : Array.from({ length: 5 }, (_, i) => (
                      <div key={i} className="flex-1 h-4 border border-border" />
                    ))
                }
              </div>
            </div>
          )}

          {/* ── Character / agent status list ── */}
          {jobs.length > 0 && (
            <section className="border border-border bg-bg-dark">
              <div className="px-8 py-6 border-b border-border">
                <span className="text-2xs text-text-muted font-pixel">에이전트 현황</span>
              </div>
              {jobs.map((job, i) => {
                const color = WORKER_COLORS[i % WORKER_COLORS.length]!;
                const stageLabel = job.currentStageId
                  ? (STAGE_LABEL_MAP[job.currentStageId] ?? job.currentStageId)
                  : '';
                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-6 px-8 py-6"
                    style={{ borderBottom: '1px solid var(--color-border)' }}
                  >
                    <div
                      className="flex-shrink-0"
                      style={{ width: 10, height: 10, background: color, border: `2px solid ${color}` }}
                    />
                    <span className="text-2xs text-text-muted font-pixel flex-shrink-0">#{i + 1}</span>
                    <span className="flex-1 text-xs text-text font-pixel truncate">{job.title}</span>
                    <span
                      className="text-2xs font-pixel flex-shrink-0"
                      style={{
                        color: job.status === 'completed' ? 'var(--color-status-success)' :
                               job.status === 'failed' ? 'var(--color-danger)' :
                               job.status === 'processing' ? 'var(--color-accent)' :
                               'var(--color-text-muted)',
                      }}
                    >
                      {job.status === 'pending' && '대기 중'}
                      {job.status === 'processing' && (stageLabel ? `${stageLabel} 중` : '처리 중')}
                      {job.status === 'completed' && '완료 — 휴식 중'}
                      {job.status === 'failed' && '처리 실패'}
                    </span>
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Mode tabs ── */}
          <div className="flex border-2 border-border" style={{ width: 'fit-content' }}>
            <button
              onClick={() => setMode('pick')}
              disabled={isRunning}
              className={[
                'px-16 py-6 text-xs font-pixel cursor-pointer border-0 border-r-2 border-border disabled:opacity-35 disabled:cursor-not-allowed',
                mode === 'pick' ? 'bg-accent text-white' : 'bg-bg-dark text-text-muted hover:text-text',
              ].join(' ')}
            >
              민원 선택 ({selected.size}/3)
            </button>
            <button
              onClick={() => setMode('single')}
              disabled={isRunning}
              className={[
                'px-16 py-6 text-xs font-pixel cursor-pointer border-0 disabled:opacity-35 disabled:cursor-not-allowed',
                mode === 'single' ? 'bg-accent text-white' : 'bg-bg-dark text-text-muted hover:text-text',
              ].join(' ')}
            >
              직접 입력
            </button>
          </div>

          {/* ── Pick mode ── */}
          {mode === 'pick' && (
            <section className="border-2 border-border bg-bg-dark">
              <div className="px-12 py-8 border-b border-border flex items-center justify-between">
                <span className="text-xs text-text font-pixel">민원 선택 (최대 3건)</span>
                <span className="text-2xs text-text-muted font-pixel">{selected.size}/{MAX_PICK}</span>
              </div>
              <div className="flex flex-col">
                {SAMPLE_POOL.map((c) => {
                  const isSelected = selected.has(c.id);
                  const isDisabled = !isSelected && selected.size >= MAX_PICK;
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleSelect(c.id)}
                      disabled={isDisabled || isRunning}
                      className={[
                        'w-full text-left px-12 py-8 flex items-start gap-8 cursor-pointer border-0 font-pixel disabled:opacity-35 disabled:cursor-not-allowed',
                        isSelected ? 'bg-accent' : 'bg-transparent hover:bg-btn-hover',
                      ].join(' ')}
                      style={{ borderBottom: '1px solid var(--color-border)' }}
                    >
                      <span
                        className={`text-sm mt-2 flex-shrink-0 font-pixel ${isSelected ? 'text-white' : 'text-text-muted'}`}
                      >
                        {isSelected ? '[v]' : '[ ]'}
                      </span>
                      <div>
                        <div className={`text-xs font-pixel ${isSelected ? 'text-white' : 'text-text'}`}>
                          {c.title}
                        </div>
                        <div
                          className={`text-2xs mt-2 font-pixel ${isSelected ? 'text-white' : 'text-text-muted'}`}
                          style={{ opacity: 0.75 }}
                        >
                          {c.content.slice(0, 55)}...
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="p-12 border-t border-border">
                <button
                  onClick={handleBatchStart}
                  disabled={isRunning || selected.size === 0}
                  className="w-full py-8 text-sm text-white bg-accent border-2 border-accent cursor-pointer hover:bg-accent-bright disabled:opacity-35 disabled:cursor-not-allowed font-pixel shadow-pixel"
                >
                  {isRunning ? '처리 중...' : `선택된 ${selected.size}건 처리 시작`}
                </button>
              </div>
            </section>
          )}

          {/* ── Single input mode ── */}
          {mode === 'single' && (
            <section className="border-2 border-border bg-bg-dark p-12">
              <div className="mb-8">
                <label className="block text-2xs text-text-muted mb-4 font-pixel">민원 제목</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isRunning) handleSingleGenerate(); }}
                  placeholder="예: 아파트 인근 공사장 소음 민원"
                  disabled={isRunning}
                  className="w-full border-2 border-border bg-bg text-text px-8 py-6 text-xs outline-none focus:border-accent font-pixel"
                />
              </div>
              <div className="mb-8">
                <label className="block text-2xs text-text-muted mb-4 font-pixel">민원 내용</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="불편하신 사항을 구체적으로 작성해 주세요."
                  disabled={isRunning}
                  rows={4}
                  className="w-full border-2 border-border bg-bg text-text px-8 py-6 text-xs outline-none focus:border-accent resize-none font-pixel"
                />
              </div>
              <button
                onClick={handleSingleGenerate}
                disabled={isRunning || !title.trim() || !content.trim()}
                className="w-full py-8 text-sm text-white bg-accent border-2 border-accent cursor-pointer hover:bg-accent-bright disabled:opacity-35 disabled:cursor-not-allowed font-pixel shadow-pixel"
              >
                {isRunning ? '생성 중...' : '초안 생성'}
              </button>
            </section>
          )}

          {/* ── Error banners ── */}
          {pipeline.status === 'error' && pipeline.errorMessage && (
            <div className="border-2 border-danger p-8 text-xs text-danger bg-bg-dark font-pixel">
              오류: {pipeline.errorMessage}
            </div>
          )}
          {batchStatus === 'error' && batchError && (
            <div className="border-2 border-danger p-8 text-xs text-danger bg-bg-dark font-pixel">
              오류: {batchError}
            </div>
          )}

          {/* ── Active pipeline stage lanes ── */}
          {pipeline.stages.length > 0 && (
            <section>
              <div className="text-2xs text-text-muted mb-6 font-pixel">
                에이전트 작업 현황
                {activeJob && (
                  <span className="ml-6" style={{ color: 'var(--color-accent)' }}>
                    {' '}- #{jobs.indexOf(activeJob) + 1} {activeJob.title}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-6">
                {pipeline.stages.map((stage) => (
                  <StageLane key={stage.id} stage={stage} />
                ))}
              </div>
            </section>
          )}

          {/* ── Final draft cards — 3 SEPARATE cards, one per complaint ── */}
          {completedJobs.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-8 pb-6 border-b-2 border-border">
                <span className="text-xs text-text font-pixel">최종 민원 초안</span>
                <span className="text-2xs text-text-muted font-pixel">{completedJobs.length}건</span>
              </div>
              <div className="flex flex-col gap-12">
                {jobs.map((job, i) => {
                  if (job.status !== 'completed' && job.status !== 'failed') return null;
                  return (
                    <FinalDraftCard
                      key={job.id}
                      job={job}
                      index={i}
                      copied={copiedJobId === job.id}
                      onCopy={handleCopyJob}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* ── All done message ── */}
          {batchStatus === 'done' && (
            <p className="text-center text-xs text-status-success font-pixel">
              [v] {allDoneCount}건 처리 완료 — 에이전트들이 휴식 중입니다
            </p>
          )}

        </div>
      </div>
    </>
  );
}

// ── StageLane ─────────────────────────────────────────────────

function StageLane({ stage }: { stage: StagePanelState }) {
  const doneCount = stage.agents.filter((a) => a.status === 'done').length;
  return (
    <div className="minjeon-lane border border-border bg-bg-dark">
      <div className="flex items-center justify-between px-8 py-4 border-b border-border">
        <span
          className="text-2xs font-pixel"
          style={{
            color: stage.status === 'done' ? 'var(--color-status-success)' :
                   stage.status === 'running' ? 'var(--color-accent)' :
                   'var(--color-text-muted)',
          }}
        >
          {stage.status === 'done' ? '[v]' : stage.status === 'running' ? '[>]' : '[ ]'} {stage.label}
          {stage.status === 'done' && stage.summary && (
            <span className="text-text-muted ml-6">— {stage.summary}</span>
          )}
        </span>
        <span className="text-2xs text-text-muted font-pixel">{doneCount}/{stage.agents.length}</span>
      </div>
      <div className="flex flex-wrap gap-4 p-6">
        {stage.agents.map((agent, i) => (
          <AgentChip key={agent.name} agent={agent} delay={i * 60} />
        ))}
      </div>
    </div>
  );
}

// ── AgentChip ─────────────────────────────────────────────────

function AgentChip({ agent, delay }: { agent: AgentPanelState; delay: number }) {
  return (
    <div
      className="minjeon-agent-card border border-border bg-bg px-6 py-4 font-pixel"
      data-status={agent.status === 'waiting' ? undefined : agent.status}
      style={{ animationDelay: `${delay}ms`, minWidth: 90 }}
    >
      <div className="text-2xs text-text font-pixel truncate">{agent.name}</div>
      <div className="text-2xs mt-2 font-pixel">
        {agent.status === 'waiting' && <span className="text-text-muted">대기</span>}
        {agent.status === 'running' && <span className="text-accent pixel-pulse">● 작업</span>}
        {agent.status === 'done' && <span className="text-status-success">[v]</span>}
        {agent.status === 'error' && <span className="text-danger">[x]</span>}
      </div>
    </div>
  );
}

// ── FinalDraftCard ─────────────────────────────────────────────

interface FinalDraftCardProps {
  job: ComplaintJob;
  index: number;
  copied: boolean;
  onCopy: (jobId: number, draft: string) => void;
}

function FinalDraftCard({ job, index, copied, onCopy }: FinalDraftCardProps) {
  const [expanded, setExpanded] = useState(true);

  if (job.status === 'failed') {
    return (
      <div className="border-2 border-danger bg-bg-dark">
        <div className="px-12 py-8 border-b border-danger">
          <span className="text-xs text-danger font-pixel">[x] #{index + 1} 처리 실패</span>
          <div className="text-xs text-text font-pixel mt-4">{job.title}</div>
        </div>
        <div className="px-12 py-8 text-xs text-text-muted font-pixel">
          {job.error ?? '알 수 없는 오류가 발생했습니다.'}
        </div>
      </div>
    );
  }

  const draft = job.result.finalDraft ?? '';

  return (
    <div className="border-2 border-status-success bg-bg-dark">
      <div className="flex items-start justify-between px-12 py-8 border-b-2 border-status-success">
        <div className="flex-1 min-w-0 mr-8">
          <div className="text-2xs text-status-success font-pixel mb-4">
            [v] 최종 민원 초안 #{index + 1}
          </div>
          <div className="text-xs text-text font-pixel">{job.title}</div>
          {job.result.category && (
            <div className="text-2xs text-text-muted font-pixel mt-2">
              분류: {job.result.category}
            </div>
          )}
        </div>
        <div className="flex gap-4 flex-shrink-0">
          {draft && (
            <button
              onClick={() => onCopy(job.id, draft)}
              className="text-2xs border border-border px-8 py-4 cursor-pointer bg-bg hover:bg-btn-hover font-pixel text-text-muted"
            >
              {copied ? '복사됨!' : '복사'}
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-2xs border border-border px-6 py-4 cursor-pointer bg-bg hover:bg-btn-hover font-pixel text-text-muted"
          >
            {expanded ? '-' : '+'}
          </button>
        </div>
      </div>
      {expanded && (
        <div
          className="p-12 text-xs text-text whitespace-pre-wrap leading-relaxed font-pixel"
          style={{ maxHeight: 300, overflowY: 'auto' }}
        >
          {draft || '(초안 없음)'}
        </div>
      )}
    </div>
  );
}
