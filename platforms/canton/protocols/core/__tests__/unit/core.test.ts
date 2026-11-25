import type { Network } from "@wormhole-foundation/sdk-connect";
import { createVAA, encoding, networkPlatformConfigs } from "@wormhole-foundation/sdk-connect";
import type {
  CantonUnsignedTransaction,
  DisclosedContract,
  DisclosureSource,
} from "@wormhole-foundation/sdk-canton";
import {
  CORE_PACKAGE_ID_0_12_3,
  CantonLedgerClient,
  CantonLocalSigner,
  StaticDisclosureSource,
  emitterAddress,
} from "@wormhole-foundation/sdk-canton";
import type { CantonWormholeCoreOptions } from "../../src/core.js";
import { CantonWormholeCore } from "../../src/core.js";
import type { MockReply } from "../../../../__tests__/mocks/ledger.js";
import { mockFetch } from "../../../../__tests__/mocks/ledger.js";
import {
  SANDBOX_CORE_STATE,
  SANDBOX_EMITTER_ACTIVE_CONTRACTS,
  SANDBOX_EMITTER_REGISTRY,
  SANDBOX_GG,
  SANDBOX_GUARDIAN_ADDRESS,
  SANDBOX_PUBLISHER,
  SANDBOX_PUBLISH_UPDATE,
} from "../../../../__tests__/fixtures/sandbox.js";

const ROGUE = `rogue::1220${"cc".repeat(32)}`;
const OTHER_PACKAGE = "ab".repeat(32);
const UPDATE_ID = (SANDBOX_PUBLISH_UPDATE as any).update.Transaction.value.updateId as string;

const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value));
const coreState = (): DisclosedContract => clone(SANDBOX_CORE_STATE);
const emitterRegistry = (): DisclosedContract => clone(SANDBOX_EMITTER_REGISTRY);
const withoutPayload = ({ payload: _payload, ...entry }: DisclosedContract) => entry;

/** An ACS entry of an Emitter of the publisher, derived from the recorded one */
function emitterEntry(
  emitterId: number,
  overrides: { contractId?: string; gg?: string; signatories?: string[]; address?: string } = {},
) {
  const entry = clone(SANDBOX_EMITTER_ACTIVE_CONTRACTS[0]);
  const created = entry.contractEntry.JsActiveContract.createdEvent;
  const gg = overrides.gg ?? SANDBOX_GG;
  created.contractId = overrides.contractId ?? `00${emitterId.toString(16).padStart(64, "0")}`;
  created.createArgument.guardianGovernance = gg;
  created.createArgument.emitterId = String(emitterId);
  created.createArgument.emitterAddress.value =
    overrides.address ??
    encoding.hex.encode(emitterAddress(gg, SANDBOX_PUBLISHER, emitterId).toUint8Array());
  created.signatories = overrides.signatories ?? [gg, SANDBOX_PUBLISHER].sort();
  return entry;
}

function acsReplies(...responses: unknown[][]): Record<string, MockReply[]> {
  return {
    "/v2/state/ledger-end": responses.map(() => ({ json: { offset: 9 } })),
    "/v2/state/active-contracts": responses.map((json) => ({ json })),
  };
}

