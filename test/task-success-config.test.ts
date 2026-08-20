import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseTaskSuccessEnvironment } from "../src/evaluation/task-success-config.js";

describe("task-success environment configuration", () => {
  test("returns no worker configuration when the operator did not enable it", () => {
    expect(parseTaskSuccessEnvironment({})).toEqual({});
  });

  test("parses the same worker token and state root for HTTP and stdio runtimes", () => {
    expect(parseTaskSuccessEnvironment({
      ABCM_BUSINESS_EVALUATION_WORKER_TOKEN: "worker-token-123456789",
      ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT: "state/task-success",
    })).toEqual({
      businessEvaluationWorkerToken: "worker-token-123456789",
      businessEvaluationTaskStateRoot: resolve("state/task-success"),
    });
  });

  test("rejects partial or empty worker configuration", () => {
    expect(() => parseTaskSuccessEnvironment({
      ABCM_BUSINESS_EVALUATION_WORKER_TOKEN: "worker-token-123456789",
    })).toThrow("must be configured together");
    expect(() => parseTaskSuccessEnvironment({
      ABCM_BUSINESS_EVALUATION_WORKER_TOKEN: "",
      ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT: "/state/tasks",
    })).toThrow("must not be empty");
  });
});
