import './load-env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type {
  AskRequest,
  CodeTarget,
  ComponentGenerationJob,
  CreateComponentJobRequest,
  CreateScanRequest,
  ExplainIssueRequest,
  IssueFilters,
  IssueStatus,
  ScanRequest,
  ScanType,
} from '@origami/contracts';
import { CODE_TARGET_META, DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES } from '@origami/contracts';
import { ScanPipeline } from './scan-pipeline.js';
import { countIssuesByCategory, filterIssues } from './scan-store.js';
import { checkDependencies } from './health.js';
import { createWebsiteScanRecord } from './website-scan-orchestrator.js';
import { enqueueWebsiteScan, startWebsiteScanWorker } from './workers/website-scan-worker.js';
import { canCancelJob, cancelComponentJob, enqueueComponentJob, startComponentGenerationWorker } from './workers/component-generation-worker.js';
import { ComponentGenerator } from './component-generator.js';
import { UnifiedComponentStore } from './unified-component-store.js';
import { isDatabaseEnabled } from './db/pool.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

const PORT = Number(process.env.API_PORT ?? 3100);
const HOST = process.env.API_HOST ?? '0.0.0.0';
const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

/**
 * Fastify defaults to a 1MB request body limit, which is too small for
 * POST /components: a Screenshot -> Code evidence payload bundles a base64
 * screenshot (cropped to the selection + margin, JPEG q=0.85, but base64
 * itself adds ~37% overhead) plus a trimmed DOM tree (depth <= 4, <= 25
 * children/node), <= 20 asset entries, and CSS variables — a large selection
 * on a high-DPR display can plausibly exceed 1MB on its own before any of
 * that other evidence is added. 8MB comfortably covers that realistic
 * worst case while staying far short of an unbounded/"enormous" limit.
 * See services/ai-router/src/index.ts for the matching limit on the /gateway
 * relay call, which carries the same screenshot data onward.
 */
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_MB || 8) * 1024 * 1024;

const pipeline = new ScanPipeline();
const store = pipeline.getStore();
const artifactStore = pipeline.getArtifactStore();
const repo = store.getRepository();

const componentStore = new UnifiedComponentStore();
const componentGenerator = new ComponentGenerator();
const componentRepo = componentStore.getRepository();

if (process.env.START_SCAN_WORKER !== 'false') {
  startWebsiteScanWorker();
  startComponentGenerationWorker(componentStore, componentGenerator);
}

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES });

await app.register(cors, { origin: true });

app.get('/health', async () => ({ status: 'ok', service: 'origami-api' }));

app.get('/health/dependencies', async () => checkDependencies());

app.post<{ Body: ScanRequest }>('/scan', async (request, reply) => {
  const { url } = request.body;

  if (!url) {
    return reply.status(400).send({ error: 'url is required' });
  }

  try {
    new URL(url);
  } catch {
    return reply.status(400).send({ error: 'Invalid URL' });
  }

  try {
    const result = await pipeline.runScan(request.body);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan failed';
    request.log.error(error);
    return reply.status(500).send({ error: message });
  }
});

