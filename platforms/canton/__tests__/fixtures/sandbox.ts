// Responses recorded from a Canton 3.7.3 sandbox (dpm sandbox, JSON Ledger API) by the opt-in
// integration test of the core protocol (protocols/core/__tests__/integration/sandbox.test.ts,
// CANTON_FIXTURE_OUT), with wormhole-core 0.12.3. Recorded 2026-11-24. The parties are throwaway
// sandbox parties; the guardian key is a test key.

/** The guardianGovernance party of the recorded core */
export const SANDBOX_GG =
  "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5";
/** The fee recipient (feeCustody), the second CoreState signatory */
export const SANDBOX_FEE =
  "fee-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5";
/** The publisher: owner of the recorded Emitter, not a CoreState stakeholder */
export const SANDBOX_PUBLISHER =
  "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5";
/** The one guardian of set 0 */
export const SANDBOX_GUARDIAN_ADDRESS = "befa429d57cd18b7f8a4d91a2da9ab4af05d0fbe";

/** The CoreState as AcsDisclosureSource returned it, read as guardianGovernance */
export const SANDBOX_CORE_STATE = {
  role: "CoreState",
  templateId:
    "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:CoreState",
  contractId:
    "00f06333c12f87b2b48c6d765a055db6f4dea0b83b023ee9b8e39d5be583ed25ecca1212203064f09968a2ee61bc32e74558d8100df538c1f699bcabc7405e907f2d4b11b0",
  createdEventBlob:
    "CgMyLjESywgKRQDwYzPBL4eytIxtdloFXbb03qC4OwI+6bjjnVvlg+0l7MoSEiAwZPCZaKLuYbwy50VY2BAN9TjB9pm8q8dAXpB/LUsRsBINd29ybWhvbGUtY29yZRpkCkAzMmFiYmNkMmE2YjVlYmMyNTMwZjhlMmNmYzNmZDFiODUzZWQ0OTY0NDNjNmEwMTI1ZmQyY2VhNjE3YjMzMzcxEghXb3JtaG9sZRIEQ29yZRIFU3RhdGUaCUNvcmVTdGF0ZSKwBWqtBQpVClM6UWdnLW13djV6Z3BuOjoxMjIwN2E1NjFiMTc4MDdiMmYwZjAyYjA1ZTlkOTljNzgyOTk4YjAxNTA5MmJiMWIyYmU5MDRjNzNhYzhlMzY5ZDlkNQoFCgMYlgEKBAoCGAIKWApWclQKDkVtaXR0ZXJBZGRyZXNzEkJCQDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDQKBAoCGAAKjwIKjAJiiQIKhgIKAhgAEv8BavwBCvkBCvYBWvMBCvABau0BCkEKP3I9Cg9HdWFyZGlhbkFkZHJlc3MSKkIoYmVmYTQyOWQ1N2NkMThiN2Y4YTRkOTFhMmRhOWFiNGFmMDVkMGZiZQqnAQqkAVKhAQqeAXKbAQoRR3VhcmRpYW5QdWJsaWNLZXkShQFCggEwNGQ0YTQ2Mjk5NzlmMGM5ZmEwZjBiYjU0ZWRmMzNmODdjOGM1YTFmNDJjMDM1MGEzMGQ2OGY3ZTk2NzAyM2UzNGU0OTVhOGViZjUxMDEwMzZkMGZkNjZlM2IwYThjN2M2MWI2NWZjZWVhZjQ4N2FiM2NkMWI1YjdiNTBiZWI3OTcwCgQKAhgACnEKb2ptCl0KWzpZaW5zdHJ1bWVudC1td3Y1emdwbjo6MTIyMDdhNTYxYjE3ODA3YjJmMGYwMmIwNWU5ZDk5Yzc4Mjk5OGIwMTUwOTJiYjFiMmJlOTA0YzczYWM4ZTM2OWQ5ZDUKDAoKQghUZXN0Q29pbgpWClQ6UmZlZS1td3Y1emdwbjo6MTIyMDdhNTYxYjE3ODA3YjJmMGYwMmIwNWU5ZDk5Yzc4Mjk5OGIwMTUwOTJiYjFiMmJlOTA0YzczYWM4ZTM2OWQ5ZDUKBAoCYgAqUmZlZS1td3Y1emdwbjo6MTIyMDdhNTYxYjE3ODA3YjJmMGYwMmIwNWU5ZDk5Yzc4Mjk5OGIwMTUwOTJiYjFiMmJlOTA0YzczYWM4ZTM2OWQ5ZDUqUWdnLW13djV6Z3BuOjoxMjIwN2E1NjFiMTc4MDdiMmYwZjAyYjA1ZTlkOTljNzgyOTk4YjAxNTA5MmJiMWIyYmU5MDRjNzNhYzhlMzY5ZDlkNTn066vLC2EGAEIqCiYKJAgBEiC8r9LtEf+IdHJWDV804LwkrTzKk7IKalvr6579fVmcehAe",
  synchronizerId:
    "synchronizer-1::122092ad41a9bfc92ef8dd66ea810c0ed20bb7df431a6af80c0981da0dcc54e1bf0d",
  payload: {
    guardianGovernance:
      "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
    chainId: "75",
    governanceChainId: "1",
    governanceContract: {
      tag: "EmitterAddress",
      value: "0000000000000000000000000000000000000000000000000000000000000004",
    },
    guardianSetIndex: "0",
    guardianSets: [
      [
        "0",
        {
          members: [
            {
              address: {
                tag: "GuardianAddress",
                value: "befa429d57cd18b7f8a4d91a2da9ab4af05d0fbe",
              },
              publicKey: {
                tag: "GuardianPublicKey",
                value:
                  "04d4a4629979f0c9fa0f0bb54edf33f87c8c5a1f42c0350a30d68f7e967023e34e495a8ebf5101036d0fd66e3b0a8c7c61b65fceeaf487ab3cd1b5b7b50beb7970",
              },
            },
          ],
        },
      ],
    ],
    messageFee: "0",
    feeInstrument: {
      admin:
        "instrument-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
      id: "TestCoin",
    },
    feeRecipient:
      "fee-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
    consumedGovernance: [],
  },
} as const;

