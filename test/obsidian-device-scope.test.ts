import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteObsidianDeviceStore } from "../src/sync/sqlite-device-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Obsidian device capability boundary", () => {
  test("does not let a read-only device escalate to write", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-obsidian-device-scope-"));
    roots.push(root);
    const devices = new SqliteObsidianDeviceStore(join(root, "devices.sqlite"));
    const pairing = devices.createPairing({ workspaceId: "public", projectId: "docs", capabilities: ["read"] });
    const grant = devices.redeemPairing({
      pairingCode: pairing.pairingCode,
      device: { id: "device_01JREADONLY000000001", name: "Reader", platform: "windows" },
    });

    expect(() => devices.authenticate(grant.credential, {
      workspaceId: "public",
      projectId: "docs",
      capability: "write",
    })).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    devices.close();
  });
});
