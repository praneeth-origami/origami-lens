import { isComponentWorkerRunning } from './workers/component-generation-worker.js';

const BROWSER_WORKER_URL = process.env.BROWSER_WORKER_URL ?? 'http://localhost:3101';
const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

export interface ServiceHealth {
  status: 'ok' | 'down';
  service: string;
  error?: string;
}

export interface AiModelStatus {
  task: string;
  model: string;
  /** The model name is registered with the model server — NOT proof it can complete a real generation call. */
  available: boolean;
  /** Best-effort: does the model's size fit the configured GPU budget (AI_GPU_VRAM_MB)? Undefined = unknown. */
  fitsBudget?: boolean;
  /** Real capability signal: available AND not known to be too large for this hardware. */
  ready: boolean;
}

export interface AiModelsHealth {
  checked: boolean;
  enabled: boolean;
  reachable: boolean;
  models: AiModelStatus[];
  error?: string;
}

export interface ComponentWorkerHealth {
  /** Whether REDIS_URL is set — if not, the dev in-process fallback is used deliberately (see component-generation-worker.ts) and is always ready. */
  redisConfigured: boolean;
  /** Whether this process actually started a live BullMQ Worker bound to Redis. */
  workerRunning: boolean;
  /** True when a newly-created Screenshot -> Code job can actually be picked up — false means it would sit QUEUED with no observable reason otherwise. */
  ready: boolean;
}

export interface DependencyHealth {
  api: ServiceHealth;
  browserWorker: ServiceHealth;
  aiRouter: ServiceHealth;
  readyForScan: boolean;
  /** Answers "would a new Screenshot -> Code job actually get picked up?" — the queue-side counterpart to readyForComponentGeneration below (which only covers AI readiness). */
  componentWorker: ComponentWorkerHealth;
  /** Real model-capability check, independent of aiRouter process liveness above. */
  aiModels: AiModelsHealth;
  /** ai-router process is up AND its own model-capability probe succeeded. */
  aiServiceReachable: boolean;
  /** The vision model (screenshot_to_code) is registered and not known to be resource-constrained. */
  visionModelReady: boolean;
  /** The coding model (generate_component) is registered and not known to be resource-constrained. */
  codeModelReady: boolean;
  /**
   * True only when the AI service is reachable AND both Screenshot -> Code
   * models are registered AND neither is known to be too large for the
   * configured hardware. This is intentionally stronger than "the models are
   * listed" — a model can be registered with the server and still be unable
   * to complete a real generation call on constrained hardware (the
   * aiAvailable=true-but-generation-fails gap), so plain registration is not
   * treated as sufficient here.
   */
  readyForComponentGeneration: boolean;
}

async function probeService(
  url: string,
  service: string,
): Promise<ServiceHealth> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { status: 'ok', service };
    }
    return { status: 'down', service, error: `HTTP ${res.status}` };
  } catch (error) {
    return {
      status: 'down',
      service,
      error: error instanceof Error ? error.message : 'Unreachable',
    };
  }
}

interface ModelAvailabilityResponse {
  enabled: boolean;
  reachable: boolean;
  requiredModels: Array<{ task: string; model: string; available: boolean; fitsBudget?: boolean; ready: boolean }>;
  error?: string;
}

async function probeAiModels(): Promise<AiModelsHealth> {
  try {
    const res = await fetch(`${AI_ROUTER_URL}/health/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { checked: true, enabled: false, reachable: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as ModelAvailabilityResponse;
    return {
      checked: true,
      enabled: data.enabled,
      reachable: data.reachable,
      models: data.requiredModels.map((m) => ({ task: m.task, model: m.model, available: m.available, fitsBudget: m.fitsBudget, ready: m.ready })),
      error: data.error,
    };
  } catch (error) {
    return {
      checked: false,
      enabled: false,
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message : 'Unreachable',
    };
  }
}

export async function checkDependencies(): Promise<DependencyHealth> {
  const api: ServiceHealth = { status: 'ok', service: 'origami-api' };
  const [browserWorker, aiRouter, aiModels] = await Promise.all([
    probeService(BROWSER_WORKER_URL, 'browser-worker'),
    probeService(AI_ROUTER_URL, 'ai-router'),
    probeAiModels(),
  ]);

  // `ready` (not `available`) is the real capability signal — registered
  // AND not known to be too large for the configured GPU budget. A model
  // can be registered and still be unable to complete a real generation
  // call on constrained hardware (available=true, generation still fails).
  const aiServiceReachable = aiRouter.status === 'ok' && aiModels.reachable;
  const visionModelReady = aiModels.models.find((m) => m.task === 'screenshot_to_code')?.ready ?? false;
  const codeModelReady = aiModels.models.find((m) => m.task === 'generate_component')?.ready ?? false;
  const readyForComponentGeneration = aiServiceReachable && visionModelReady && codeModelReady;

  const redisConfigured = Boolean(process.env.REDIS_URL);
  const workerRunning = isComponentWorkerRunning();
  const componentWorker: ComponentWorkerHealth = {
    redisConfigured,
    workerRunning,
    // Not configured -> the dev in-process fallback handles every job
    // itself, so it's always ready. Configured -> only ready if a live
    // BullMQ Worker actually started; otherwise a new job would sit QUEUED
    // with nothing consuming it — the original Redis-down failure mode,
    // one layer up, now made observable instead of silent.
    ready: !redisConfigured || workerRunning,
  };

  return {
    api,
    browserWorker,
    aiRouter,
    readyForScan: browserWorker.status === 'ok' && aiRouter.status === 'ok',
    componentWorker,
    aiModels,
    aiServiceReachable,
    visionModelReady,
    codeModelReady,
    readyForComponentGeneration: readyForComponentGeneration && componentWorker.ready,
  };
}