/** The EmitterRegistry as AcsDisclosureSource returned it, read as guardianGovernance */
export const SANDBOX_EMITTER_REGISTRY = {
  role: "EmitterRegistry",
  templateId:
    "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:EmitterRegistry",
  contractId:
    "00a8d7229417a3a5b64479e087c33e5049af82e6b22bafba1de801e94315a85e69ca121220a8c70747f2fac932e285667665d38055612bc084c97763aaca942857101ff0e1",
  createdEventBlob:
    "CgMyLjESkgQKRQCo1yKUF6OltkR54IfDPlBJr4Lmsiuvuh3oAelDFaheacoSEiCoxwdH8vrJMuKFZnZl04BVYSvAhMl3Y6rKlChXEB/w4RINd29ybWhvbGUtY29yZRpqCkAzMmFiYmNkMmE2YjVlYmMyNTMwZjhlMmNmYzNmZDFiODUzZWQ0OTY0NDNjNmEwMTI1ZmQyY2VhNjE3YjMzMzcxEghXb3JtaG9sZRIEQ29yZRIFU3RhdGUaD0VtaXR0ZXJSZWdpc3RyeSLFAWrCAQpVClM6UWdnLW13djV6Z3BuOjoxMjIwN2E1NjFiMTc4MDdiMmYwZjAyYjA1ZTlkOTljNzgyOTk4YjAxNTA5MmJiMWIyYmU5MDRjNzNhYzhlMzY5ZDlkNQpdCls6WWluc3RydW1lbnQtbXd2NXpncG46OjEyMjA3YTU2MWIxNzgwN2IyZjBmMDJiMDVlOWQ5OWM3ODI5OThiMDE1MDkyYmIxYjJiZTkwNGM3M2FjOGUzNjlkOWQ1CgQKAhgACgQKAhgAKlFnZy1td3Y1emdwbjo6MTIyMDdhNTYxYjE3ODA3YjJmMGYwMmIwNWU5ZDk5Yzc4Mjk5OGIwMTUwOTJiYjFiMmJlOTA0YzczYWM4ZTM2OWQ5ZDU5lmWxywthBgBCKgomCiQIARIgJrRfdrDXjzMXwvQTP1GrODrADGaVZW0Ohwu8IQM6Vd8QHg==",
  synchronizerId:
    "synchronizer-1::122092ad41a9bfc92ef8dd66ea810c0ed20bb7df431a6af80c0981da0dcc54e1bf0d",
  payload: {
    guardianGovernance:
      "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
    onboardingFeeAdmin:
      "instrument-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
    registrationFee: "0",
    nextId: "0",
  },
} as const;

