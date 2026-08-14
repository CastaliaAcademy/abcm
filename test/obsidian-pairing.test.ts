import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteObsidianDeviceStore } from "../src/sync/sqlite-device-store.js";

const roots: string[] = [];
const databasePaths: string[] = [];

async function store(clock?: () => number) {
  const root = await mkdtemp(join(tmpdir(), "abcm-obsidian-pairing-"));
  roots.push(root);
  const databasePath = join(root, "devices.sqlite");
  databasePaths.push(databasePath);
  return new SqliteObsidianDeviceStore(databasePath, clock === undefined ? {} : { clock });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Obsidian scoped device pairing", () => {
  test("redeems a one-time server-scoped code and authenticates only its granted scope", async () => {
    const devices = await store();
    const pairing = devices.createPairing({
      workspaceId: "castalia-public",
      projectId: "abcm",
      projectPrefix: "abcm",
      capabilities: ["read", "write"],
    });

    const grant = devices.redeemPairing({
      pairingCode: pairing.pairingCode,
      device: { id: "device_01JABCDEF0123456789", name: "Egor iPad", platform: "ipados" },
    });

    expect(grant).toEqual(expect.objectContaining({
      workspaceId: "castalia-public",
      projectId: "abcm",
      projectPrefix: "abcm",
      capabilities: ["read", "write"],
    }));
    expect(grant.credential).toStartWith("obs_device_");
    expect(devices.authenticate(grant.credential, {
      workspaceId: "castalia-public",
      projectId: "abcm",
      capability: "write",
    })).toEqual(expect.objectContaining({ deviceId: "device_01JABCDEF0123456789" }));
    expect(() => devices.authenticate(grant.credential, {
      workspaceId: "castalia-public",
      projectId: "other",
      capability: "read",
    })).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    expect(() => devices.redeemPairing({
      pairingCode: pairing.pairingCode,
      device: { id: "device_01JOTHER000000000001", name: "Replay", platform: "linux" },
    })).toThrow(expect.objectContaining({ code: "AUTHENTICATION_REQUIRED" }));
    devices.close();
    const reopened = new SqliteObsidianDeviceStore(databasePaths.at(-1)!);
    expect(reopened.authenticate(grant.credential, { workspaceId: "castalia-public", projectId: "abcm", capability: "read" })).toEqual(expect.objectContaining({ deviceId: grant.deviceId }));
    reopened.close();
  });

  test("expires pairing codes, persists only secret hashes, and revokes a device immediately", async () => {
    let now = Date.parse("2026-08-14T10:00:00.000Z");
    const devices = await store(() => now);
    const pairing = devices.createPairing({
      workspaceId: "castalia-public",
      projectId: "abcm",
      capabilities: ["read"],
      expiresInSeconds: 60,
    });
    now += 61_000;
    expect(() => devices.redeemPairing({
      pairingCode: pairing.pairingCode,
      device: { id: "device_01JEXPIRED0000000001", name: "Expired", platform: "windows" },
    })).toThrow(expect.objectContaining({ code: "AUTHENTICATION_REQUIRED" }));

    const active = devices.createPairing({ workspaceId: "castalia-public", projectId: "abcm", capabilities: ["read"] });
    const grant = devices.redeemPairing({
      pairingCode: active.pairingCode,
      device: { id: "device_01JREVOKED0000000001", name: "Linux", platform: "linux" },
    });
    const persisted = (await readFile(databasePaths.at(-1)!)).toString("latin1");
    expect(persisted).not.toContain(active.pairingCode);
    expect(persisted).not.toContain(grant.credential);

    devices.revokeDevice("device_01JREVOKED0000000001");
    expect(() => devices.authenticate(grant.credential, {
      workspaceId: "castalia-public",
      projectId: "abcm",
      capability: "read",
    })).toThrow(expect.objectContaining({ code: "AUTHENTICATION_REQUIRED" }));
    devices.close();
  });
});
