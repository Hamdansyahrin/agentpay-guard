# Deployments

## QIE Testnet (chainId 1983) — Stage 2, 2026-11-15

Explorer: https://testnet.qie.digital
Deployer (dedicated throwaway testnet wallet): `0xc6d0342d070168c2e22a71ED522a9897C2092bA8`
Mock oracle price: $0.50 per QIE (the real QIE Oracle adapter is Stage 3).

| Contract | Address | Deploy tx |
|---|---|---|
| PaymentIntentRegistry | `0xe8Bc30b3edFa330Df5Cb727D5E6F431cB1932efc` | `0x5ff4a23ff7960b86d65db756f51ac6c7c839e938494379a53870566c1c64d0b7` |
| MockOracleCapAdapter | `0x13245B988d57824c123069bD306d18D7e30E7b52` | `0x847c3ad2dc41bf05c6ade04856749fb1dfeb9422aec524fa7ff81d48f0175a10` |
| AgentVault | `0x51089D7ad167Df432b4fEb55F7698D84454C90f9` | `0x1074c0c3cb1a4b7ae46a3c2d42bb078b046cb3b658e082660966825183a0244c` |

Wiring: `registry.setVault` `0xfc2d8a93410423e48698458e49fedc10855ee656477f76bbede26a5923d5ea4d`,
`registry.setRecorder(deployer)` `0xff3998a75f964893a5ec6c7a050b373f38f9271b5eabb5c41f53ee06541bf0db`.

### Live smoke flow (mandate #2)

Mandate: $5 per-tx cap / $12 daily cap, funded with 1.5 testnet QIE,
payee `0x3F95ac0D190060500347d9272264883DCE520a4d` registered as `smoke.qie`.

| Step | Tx |
|---|---|
| createMandate | `0x110dbac044e4f7f417c0f8709e5963658c2ebf457a715660e8eeda0c1107262d` |
| fund (1.5 QIE) | `0xc8ad74712ef92a4b883fee14c2d20585dd4fec193234502b3b33b41a39da5136` |
| addPayee | `0x27a3189022ba7247cdcf608a5ba0ee8595b7b7038963f08c23ccfa37c98c4482` |
| propose intent #1 | `0x992e31077c326dfdd086178fe23b0a2194f56a710a7bc87e94d4b67e7ea3b423` |
| execute 0.5 QIE → **Executed**, payee received 0.5 QIE | `0xb0a7efed33a44f37acec515ea96ed1d1683513d01be9834692ea96b5e64bb6da` |
| propose intent #2 | `0xc8fdf2e83de0226df55d01b2687335f73ab0b7efbebe05e7dd10c4899deda169` |
| attempt 11 QIE ($5.50) → **Refused, `OVER_TX_CAP` recorded on-chain** (tx mined, no revert) | `0xb64451e2ada9d5e194705df42b426e4fa7167743486aa3d4683f728cff1b407c` |

Full machine-readable record: `deployments/testnet.json`.
Reproduce: `python3 scripts/with_testnet_key.py npx hardhat run scripts/deploy.js --network qieTestnet`
then the same wrapper with `scripts/smoke.js`.

## QIE Testnet (chainId 1983) — Stage 3, 2026-11-15

### Real OracleCapAdapter

Points at the QIE Oracle QIE/USD feed `0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17`
(AggregatorV3, 8 decimals, "QIE / USDT" — verified live on **mainnet** by
read-only probe; the feed does not exist on testnet). Staleness bound 24h
(the mainnet QIE feed updates on a multi-hour cadence).

| Contract | Address | Deploy tx |
|---|---|---|
| OracleCapAdapter | `0xD66F7d954865BfBC3457CeD5FCD5270624157f21` | `0x10f498c56071bb8121f7e2e644f9c6c655a2bed40fd42aca826269ef47218c76` |

On testnet `isAvailable()` returns **false** — the adapter fails closed
because there is no feed to read. An earlier pre-fix deployment of the
adapter sits at `0x216b40c27537196a6d6641cAb68D9a32F56F9D2e` (superseded;
it lacked the code-size guard described in the contract).

### Fail-closed wiring check (mandate #3)

The vault was temporarily wired to the real adapter, one payment was
attempted, and the vault was restored to the mock adapter afterwards
(verified on-chain):

| Step | Tx |
|---|---|
| swap vault adapter → real adapter | `0xd9ea9fc52f77d8b44cf2516e2bafff446a103a2af5eb11c6c3ca0efd41934568` |
| fund mandate #3 (0.05 QIE) | `0x48d8a3184c8861af5b3673b6cef662b1a8158a4d49dfe542607643cb28fb1d3f` |
| propose intent #3 (0.01 QIE) | `0x7649a4271b2e3de8a32a33e65b6d5280b48cd9690a79e0aca59bb869281e07b9` |
| execute → **Refused, `ORACLE_UNAVAILABLE` recorded on-chain** | `0x522f1c21e442fee1930747551234551f0f6a56ea2716faeaebc96f36658327ba` |
| swap vault adapter → mock (restored) | `0xe99740d7a6f9d98f0f144c8ca514ed3198b26c35c8356d2f1a64f0626c9525db` |

### Agent demo run (mandate #4, via `npm run agent:demo`)

The agent tools (MCP-style server + CLI in `agent/`) drove this run against
the Stage 2 deployment (mock adapter, $0.50/QIE). The off-chain policy
engine's prediction matched the chain's verdict in both beats.

| Step | Tx |
|---|---|
| createMandate ($5 / $12 caps, 7d) | `0x05b4ee6acacd167422ee1dd393e526627372a87fe7cb3b7ada0c2a0afdf1493f` |
| fund (0.25 QIE) | `0xe2665b42a0ee627b10bc4d3bc11b902c97a6670a3993620763d1468dbf16030d` |
| addPayee `demo.qie` | `0x98fad9b2b815c91dea8da80c1fd4c46c537aefd7206d325ee5a3edefecc9cbda` |
| propose intent #4 (0.1 QIE) | `0xa2e2a1408a3351d57b8a0bfa95f4a46a82ee7af002b15da6f80ef45dd70ca1d9` |
| execute → **Executed**, payee received exactly 0.1 QIE | `0x883ee36d8cc7fa7e6a710374486adfadcd7ffd08cc3ea7ac7f794a4fecbd74ec` |
| propose intent #5 (11 QIE) | `0x2f26a1d4bdb4358cd46d8679f97a41b207e8552a3d8e7f3cbf910920d0d39c4a` |
| execute → **Refused, `OVER_TX_CAP` recorded on-chain** | `0xcc4899c039447f1b35007fb5fe0c0725af7aa1ea5c03f2253b574fd4d0160ca0` |

Reproduce the wiring check:
`python3 scripts/with_testnet_key.py npm run deploy:adapter:testnet`
(it re-deploys a fresh adapter). Reproduce the demo: `npm run agent:demo`.

## QIE Mainnet (chainId 1990)

Not deployed yet — Stage 5, after the security pass (DESIGN.md §7).
