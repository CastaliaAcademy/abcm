import { resolve } from "node:path";

export interface TaskSuccessEnvironmentOptions {
  businessEvaluationWorkerToken?: string;
  businessEvaluationTaskStateRoot?: string;
}

export function parseTaskSuccessEnvironment(environment: Readonly<Record<string, string | undefined>>): TaskSuccessEnvironmentOptions {
  const workerToken = environment.ABCM_BUSINESS_EVALUATION_WORKER_TOKEN;
  const taskStateRoot = environment.ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT;
  if (workerToken === undefined && taskStateRoot === undefined) return {};
  if (workerToken === undefined || taskStateRoot === undefined) {
    throw new Error(
      "ABCM_BUSINESS_EVALUATION_WORKER_TOKEN and ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT must be configured together.",
    );
  }
  if (workerToken.trim() === "") {
    throw new Error("ABCM_BUSINESS_EVALUATION_WORKER_TOKEN must not be empty.");
  }
  if (taskStateRoot.trim() === "") {
    throw new Error("ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT must not be empty.");
  }
  return {
    businessEvaluationWorkerToken: workerToken,
    businessEvaluationTaskStateRoot: resolve(taskStateRoot),
  };
}