/** POST /v2/state/active-contracts for the publisher, template filter #wormhole-core:...:Emitter */
export const SANDBOX_EMITTER_ACTIVE_CONTRACTS = [
  {
    workflowId: "",
    contractEntry: {
      JsActiveContract: {
        createdEvent: {
          offset: 122,
          nodeId: 2,
          contractId:
            "006610556d6e24e246f22b8467de5282add5c9955215761ebaade1ffa419e5ab95ca121220287a3f43a8e7f245188fc627913322133414d0fc61deacd41bd23845c0b415b0",
          templateId:
            "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:Emitter",
          contractKey: null,
          contractKeyHash: "",
          createArgument: {
            guardianGovernance:
              "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
            owner:
              "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
            emitterId: "0",
            emitterAddress: {
              tag: "EmitterAddress",
              value: "5b9007aa0d39a2ded1f3b91acadfd12a31846ddfa756db11c1db082ff55332ed",
            },
            sequence: "0",
          },
          createdEventBlob: "",
          interfaceViews: [],
          witnessParties: [
            "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
          ],
          signatories: [
            "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
            "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
          ],
          observers: [],
          createdAt: "2026-11-24T20:45:51.348642Z",
          packageName: "wormhole-core",
          representativePackageId:
            "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371",
          acsDelta: true,
        },
        synchronizerId:
          "synchronizer-1::122092ad41a9bfc92ef8dd66ea810c0ed20bb7df431a6af80c0981da0dcc54e1bf0d",
        reassignmentCounter: 0,
      },
    },
    streamContinuationToken: "CgIIQBIEDX0S6g==",
  },
];

