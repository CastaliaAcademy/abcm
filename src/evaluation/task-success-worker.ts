import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod/v4";

import { businessVariantObservationSchema, type BusinessEvaluationReceipt, type BusinessVariantObservation } from "./context-business-eval-runner.js";
import type { PreparedTaskSuccessEvaluation } from "./context-business-eval-profile.js";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();

export const taskSuccessStartRequestSchema = z.object({ profileId: id }).strict();
export const taskSuccessClaimRequestSchema = z.object({
  workerPoolId: id,
  workerId: id,
  leaseSeconds: z.number().int().min(10).max(900).default(60),
}).strict();
export const taskSuccessSubmitRequestSchema = z.object({
  jobId: z.string().regex(/^task-job-[a-f0-9]{24}$/),
  leaseToken: z.string().uuid(),
  resultDigest: digest,
  taskSucceeded: z.boolean(),
  firstAttemptSucceeded: z.boolean(),
  totalCostMicrounits: count,
  outputTokens: count,
  toolTokens: count,
  verifiedClaimIds: z.array(id).max(512),
  errorCode: id.nullable(),
  judgeVerdictDigest: digest,
}).strict().superRefine((submission, context) => {
  if (submission.taskSucceeded && submission.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "Successful tasks must not carry an error code." });
});

export const taskSuccessSessionSchema = z.object({
  schemaVersion: z.literal("abcm.eval.task-success-session/v1"),
  sessionId: z.string().regex(/^task-session-[a-f0-9]{24}$/),
  profileId: id,
  workspaceId: id,
  datasetId: id,
  status: z.enum(["pending", "running", "completed"]),
  jobCount: z.number().int().positive(),
  pendingCount: count,
  leasedCount: count,
  completedCount: count,
  receiptRunId: z.string().regex(/^business-run-[a-f0-9]{24}$/).optional(),
  receiptDigest: digest.optional(),
}).strict();

export const taskSuccessClaimResultSchema = z.object({
  job: z.object({
    jobId: z.string().regex(/^task-job-[a-f0-9]{24}$/),
    sessionId: z.string().regex(/^task-session-[a-f0-9]{24}$/),
    leaseToken: z.string().uuid(),
    leaseExpiresAt: z.string().datetime(),
    blindLabel: z.string().regex(/^blind-[a-f0-9]{16}$/),
    prompt: z.string().min(1),
    contextDocuments: z.array(z.object({ documentId: id, content: z.string() }).strict()),
    modelIdentityDigest: digest,
    judgeRubricDigest: digest,
    judgeIdentityClass: id,
  }).strict().nullable(),
}).strict();

export type TaskSuccessSession = z.infer<typeof taskSuccessSessionSchema>;

export interface TaskSuccessEvaluationBackend {
  prepareTaskSuccess(profileId: string, signal?: AbortSignal): Promise<PreparedTaskSuccessEvaluation>;
  finalizeTaskSuccess(profileId: string, observations: ReadonlyMap<string, BusinessVariantObservation>, signal?: AbortSignal): Promise<BusinessEvaluationReceipt>;
}

interface StoredJob {
  jobId: string;
  key: string;
  prepared: PreparedTaskSuccessEvaluation["jobs"][number];
  state: "pending" | "leased" | "completed";
  leaseToken?: string;
  leaseExpiresAt?: number;
  observation?: BusinessVariantObservation;
}

interface StoredSession {
  sessionId: string;
  prepared: PreparedTaskSuccessEvaluation;
  jobs: StoredJob[];
  receipt?: BusinessEvaluationReceipt;
}

const durableSessionSchema = z.object({
  schemaVersion: z.literal("abcm.eval.task-success-state/v1"),
  sessionId: z.string().regex(/^task-session-[a-f0-9]{24}$/),
  profileId: id,
  completed: z.array(z.object({ key: id, observation: businessVariantObservationSchema }).strict()),
}).strict();

export class DirectoryTaskSuccessStateStore {
  readonly #root: string;
  readonly ready: Promise<void>;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
    this.ready = mkdir(this.#root, { recursive: true }).then(() => undefined);
  }

