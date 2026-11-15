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

## QIE Mainnet (chainId 1990)

Not deployed yet — Stage 5, after the security pass (DESIGN.md §7).