/** POST /v2/updates/update-by-id of a publish (ledger effects, read as the publisher) */
export const SANDBOX_PUBLISH_UPDATE = {
  update: {
    Transaction: {
      value: {
        updateId: "1220023fd786e59f78e1582d2469e6643620cb051da80ab871f1b5e78eb89100ef38",
        commandId: "wormhole-sdk-077eb34f01ba703f8f69bc05cea7c697c3470a91dfe9b4d1daf0eb7da6923941",
        workflowId: "",
        effectiveAt: "2026-11-24T20:45:51.756158Z",
        events: [
          {
            ExercisedEvent: {
              offset: 125,
              nodeId: 0,
              contractId:
                "006610556d6e24e246f22b8467de5282add5c9955215761ebaade1ffa419e5ab95ca121220287a3f43a8e7f245188fc627913322133414d0fc61deacd41bd23845c0b415b0",
              templateId:
                "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:Emitter",
              interfaceId: null,
              choice: "PublishMessage",
              choiceArgument: {
                nonce: "7",
                payload: {
                  tag: "MessagePayload",
                  value: "63616e746f6e2073646b20696e746567726174696f6e",
                },
                consistencyLevel: "1",
                coreStateCid:
                  "00f06333c12f87b2b48c6d765a055db6f4dea0b83b023ee9b8e39d5be583ed25ecca1212203064f09968a2ee61bc32e74558d8100df538c1f699bcabc7405e907f2d4b11b0",
                payer:
                  "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              },
              actingParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              consuming: true,
              witnessParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              lastDescendantNodeId: 3,
              exerciseResult: {
                _1: "00f73c0a9a4094f40aa49f4aa20d0f0964da46ffbeb1bc4a9e5be085560e4d591aca1212201916f120e9d598221e8f866abd2113d4e79c2f3e33916ef9eaa59ccdd0e2912d",
                _2: {
                  registrar:
                    "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
                  owner:
                    "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
                  emitterId: "0",
                  sequence: "0",
                  nonce: "7",
                  consistencyLevel: "1",
                  payload: {
                    tag: "MessagePayload",
                    value: "63616e746f6e2073646b20696e746567726174696f6e",
                  },
                },
              },
              packageName: "wormhole-core",
              implementedInterfaces: [],
              acsDelta: true,
            },
          },
          {
            ExercisedEvent: {
              offset: 125,
              nodeId: 1,
              contractId:
                "00f06333c12f87b2b48c6d765a055db6f4dea0b83b023ee9b8e39d5be583ed25ecca1212203064f09968a2ee61bc32e74558d8100df538c1f699bcabc7405e907f2d4b11b0",
              templateId:
                "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:CoreState",
              interfaceId: null,
              choice: "GetGuardianGovernance",
              choiceArgument: {
                reader:
                  "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              },
              actingParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              consuming: false,
              witnessParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              lastDescendantNodeId: 1,
              exerciseResult:
                "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              packageName: "wormhole-core",
              implementedInterfaces: [],
              acsDelta: false,
            },
          },
          {
            ExercisedEvent: {
              offset: 125,
              nodeId: 2,
              contractId:
                "00f06333c12f87b2b48c6d765a055db6f4dea0b83b023ee9b8e39d5be583ed25ecca1212203064f09968a2ee61bc32e74558d8100df538c1f699bcabc7405e907f2d4b11b0",
              templateId:
                "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:CoreState",
              interfaceId: null,
              choice: "ChargeMessageFee",
              choiceArgument: {
                payer:
                  "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              },
              actingParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              consuming: false,
              witnessParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              lastDescendantNodeId: 2,
              exerciseResult:
                "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              packageName: "wormhole-core",
              implementedInterfaces: [],
              acsDelta: false,
            },
          },
          {
            CreatedEvent: {
              offset: 125,
              nodeId: 3,
              contractId:
                "00f73c0a9a4094f40aa49f4aa20d0f0964da46ffbeb1bc4a9e5be085560e4d591aca1212201916f120e9d598221e8f866abd2113d4e79c2f3e33916ef9eaa59ccdd0e2912d",
              templateId:
                "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371:Wormhole.Core.State:Emitter",
              contractKey: null,
              contractKeyHash: "",
              createArgument: {
                guardianGovernance:
                  "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
                owner:
                  "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
                emitterId: "0",
                emitterAddress: {
                  tag: "EmitterAddress",
                  value: "5b9007aa0d39a2ded1f3b91acadfd12a31846ddfa756db11c1db082ff55332ed",
                },
                sequence: "1",
              },
              createdEventBlob: "",
              interfaceViews: [],
              witnessParties: [
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              signatories: [
                "gg-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
                "publisher-mwv5zgpn::12207a561b17807b2f0f02b05e9d99c782998b015092bb1b2be904c73ac8e369d9d5",
              ],
              observers: [],
              createdAt: "2026-11-24T20:45:51.756158Z",
              packageName: "wormhole-core",
              representativePackageId:
                "32abbcd2a6b5ebc2530f8e2cfc3fd1b853ed496443c6a0125fd2cea617b33371",
              acsDelta: true,
            },
          },
        ],
        offset: 125,
        synchronizerId:
          "synchronizer-1::122092ad41a9bfc92ef8dd66ea810c0ed20bb7df431a6af80c0981da0dcc54e1bf0d",
        traceContext: {
          traceparent: "00-43ae29db2e1d14d3b8c50a3abe36a3fd-b09fb2760f9e9121-03",
          tracestate: null,
        },
        recordTime: "2026-11-24T20:45:51.770596Z",
        externalTransactionHash: null,
        paidTrafficCost: 0,
        transactionHash: null,
      },
    },
  },
};