function setup(
  replies: Record<string, MockReply[]> = {},
  entries: DisclosedContract[] = [coreState(), emitterRegistry()],
  options: CantonWormholeCoreOptions & { coreBridge?: string; network?: Network } = {},
) {
  const { fetchFunction, requests } = mockFetch(replies);
  const ledger = new CantonLedgerClient({
    baseUrl: "http://participant.test",
    fetch: fetchFunction,
  });
  const { coreBridge, network, ...coreOptions } = options;
  const core = CantonWormholeCore.withOptions(
    network ?? "Devnet",
    "Canton",
    ledger,
    { coreBridge: coreBridge ?? SANDBOX_GG },
    { disclosureSource: new StaticDisclosureSource({ core: entries }), ...coreOptions },
  );
  return { core, ledger, requests };
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

const exerciseOf = (tx: CantonUnsignedTransaction<Network, "Canton">) =>
  (tx.transaction.commands[0] as any).ExerciseCommand;

describe("construction", () => {
  it("needs the guardianGovernance party and a pinned package", () => {
    const ledger = new CantonLedgerClient({ baseUrl: "http://participant.test" });
    expect(() => new CantonWormholeCore("Devnet", "Canton", ledger, {})).toThrow(
      /No guardianGovernance party \(contracts.coreBridge\)/,
    );
    expect(() => new CantonWormholeCore("Devnet", "Canton", ledger, { coreBridge: "gg" })).toThrow(
      /Invalid Canton party id/,
    );
    expect(
      () => new CantonWormholeCore("Mainnet", "Canton", ledger, { coreBridge: SANDBOX_GG }),
    ).toThrow(/No wormhole-core package id is known for Canton Mainnet/);
    const core = new CantonWormholeCore("Devnet", "Canton", ledger, { coreBridge: SANDBOX_GG });
    expect(core.packageIds).toEqual([CORE_PACKAGE_ID_0_12_3]);
  });

  it("fromRpc takes network, chain and contracts from the one configured chain", async () => {
    const ledger = new CantonLedgerClient({ baseUrl: "http://participant.test" });
    const config = networkPlatformConfigs("Devnet", "Canton");
    const core = await CantonWormholeCore.fromRpc(ledger, {
      Canton: { ...config.Canton!, contracts: { coreBridge: SANDBOX_GG } },
    });
    expect([core.network, core.chain, core.guardianGovernance]).toEqual([
      "Devnet",
      "Canton",
      SANDBOX_GG,
    ]);
    await expect(CantonWormholeCore.fromRpc(ledger, {})).rejects.toThrow(
      /exactly one configured Canton chain, found 0/,
    );
  });

  it("takes the disclosure source from the options, the connection, or the network", () => {
    const source: DisclosureSource = new StaticDisclosureSource({ core: [] });
    const ledger = new CantonLedgerClient({
      baseUrl: "http://participant.test",
      disclosureSource: source,
    });
    expect(
      new CantonWormholeCore("Devnet", "Canton", ledger, {
        coreBridge: SANDBOX_GG,
      }).disclosureSource(),
    ).toBe(source);
    const other = new StaticDisclosureSource({ core: [] });
    expect(
      CantonWormholeCore.withOptions(
        "Devnet",
        "Canton",
        ledger,
        { coreBridge: SANDBOX_GG },
        {
          disclosureSource: other,
        },
      ).disclosureSource(),
    ).toBe(other);
    const bare = new CantonLedgerClient({ baseUrl: "http://participant.test" });
    expect(() =>
      new CantonWormholeCore("Devnet", "Canton", bare, {
        coreBridge: SANDBOX_GG,
      }).disclosureSource(),
    ).toThrow(/Devnet has no core disclosure service URL/);
  });
});

describe("getters", () => {
  it.each([
    ["a served payload", [coreState(), emitterRegistry()]],
    [
      "the created event blob only",
      [withoutPayload(coreState()), withoutPayload(emitterRegistry())],
    ],
  ])("read fee and guardian set from %s", async (_name, entries) => {
    const { core } = setup({}, entries);
    expect(await core.getMessageFee()).toBe(0n);
    expect(await core.getGuardianSetIndex()).toBe(0);
    expect(await core.getGuardianSet(0)).toEqual({
      index: 0,
      keys: [`0x${SANDBOX_GUARDIAN_ADDRESS}`],
      expiry: 0n,
    });
    await expect(core.getGuardianSet(3)).rejects.toThrow(
      /Guardian set 3 is not stored in the CoreState; stored: 0/,
    );
  });

  it("returns the expiry of a previous set in seconds", async () => {
    const entry = coreState();
    const payload = entry.payload as any;
    const set = payload.guardianSets[0][1];
    payload.guardianSets = [
      ["0", { ...set, expirationTime: "2026-11-25T10:00:00.900Z" }],
      ["1", set],
    ];
    payload.guardianSetIndex = "1";
    const { core } = setup({}, [entry]);
    expect((await core.getGuardianSet(0)).expiry).toBe(
      BigInt(Date.parse("2026-11-25T10:00:00Z") / 1000),
    );
    expect(await core.getGuardianSetIndex()).toBe(1);
  });

  it("rejects a rogue CoreState whose envelope lacks the configured guardianGovernance", async () => {
    for (const entries of [[coreState()], [withoutPayload(coreState())]]) {
      const { core } = setup({}, entries, { coreBridge: ROGUE });
      await expect(core.getMessageFee()).rejects.toThrow(
        new RegExp(`CoreState ${SANDBOX_CORE_STATE.contractId} is not signed by ${ROGUE}`),
      );
    }
  });

  it("rejects a disclosed entry with an unpinned package id", async () => {
    const entry = coreState();
    entry.templateId = entry.templateId.replace(CORE_PACKAGE_ID_0_12_3, OTHER_PACKAGE);
    await expect(setup({}, [entry]).core.getMessageFee()).rejects.toThrow(
      /has package abab.*; pinned: 32abbcd2/,
    );
    const pinnedElsewhere = setup({}, [coreState()], {
      corePackageIds: { current: OTHER_PACKAGE },
    });
    await expect(pinnedElsewhere.core.getMessageFee()).rejects.toThrow(/pinned: abab/);
  });

  it("accepts the retiring package id during an upgrade window", async () => {
    const { core } = setup({}, [coreState()], {
      corePackageIds: { current: OTHER_PACKAGE, retiring: CORE_PACKAGE_ID_0_12_3 },
    });
    expect(await core.getMessageFee()).toBe(0n);
  });

  it("rejects a served payload that names another guardianGovernance", async () => {
    const entry = coreState();
    (entry.payload as any).guardianGovernance = ROGUE;
    await expect(setup({}, [entry]).core.getMessageFee()).rejects.toThrow(
      /The CoreState payload names guardianGovernance rogue::/,
    );
  });

  it("rejects a source without exactly one entry per role, or with the wrong template", async () => {
    await expect(setup({}, [emitterRegistry()]).core.getMessageFee()).rejects.toThrow(
      /returned 0 CoreState entries; expected one/,
    );
    await expect(setup({}, [coreState(), coreState()]).core.getMessageFee()).rejects.toThrow(
      /returned 2 CoreState entries/,
    );
    const mislabelled = { ...emitterRegistry(), role: "CoreState" };
    await expect(setup({}, [mislabelled]).core.getMessageFee()).rejects.toThrow(
      /has template .*EmitterRegistry, expected Wormhole.Core.State:CoreState/,
    );
    const many = Array.from({ length: 17 }, () => emitterRegistry());
    await expect(setup({}, many).core.getMessageFee()).rejects.toThrow(/at most 16/);
  });
});

describe("emitters", () => {
  it("reads the owner's Emitters under guardianGovernance, sorted by id", async () => {
    const { core, requests } = setup(
      acsReplies([
        emitterEntry(4),
        emitterEntry(1),
        emitterEntry(2, { gg: ROGUE }),
        emitterEntry(3, { signatories: [SANDBOX_PUBLISHER] }),
      ]),
    );
    const emitters = await core.getEmitters(SANDBOX_PUBLISHER);
    expect(emitters.map((emitter) => emitter.emitterId)).toEqual([1n, 4n]);
    expect(emitters[0]!.address.equals(emitterAddress(SANDBOX_GG, SANDBOX_PUBLISHER, 1))).toBe(
      true,
    );
    const filter = (requests[1]!.body as any).eventFormat.filtersByParty[SANDBOX_PUBLISHER];
    expect(filter.cumulative[0].identifierFilter.TemplateFilter.value.templateId).toBe(
      "#wormhole-core:Wormhole.Core.State:Emitter",
    );
  });

  it("rejects an Emitter whose stored address is not the derived one", async () => {
    const { core } = setup(acsReplies([emitterEntry(1, { address: "00".repeat(32) })]));
    await expect(core.getEmitters(SANDBOX_PUBLISHER)).rejects.toThrow(/stores address 0000/);
  });
});

describe("publishMessage", () => {
  it("fails without an emitter: no auto-registration", async () => {
    const { core } = setup(acsReplies([]));
    await expect(collect(core.publishMessage(SANDBOX_PUBLISHER, "hi", 0, 0))).rejects.toThrow(
      /has no Emitter under this guardianGovernance; register one with registerEmitter first/,
    );
  });

  it("builds one command on the only emitter, with the CoreState disclosed", async () => {
    const { core } = setup(acsReplies([emitterEntry(0)]), [withoutPayload(coreState())]);
    const [tx, ...rest] = await collect(core.publishMessage(SANDBOX_PUBLISHER, "hi", 3, 200));
    expect(rest).toHaveLength(0);
    const envelope = tx!.transaction;
    expect(exerciseOf(tx!)).toEqual({
      templateId: "#wormhole-core:Wormhole.Core.State:Emitter",
      contractId: `00${"0".repeat(64)}`,
      choice: "PublishMessage",
      choiceArgument: {
        nonce: "3",
        payload: { tag: "MessagePayload", value: encoding.hex.encode(encoding.bytes.encode("hi")) },
        consistencyLevel: "200",
        coreStateCid: SANDBOX_CORE_STATE.contractId,
        payer: SANDBOX_PUBLISHER,
        feeAllocation: null,
      },
    });
    expect(envelope.actAs).toEqual([SANDBOX_PUBLISHER]);
    expect(envelope.disclosedContracts).toEqual([
      {
        templateId: SANDBOX_CORE_STATE.templateId,
        contractId: SANDBOX_CORE_STATE.contractId,
        createdEventBlob: SANDBOX_CORE_STATE.createdEventBlob,
        synchronizerId: SANDBOX_CORE_STATE.synchronizerId,
      },
    ]);
    expect(envelope.synchronizerId).toBe(SANDBOX_CORE_STATE.synchronizerId);
    expect(envelope.packageIdSelectionPreference).toEqual([CORE_PACKAGE_ID_0_12_3]);
    expect(envelope.commandId).toMatch(/^wormhole-sdk-[0-9a-f]{64}$/);
    expect(tx!.description).toBe("CantonWormholeCore.publishMessage");
    expect(typeof tx!.rebuild).toBe("function");
  });

  it("requires an explicit emitter id among several emitters", async () => {
    const several = [emitterEntry(5), emitterEntry(2)];
    await expect(
      collect(setup(acsReplies(several)).core.publishMessage(SANDBOX_PUBLISHER, "x", 0, 0)),
    ).rejects.toThrow(/has 2 Emitters \(ids 2, 5\); pass the emitterId/);
    const [tx] = await collect(
      setup(acsReplies(several)).core.publishMessage(SANDBOX_PUBLISHER, "x", 0, 0, {
        emitterId: 5n,
        commandId: "my-command",
      }),
    );
    expect(exerciseOf(tx!).contractId).toBe(`00${"5".padStart(64, "0")}`);
    expect(tx!.transaction.commandId).toBe("my-command");
    await expect(
      collect(
        setup(acsReplies(several)).core.publishMessage(SANDBOX_PUBLISHER, "x", 0, 0, {
          emitterId: 9,
        }),
      ),
    ).rejects.toThrow(/has no Emitter with id 9; its emitter ids: 2, 5/);
  });

  it("refuses a fee above zero", async () => {
    const entry = coreState();
    (entry.payload as any).messageFee = "5";
    await expect(
      collect(
        setup(acsReplies([emitterEntry(0)]), [entry]).core.publishMessage(
          SANDBOX_PUBLISHER,
          "x",
          0,
          0,
        ),
      ),
    ).rejects.toThrow(/The message fee is 5 .* only a zero fee until milestone M5/);
  });

  it("refuses an emitter on another synchronizer than the CoreState", async () => {
    const entry = emitterEntry(0);
    entry.contractEntry.JsActiveContract.synchronizerId = "other::1220aa";
    await expect(
      collect(setup(acsReplies([entry])).core.publishMessage(SANDBOX_PUBLISHER, "x", 0, 0)),
    ).rejects.toThrow(/is on synchronizer other::1220aa, the CoreState on synchronizer-1::/);
  });

  it("rejects a sender that is not a party", async () => {
    await expect(
      collect(setup().core.publishMessage("ab".repeat(32) as any, "x", 0, 0)),
    ).rejects.toThrow(/is not a party/);
  });

  it("rebuilds with a fresh Emitter after an inactive-contract rejection", async () => {
    const submitted = {
      transaction: { updateId: UPDATE_ID, commandId: "c", events: [] },
    };
    const replies = {
      ...acsReplies([emitterEntry(0)], [emitterEntry(0, { contractId: `00${"ee".repeat(32)}` })]),
      "/v2/commands/submit-and-wait-for-transaction": [
        {
          status: 404,
          json: { code: "CONTRACT_NOT_FOUND", cause: "Contract could not be found with id 00..." },
        },
        { json: submitted },
      ],
    };
    const { core, ledger, requests } = setup(replies);
    const txs = await collect(core.publishMessage(SANDBOX_PUBLISHER, "x", 0, 0));
    const signer = new CantonLocalSigner<Network, "Canton">("Canton", ledger, SANDBOX_PUBLISHER, {
      userId: "sdk-test",
    });
    expect(await signer.signAndSend(txs)).toEqual([UPDATE_ID]);
    const submits = requests.filter((request) => request.path.endsWith("for-transaction"));
    expect(submits).toHaveLength(2);
    const [first, second] = submits.map((request) => (request.body as any).commands);
    expect(first.commands[0].ExerciseCommand.contractId).toBe(`00${"0".repeat(64)}`);
    expect(second.commands[0].ExerciseCommand.contractId).toBe(`00${"ee".repeat(32)}`);
    expect(second.commandId).toBe(first.commandId);
    expect(second.userId).toBe("sdk-test");
  });
});

describe("registerEmitter", () => {
  it("exercises RegisterEmitter with the EmitterRegistry disclosed", async () => {
    const { core } = setup({}, [coreState(), withoutPayload(emitterRegistry())]);
    const [tx] = await collect(core.registerEmitter(SANDBOX_PUBLISHER));
    expect(exerciseOf(tx!)).toEqual({
      templateId: "#wormhole-core:Wormhole.Core.State:EmitterRegistry",
      contractId: SANDBOX_EMITTER_REGISTRY.contractId,
      choice: "RegisterEmitter",
      choiceArgument: {
        requester: SANDBOX_PUBLISHER,
        payer: SANDBOX_PUBLISHER,
        coreStateCid: null,
        feeAllocation: null,
        expectedGuardianGovernance: SANDBOX_GG,
      },
    });
    expect(tx!.transaction.disclosedContracts.map((entry) => entry.contractId)).toEqual([
      SANDBOX_EMITTER_REGISTRY.contractId,
    ]);
  });

  it("refuses a registration fee above zero and a rogue registry", async () => {
    const entry = emitterRegistry();
    (entry.payload as any).registrationFee = "1";
    await expect(
      collect(setup({}, [coreState(), entry]).core.registerEmitter(SANDBOX_PUBLISHER)),
    ).rejects.toThrow(/The registration fee is 1/);
    await expect(
      collect(
        setup({}, [coreState(), emitterRegistry()], { coreBridge: ROGUE }).core.registerEmitter(
          SANDBOX_PUBLISHER,
        ),
      ),
    ).rejects.toThrow(/EmitterRegistry .* is not signed by rogue::/);
  });
});

describe("verifyMessage", () => {
  it("exercises ParseAndVerifyVAA with the sender as verifier", async () => {
    const vaa = createVAA("Uint8Array", {
      guardianSet: 0,
      timestamp: 1,
      nonce: 2,
      emitterChain: "Canton",
      emitterAddress: emitterAddress(SANDBOX_GG, SANDBOX_PUBLISHER, 0),
      sequence: 3n,
      consistencyLevel: 0,
      signatures: [],
      payload: new Uint8Array([1, 2]),
    });
    const [tx] = await collect(setup().core.verifyMessage(SANDBOX_PUBLISHER, vaa));
    const exercise = exerciseOf(tx!);
    expect(exercise.templateId).toBe("#wormhole-core:Wormhole.Core.State:CoreState");
    expect(exercise.contractId).toBe(SANDBOX_CORE_STATE.contractId);
    expect(exercise.choice).toBe("ParseAndVerifyVAA");
    expect(exercise.choiceArgument.verifier).toBe(SANDBOX_PUBLISHER);
    expect(exercise.choiceArgument.encodedVAA.tag).toBe("EncodedVaa");
    expect(exercise.choiceArgument.encodedVAA.value).toMatch(/^01000000000000000001/);
  });
});

describe("parseTransaction and parseMessages", () => {
  const update = () => clone(SANDBOX_PUBLISH_UPDATE);
  const replyWith = (json: unknown) => ({ "/v2/updates/update-by-id": [{ json }] });

  it("finds the recorded publish and derives the emitter as the watcher does", async () => {
    const { core, requests } = setup(replyWith(update()));
    const ids = await core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER);
    expect(ids).toHaveLength(1);
    expect(ids[0]!.chain).toBe("Canton");
    expect(ids[0]!.sequence).toBe(0n);
    expect(ids[0]!.emitter.equals(emitterAddress(SANDBOX_GG, SANDBOX_PUBLISHER, 0))).toBe(true);
    const eventFormat = (requests[0]!.body as any).updateFormat.includeTransactions.eventFormat;
    expect(Object.keys(eventFormat.filtersByParty)).toEqual([SANDBOX_PUBLISHER]);
  });

  it("reads as the configured readers, else as any party", async () => {
    const configured = setup(replyWith(update()), undefined, { readAs: [SANDBOX_GG] });
    await configured.core.parseTransaction(UPDATE_ID);
    expect(
      Object.keys(
        (configured.requests[0]!.body as any).updateFormat.includeTransactions.eventFormat
          .filtersByParty,
      ),
    ).toEqual([SANDBOX_GG]);
    const anyParty = setup(replyWith(update()));
    await anyParty.core.parseTransaction(UPDATE_ID);
    expect(
      (anyParty.requests[0]!.body as any).updateFormat.includeTransactions.eventFormat
        .filtersForAnyParty,
    ).toBeDefined();
  });

  it("finds PublishMessage exercises nested in other choices", async () => {
    const recorded = update();
    const transaction = recorded.update.Transaction.value;
    const publish = transaction.events[0].ExercisedEvent;
    const second = clone(publish);
    second.nodeId = 7;
    second.exerciseResult._2.sequence = "1";
    second.exerciseResult._2.emitterId = "3";
    transaction.events = [
      {
        ExercisedEvent: {
          ...clone(publish),
          nodeId: 0,
          lastDescendantNodeId: 9,
          templateId: `${"cd".repeat(32)}:Wormhole.Ntt.Manager:NttManager`,
          choice: "Transfer",
          consuming: false,
          exerciseResult: { sequence: "0" },
        },
      },
      { ExercisedEvent: { ...publish, nodeId: 1, lastDescendantNodeId: 4 } },
      ...transaction.events.slice(1),
      { ExercisedEvent: second },
    ];
    const ids = await setup(replyWith(recorded)).core.parseTransaction(
      UPDATE_ID,
      SANDBOX_PUBLISHER,
    );
    expect(ids.map((id) => id.sequence)).toEqual([0n, 1n]);
    expect(ids[1]!.emitter.equals(emitterAddress(SANDBOX_GG, SANDBOX_PUBLISHER, 3))).toBe(true);
  });

  it("drops a message whose registrar is not guardianGovernance, as the watcher does", async () => {
    const rogueOnly = update();
    rogueOnly.update.Transaction.value.events[0].ExercisedEvent.exerciseResult._2.registrar = ROGUE;
    await expect(
      setup(replyWith(rogueOnly)).core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER),
    ).rejects.toThrow(
      /1 PublishMessage exercise\(s\) that the guardians drop: node 0 has registrar rogue::/,
    );

    const mixed = update();
    const events = mixed.update.Transaction.value.events;
    const rogue = clone(events[0]);
    rogue.ExercisedEvent.exerciseResult._2.registrar = ROGUE;
    events.push(rogue);
    const ids = await setup(replyWith(mixed)).core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER);
    expect(ids).toHaveLength(1);
  });

  it("drops a publish of an unpinned package or a non-consuming exercise", async () => {
    const unpinned = update();
    const exercised = unpinned.update.Transaction.value.events[0].ExercisedEvent;
    exercised.templateId = exercised.templateId.replace(CORE_PACKAGE_ID_0_12_3, OTHER_PACKAGE);
    await expect(
      setup(replyWith(unpinned)).core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER),
    ).rejects.toThrow(/executes package abab.*, which is not pinned/);
    const nonConsuming = update();
    nonConsuming.update.Transaction.value.events[0].ExercisedEvent.consuming = false;
    await expect(
      setup(replyWith(nonConsuming)).core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER),
    ).rejects.toThrow(/is not a consuming exercise/);
  });

  it("returns no message for a transaction without a publish", async () => {
    const none = update();
    none.update.Transaction.value.events = none.update.Transaction.value.events.slice(1);
    expect(
      await setup(replyWith(none)).core.parseTransaction(UPDATE_ID, SANDBOX_PUBLISHER),
    ).toEqual([]);
  });

  it("rejects an id that is not an update id", async () => {
    await expect(setup().core.parseTransaction("0xabc")).rejects.toThrow(/is an update id/);
  });

  it("builds unsigned VAAs with the effective time and the current guardian set", async () => {
    const recorded = update();
    const [vaa] = await setup(replyWith(recorded)).core.parseMessages(UPDATE_ID, SANDBOX_PUBLISHER);
    expect(vaa!.timestamp).toBe(
      Math.floor(Date.parse(recorded.update.Transaction.value.effectiveAt) / 1000),
    );
    expect(vaa!.guardianSet).toBe(0);
    expect(vaa!.emitterChain).toBe("Canton");
    expect(vaa!.nonce).toBe(7);
    expect(vaa!.consistencyLevel).toBe(1);
    expect(vaa!.sequence).toBe(0n);
    expect(vaa!.signatures).toEqual([]);
    expect(encoding.bytes.decode(vaa!.payload)).toBe("canton sdk integration");
  });
});