  async load(sessionId: string): Promise<z.infer<typeof durableSessionSchema> | undefined> {
    await this.ready;
    try {
      return durableSessionSchema.parse(JSON.parse(await readFile(join(this.#root, `${sessionId}.json`), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(session: StoredSession): Promise<void> {
    await this.ready;
    const record = durableSessionSchema.parse({
      schemaVersion: "abcm.eval.task-success-state/v1",
      sessionId: session.sessionId,
      profileId: session.prepared.profile.id,
      completed: session.jobs.filter(job => job.observation !== undefined).map(job => ({ key: job.key, observation: job.observation! })),
    });
    const write = async () => {
      const target = join(this.#root, `${session.sessionId}.json`);
      const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    };
    const current = this.#writeChain.then(write);
    this.#writeChain = current.catch(() => undefined);
    await current;
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

export class TaskSuccessWorkerCoordinator {
  readonly #backend: TaskSuccessEvaluationBackend;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #jobs = new Map<string, { session: StoredSession; job: StoredJob }>();
  readonly #clock: () => number;
  readonly #state: DirectoryTaskSuccessStateStore | undefined;
  readonly ready: Promise<void>;

  constructor(backend: TaskSuccessEvaluationBackend, options: { clock?: () => number; stateRoot?: string } = {}) {
    this.#backend = backend;
    this.#clock = options.clock ?? Date.now;
    this.#state = options.stateRoot === undefined ? undefined : new DirectoryTaskSuccessStateStore(options.stateRoot);
    this.ready = this.#state?.ready ?? Promise.resolve();
  }

  async start(input: unknown, signal?: AbortSignal): Promise<TaskSuccessSession> {
    await this.ready;
    const { profileId } = taskSuccessStartRequestSchema.parse(input);
    const prepared = await this.#backend.prepareTaskSuccess(profileId, signal);
    const sessionDigest = sha({ profileId, inputIdentity: prepared.input.inputIdentity, blindSeedDigest: prepared.input.blindSeedDigest });
    const sessionId = `task-session-${sessionDigest.slice(7, 31)}`;
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return this.#summary(existing);
    const session: StoredSession = { sessionId, prepared, jobs: [] };
    session.jobs = prepared.jobs.map(job => {
      const jobDigest = sha({ sessionId, scenarioId: job.scenarioId, variant: job.variant, repeatIndex: job.repeatIndex });
      const stored: StoredJob = { jobId: `task-job-${jobDigest.slice(7, 31)}`, key: `${job.scenarioId}:${job.variant}:${job.repeatIndex}`, prepared: job, state: "pending" };
      this.#jobs.set(stored.jobId, { session, job: stored });
      return stored;
    }).sort((left, right) => sha({ seed: prepared.input.blindSeedDigest, jobId: left.jobId }).localeCompare(sha({ seed: prepared.input.blindSeedDigest, jobId: right.jobId })));
    const durable = await this.#state?.load(sessionId);
    if (durable !== undefined) {
      if (durable.profileId !== profileId) throw new Error("Durable task-success session is bound to another profile.");
      const completed = new Map(durable.completed.map(item => [item.key, item.observation]));
      for (const job of session.jobs) {
        const observation = completed.get(job.key);
        if (observation === undefined) continue;
        job.observation = observation;
        job.state = "completed";
      }
    }
    this.#sessions.set(sessionId, session);
    if (session.jobs.every(job => job.state === "completed")) {
      session.receipt = await this.#backend.finalizeTaskSuccess(profileId, new Map(session.jobs.map(job => [job.key, job.observation!])), signal);
    }
    await this.#state?.save(session);
    return this.#summary(session);
  }

  get(sessionId: string): TaskSuccessSession | undefined {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : this.#summary(session);
  }

  async claim(input: unknown): Promise<z.infer<typeof taskSuccessClaimResultSchema>> {
    await this.ready;
    const request = taskSuccessClaimRequestSchema.parse(input);
    const now = this.#clock();
    for (const session of [...this.#sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
      if (session.receipt !== undefined || session.prepared.profile.taskSuccess?.workerPoolId !== request.workerPoolId) continue;
      for (const job of session.jobs) {
        if (job.state === "leased" && (job.leaseExpiresAt ?? 0) <= now) {
          job.state = "pending";
          delete job.leaseToken;
          delete job.leaseExpiresAt;
        }
        if (job.state !== "pending") continue;
        job.state = "leased";
        job.leaseToken = randomUUID();
        job.leaseExpiresAt = now + request.leaseSeconds * 1_000;
        const task = session.prepared.profile.taskSuccess!;
        return taskSuccessClaimResultSchema.parse({ job: {
          jobId: job.jobId,
          sessionId: session.sessionId,
          leaseToken: job.leaseToken,
          leaseExpiresAt: new Date(job.leaseExpiresAt).toISOString(),
          blindLabel: job.prepared.blindLabel,
          prompt: job.prepared.prompt,
          contextDocuments: job.prepared.contextDocuments,
          modelIdentityDigest: task.modelIdentityDigest,
          judgeRubricDigest: task.judgeRubricDigest,
          judgeIdentityClass: task.judgeIdentityClass,
        } });
      }
    }
    return { job: null };
  }

  async submit(input: unknown, signal?: AbortSignal): Promise<TaskSuccessSession> {
    const submission = taskSuccessSubmitRequestSchema.parse(input);
    const found = this.#jobs.get(submission.jobId);
    if (found === undefined) throw new Error(`Task-success job '${submission.jobId}' was not found.`);
    const { session, job } = found;
    if (job.state !== "leased" || job.leaseToken !== submission.leaseToken || (job.leaseExpiresAt ?? 0) <= this.#clock()) {
      throw new Error("Task-success job lease is missing, expired, or belongs to another worker.");
    }
    const base = job.prepared.retrievalObservation;
    job.observation = {
      ...base,
      resultDigest: submission.resultDigest,
      judgeVerdictDigest: submission.judgeVerdictDigest,
      retrievedClaimIds: submission.verifiedClaimIds,
      taskSucceeded: submission.taskSucceeded,
      totalCostMicrounits: submission.totalCostMicrounits,
      errorCode: submission.errorCode,
      rawMetrics: {
        ...base.rawMetrics,
        firstAttemptSucceeded: submission.firstAttemptSucceeded,
        outputTokens: submission.outputTokens,
        toolTokens: submission.toolTokens,
      },
    };
    job.state = "completed";
    delete job.leaseToken;
    delete job.leaseExpiresAt;
    await this.#state?.save(session);
    if (session.jobs.every(candidate => candidate.state === "completed")) {
      const observations = new Map(session.jobs.map(candidate => [candidate.key, candidate.observation!]));
      session.receipt = await this.#backend.finalizeTaskSuccess(session.prepared.profile.id, observations, signal);
      await this.#state?.save(session);
    }
    return this.#summary(session);
  }

  #summary(session: StoredSession): TaskSuccessSession {
    const pendingCount = session.jobs.filter(job => job.state === "pending").length;
    const leasedCount = session.jobs.filter(job => job.state === "leased").length;
    const completedCount = session.jobs.filter(job => job.state === "completed").length;
    return taskSuccessSessionSchema.parse({
      schemaVersion: "abcm.eval.task-success-session/v1",
      sessionId: session.sessionId,
      profileId: session.prepared.profile.id,
      workspaceId: session.prepared.profile.workspaceId,
      datasetId: session.prepared.profile.dataset.id,
      status: session.receipt !== undefined ? "completed" : leasedCount > 0 || completedCount > 0 ? "running" : "pending",
      jobCount: session.jobs.length,
      pendingCount,
      leasedCount,
      completedCount,
      ...(session.receipt === undefined ? {} : { receiptRunId: session.receipt.runId, receiptDigest: session.receipt.aggregateDigest }),
    });
  }
}
