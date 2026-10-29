# Export portal fixtures

Recorded replies of the real Sources API routes (`/api/v1`), parsed by
`tests/unit/export-portal-fixtures.test.ts` against `src/domain/export-portal/contract.ts`.

Source of truth: `t4a-partner-portal-api`, `docs/fixtures/sources-api/` (recorded by
`scripts/sources-api-smoke.js --record` and `scripts/sources-api-ai-smoke.js --record`; Shopify, MetaKocka
and the model stubbed; ids and timestamps anonymised). Copy by hand, byte for byte, never edit here. The
test fails when a file's sha256 below differs from the file, so a refreshed copy needs its line updated
(`sha256sum *.json`).

`source.json` was recorded with the portal's return URL unset, so it has no `portalUrl`.

998422c6d410d7d135e5f145db78824d04af772a9d4dc8308721bd902f848b6b  ai-categorize.json
fd06c8259df3adeb3980f68bd0384a208a91ee68eb6b10067944b94260a440bd  ai-extract-attributes.json
22a999eeb6e6c1c51ca57b8646803e5f331caa0254b6a0c6477af3a77f07ad54  connection.json
4a507bfc2c45802b480fe3308f03ff6bc7207827c2e043b79241f95b5153543e  error-401.json
1dfaddbe705d87423c56dec20737a911a2c7fd8258471dadce619b0000645634  error-403.json
aeda98cfef1e5eb45562735839ec41ed042c0f047634ca195ea8c48ad93325b1  error-404.json
ba579be0a1040dbebbe57718824d9621e65239f016e9434f5ed06044d4d696d8  error-409.json
e77b8f9aab62fc555ab731f39751ce7daa067024a918f7ff8d5352035754710e  error-422.json
8b8e666fb4721e4098d0fb5b84cd6304a586ce1fe7a5e13bd800f4d1b97f5b4b  error-502.json
131ff0794f3fedab99f6bc854899cb21fd302839a5822bb7ac8193fdfc124ffc  error-503.json
d5ddab2ae7f150a13518f3132869c4e178d6795e8f1b582dc10920fa1c01bd10  run-detail-failed.json
b77758da316103397ab67f77f38439527412d7750317aa5ae5e80755fb7c9bba  run-detail.json
64f0310cd34ef41e5d8b9a367f187e104c4bdbf8b70e64b74cbe4b00d1ff2b02  runs.json
6541b8e468e905b24fcbf99a9302dba550cf5f805f4680765677ac2aa0259beb  run-started.json
f513054ef496445443abc22128a68bb8dbe5169e486827db9f292ec16adb5cfe  source.json
3762992a200a213e62580a6aa216e84ce49436e346a0ece7e070ef9242c7b537  sources.json
84126b4897587b9e6b9d2ea70fb9b57239015b9907a5a4119d588a25d933f3b8  source-types.json