app.post<{ Body: CreateScanRequest }>('/scans', async (request, reply) => {
  const body = request.body;
  const scanType: ScanType = body.scanType ?? 'CURRENT_PAGE';

  if (!body.url) {
    return reply.status(400).send({ error: 'url is required' });
  }

  try {
    new URL(body.url);
  } catch {
    return reply.status(400).send({ error: 'Invalid URL' });
  }

  if (scanType === 'CURRENT_PAGE') {
    try {
      const result = await pipeline.runScan(body);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scan failed';
      return reply.status(500).send({ error: message });
    }
  }

  if (scanType === 'WEBSITE') {
    if (!isDatabaseEnabled()) {
      return reply.status(503).send({
        error: 'Website scans require PostgreSQL. Set DATABASE_URL and run pnpm db:migrate.',
      });
    }

    const maxPages = Math.min(
      body.websiteOptions?.maxPages ?? DEFAULT_WEBSITE_MAX_PAGES,
      MAX_WEBSITE_PAGES,
    );

    try {
      const scanId = await createWebsiteScanRecord(
        repo,
        body.url,
        { ...body.websiteOptions, maxPages, discoveryMethod: body.websiteOptions?.discoveryMethod ?? 'AUTOMATIC' },
        body.ownerId,
      );

      const enqueued = await enqueueWebsiteScan({
        scanId,
        rootUrl: body.url,
        options: body.websiteOptions ?? { discoveryMethod: 'AUTOMATIC', maxPages },
        ownerId: body.ownerId,
      });

      if (!enqueued) {
        return reply.status(503).send({
          error: 'Website scans require Redis. Set REDIS_URL and ensure Redis is running.',
        });
      }

      return {
        scanId,
        url: body.url,
        scanType: 'WEBSITE',
        status: 'QUEUED',
        progress: { discoveredPages: 0, completedPages: 0, failedPages: 0, issuesFound: 0 },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create website scan';
      return reply.status(500).send({ error: message });
    }
  }

  if (scanType === 'PROJECT') {
    return reply.status(501).send({ error: 'PROJECT scans are not yet implemented' });
  }

  return reply.status(400).send({ error: 'Invalid scanType' });
});

app.get('/scans', async () => ({
  scans: await store.listScansAsync(),
}));

app.get<{ Params: { scanId: string } }>('/scans/:scanId', async (request, reply) => {
  const scan = await store.getScanAsync(request.params.scanId);
  if (!scan) {
    return reply.status(404).send({ error: 'Scan not found' });
  }
  return {
    ...scan,
    issuesByCategory: countIssuesByCategory(scan.issues as import('@origami/contracts').Issue[]),
  };
});

app.get<{ Params: { scanId: string } }>('/scans/:scanId/status', async (request, reply) => {
  if (!repo.isEnabled()) {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    return {
      scanId: scan.scanId,
      scanType: scan.scanType ?? 'CURRENT_PAGE',
      status: scan.status ?? 'COMPLETED',
      progress: scan.progress ?? {
        discoveredPages: 1,
        completedPages: 1,
        failedPages: 0,
        issuesFound: scan.issues.length,
      },
      healthScore: scan.healthScore,
    };
  }

  const status = await repo.getScanStatus(request.params.scanId);
  if (!status) {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    return {
      scanId: scan.scanId,
      scanType: scan.scanType ?? 'CURRENT_PAGE',
      status: scan.status ?? 'COMPLETED',
      progress: scan.progress ?? {
        discoveredPages: 1,
        completedPages: 1,
        failedPages: 0,
        issuesFound: scan.issues.length,
      },
      healthScore: scan.healthScore,
    };
  }
  return status;
});

app.get<{ Params: { scanId: string } }>('/scans/:scanId/pages', async (request, reply) => {
  if (!repo.isEnabled()) {
    return reply.status(404).send({ error: 'Page list not available for legacy scans' });
  }

  const pages = await repo.getPageScans(request.params.scanId);
  if (pages.length === 0) {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    if (scan.scanType !== 'WEBSITE') {
      return reply.status(404).send({ error: 'Not a website scan' });
    }
  }
  return { scanId: request.params.scanId, pages };
});

app.get<{ Params: { scanId: string; pageScanId: string } }>(
  '/scans/:scanId/pages/:pageScanId',
  async (request, reply) => {
    if (!repo.isEnabled()) {
      return reply.status(404).send({ error: 'Page detail not available' });
    }

    const detail = await repo.getPageScanDetail(request.params.scanId, request.params.pageScanId);
    if (!detail) {
      return reply.status(404).send({ error: 'Page scan not found' });
    }
    return { scanId: request.params.scanId, ...detail };
  },
);

app.get<{ Params: { scanId: string; key: string } }>(
  '/scans/:scanId/artifacts/:key',
  async (request, reply) => {
    const filePath = artifactStore.getArtifactPath(request.params.scanId, request.params.key);
    if (!filePath) {
      return reply.status(404).send({ error: 'Artifact not found' });
    }
    const data = fs.readFileSync(filePath);
    return reply.type('image/jpeg').send(data);
  },
);

app.get<{ Params: { scanId: string }; Querystring: IssueFilters }>(
  '/scans/:scanId/issues',
  async (request, reply) => {
    const scan = await store.getScanAsync(request.params.scanId);
    if (!scan) {
      return reply.status(404).send({ error: 'Scan not found' });
    }

    const issues = filterIssues(scan.issues as import('@origami/contracts').Issue[], request.query);
    return { scanId: scan.scanId, url: scan.url, issues, total: issues.length };
  },
);

app.get<{ Params: { issueId: string } }>('/issues/:issueId', async (request, reply) => {
  const found = await store.getIssueAsync(request.params.issueId);
  if (!found) {
    return reply.status(404).send({ error: 'Issue not found' });
  }
  return {
    issue: found.issue,
    scan: {
      scanId: found.scan.scanId,
      url: found.scan.url,
      scannedAt: found.scan.scannedAt,
      healthScore: found.scan.healthScore,
      scanType: found.scan.scanType,
    },
  };
});

app.patch<{ Params: { issueId: string }; Body: { status: IssueStatus } }>(
  '/issues/:issueId/status',
  async (request, reply) => {
    const { status } = request.body;
    const valid: IssueStatus[] = ['open', 'in_progress', 'resolved', 'ignored'];
    if (!status || !valid.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status' });
    }

    const updated = store.updateIssueStatus(request.params.issueId, status);
    if (!updated) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    return { issue: updated };
  },
);

app.post<{ Body: ExplainIssueRequest }>('/ai/explain-issue', async (request, reply) => {
  if (!request.body.issue) {
    return reply.status(400).send({ error: 'issue is required' });
  }

  try {
    return await pipeline.explainIssue(request.body.issue, request.body.evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI explain failed';
    return reply.status(500).send({ error: message, aiAvailable: false });
  }
});

app.post<{ Body: AskRequest }>('/ai/ask', async (request, reply) => {
  if (!request.body.question) {
    return reply.status(400).send({ error: 'question is required' });
  }

  try {
    const response = await fetch(`${AI_ROUTER_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30000),
    });
    return await response.json();
  } catch (error) {
    return reply.status(500).send({
      answer: 'AI explanation unavailable.',
      aiAvailable: false,
      error: error instanceof Error ? error.message : 'Ask failed',
    });
  }
});

app.post<{ Body: Record<string, unknown> }>('/ai/suggest-fix', async (request, reply) => {
  try {
    const response = await fetch(`${AI_ROUTER_URL}/suggest-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30000),
    });
    return await response.json();
  } catch (error) {
    return reply.status(500).send({
      fix: {},
      aiAvailable: false,
      error: error instanceof Error ? error.message : 'Suggest fix failed',
    });
  }
});

app.get('/component-targets', async () => ({ targets: CODE_TARGET_META }));

app.post<{ Body: CreateComponentJobRequest }>('/components', async (request, reply) => {
  const { target, evidence, ownerId } = request.body;

  const validTargets: CodeTarget[] = ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'];
  if (!target || !validTargets.includes(target)) {
    return reply.status(400).send({ error: `target must be one of ${validTargets.join(', ')}` });
  }
  if (!evidence?.sourceUrl || !evidence.screenshotBase64 || !evidence.element) {
    return reply.status(400).send({ error: 'evidence.sourceUrl, evidence.screenshotBase64 and evidence.element are required' });
  }
  try {
    new URL(evidence.sourceUrl);
  } catch {
    return reply.status(400).send({ error: 'evidence.sourceUrl is not a valid URL' });
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId,
    sourceUrl: evidence.sourceUrl,
    pageTitle: evidence.pageTitle,
    target,
    status: 'QUEUED',
    aiAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  componentStore.saveJob(queued);
  if (componentRepo.isEnabled()) {
    await componentRepo.createJob({ jobId, ownerId, sourceUrl: evidence.sourceUrl, pageTitle: evidence.pageTitle, target }).catch(() => {});
  }
  await componentStore.saveEvidence(jobId, evidence);

  // Fire-and-forget: generation runs detached from this HTTP request/response
  // cycle inside the API process, so it survives the extension popup closing.
  enqueueComponentJob(componentStore, componentGenerator, {
    jobId,
    sourceUrl: evidence.sourceUrl,
    pageTitle: evidence.pageTitle,
    target,
    evidence,
    ownerId,
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string }; Body: { target?: CodeTarget } }>('/components/:jobId/retry', async (request, reply) => {
  const original = await componentStore.getJobAsync(request.params.jobId);
  const evidence = await componentStore.getEvidenceAsync(request.params.jobId);
  if (!original || !evidence) {
    return reply.status(404).send({ error: 'Original selection evidence is no longer available. Please make a new selection on the page.' });
  }

  const target = request.body?.target ?? original.target;
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const queued: ComponentGenerationJob = {
    jobId,
    ownerId: original.ownerId,
    sourceUrl: original.sourceUrl,
    pageTitle: original.pageTitle,
    target,
    status: 'QUEUED',
    aiAvailable: false,
    createdAt: now,
    updatedAt: now,
  };
  componentStore.saveJob(queued);
  if (componentRepo.isEnabled()) {
    await componentRepo.createJob({ jobId, ownerId: original.ownerId, sourceUrl: original.sourceUrl, pageTitle: original.pageTitle, target }).catch(() => {});
  }
  await componentStore.saveEvidence(jobId, evidence);

  enqueueComponentJob(componentStore, componentGenerator, {
    jobId,
    sourceUrl: original.sourceUrl,
    pageTitle: original.pageTitle,
    target,
    evidence,
    ownerId: original.ownerId,
  });

  return reply.status(202).send({ jobId, status: 'QUEUED' });
});

app.post<{ Params: { jobId: string }; Body: { ownerId?: string } }>('/components/:jobId/cancel', async (request, reply) => {
  const existing = await componentStore.getJobAsync(request.params.jobId);
  if (!existing) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }

  const requestOwnerId = request.body?.ownerId;
  if (!canCancelJob(existing.ownerId, requestOwnerId)) {
    return reply.status(403).send({ error: 'You do not have permission to cancel this generation job.' });
  }

  const updated = await cancelComponentJob(componentStore, request.params.jobId);
  if (!updated) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return { jobId: updated.jobId, status: updated.status };
});

app.get('/components', async (request) => {
  const ownerId = (request.query as { ownerId?: string })?.ownerId;
  return { jobs: await componentStore.listJobsAsync(ownerId) };
});

app.get<{ Params: { jobId: string } }>('/components/:jobId', async (request, reply) => {
  const job = await componentStore.getJobAsync(request.params.jobId);
  if (!job) {
    return reply.status(404).send({ error: 'Component generation job not found' });
  }
  return job;
});

async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Origami API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
