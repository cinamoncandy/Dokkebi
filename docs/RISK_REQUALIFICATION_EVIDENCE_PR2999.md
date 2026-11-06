# RISK exact-source requalification evidence — PR #2999 (준비 중, 2026-11-05)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY, FAIL_CLOSED.

**상태: 증거 작성 단계. 이 문서는 pin 변경·병합·배포 승인이 아니고, 검증 통과 판정도 아니다.**
오너가 2026-11-05에 승인한 것은 "RISK exact-source formal requalification **착수**"뿐이다. pin(두 곳)은 이 PR에서 옮기지 않았다.

## 1. 대상
| 항목 | 값 |
|---|---|
| PR | #2999 (초안) |
| 승인서가 적은 HEAD | `05502724801e5f8c4bee0dcfebc443ec121fb671` |
| 독립 검증이 본 HEAD | `408a29d41ca0fe4ea420e30cdf2732e91c793616` (PASS_WITH_NOTES) |
| 핀 이동 준비 커밋 이후 | 새 SHA. 전체 필수 CI와 독립 검증을 그 SHA에서 다시 해야 한다 |
| 대상 모듈 | `apps/cloud/src/cloudPaperCanonicalRiskGateway.ts` (RISK canonical entrypoint) |
| 현재 pin (원본) | git blob `b43962beb41a193eda30c8dc717f2cbcc8971edd` |
| 이 PR의 커밋된 blob | git blob `2174d4e62e6a402cb239719e1a25126069cfaf36` |
| 소스 diff | 8줄 추가, 2줄 변경 (`ledgerRound8` 도입 + `realizedLossState`의 두 줄) |

pin이 걸린 곳은 두 곳이고 함께 움직여야 한다 (`WO-RISK-20261007-KST-TRADING-DAY`, 선례 커밋 `c942b4f46`):
1. `apps/cloud/src/cloudPaperCanonicalRiskGateway.requalification.test.ts`의 `EXPECTED_RISK_BLOB`
2. `apps/cloud/src/moduleQualificationV1.ts`의 `MODULE_QUALIFICATION_SOURCE_BLOB_BY_STAGE_V1.RISK` (검사: `module10XS.test.ts`)

현재 CI에서 실패하는 것은 위 1번 검사 하나뿐이다 (`binds evidence to the exact canonical RISK source blob`, 실제 `2174d4e6…` / 기대 `b43962be…`). 그 검사는 정확히 "소스가 바뀌었으니 다시 인정받아라"를 뜻하고, 지금은 의도대로 막고 있다.

## 2. 무엇이 바뀌는가 (원본 대비 의미론)
`realizedLossState`는 모든 체결을 처음부터 다시 돌려 "오늘 실현손익, 연속 손실, 오늘 완료된 매도"를 계산한다. 한 번이라도 매도가 직전 보유 수량을 `Number.EPSILON`보다 크게 넘으면 `dailyRealizedPnL = NaN`을 돌려주고, 그러면 `isStructurallyValid`가 요청을 `INVALID_REQUEST`로 거절한다.

| 항목 | 원본 | 변경 후 |
|---|---|---|
| 재생 중 수량 | 원시 부동소수점 합·차 | 매 단계 소수 8자리 반올림 (`Number(x.toFixed(8))`), 원장(`PaperTradingExecutionLoop`의 `round8`)과 같은 함수·같은 시점 |
| 초과 매도 판정 | `order.quantity > prior.quantity + Number.EPSILON` | 똑같다 (비교식 변경 없음) |
| 초과 매도 시 | `NaN` + `consecutiveLossCount = MAX_SAFE_INTEGER` | 똑같다 |
| 평균 진입가, PnL, 연속 손실, 일 경계(KST) | 원시 부동소수점 | 똑같다 (수량만 반올림) |
| 한도, 임계값, 자본, 다른 검사 | — | 바꾸지 않았다 |

핵심 논리: 원장은 수량을 8자리로 반올림해 보관하고, 원장 자신의 초과 매도 검사(`fillQuantity > previous.quantity + EPSILON`)도 반올림된 수량으로 한다. 재생이 원시 부동소수점으로 계산하면 같은 이력을 다른 수량으로 보게 되어 정상 이력을 초과 매도로 오판한다. 반올림을 원장과 같게 하면 두 계산이 같은 수량을 보므로 불일치가 사라진다. 비교식은 그대로라서 허용 오차가 커지지 않는다.

## 3. 검증 증거 (로컬, Node 22 샌드박스, `tests/cloud-paper-risk-replay-ledger-precision.test.js`)
같은 11개 테스트를 원본 소스와 변경 소스에서 돌렸다.

| # | 테스트 | 원본 | 변경 |
|---|---|---|---|
| 1 | 두 번에 나눠 판 마지막 조각이 이후 요청을 막지 않는다 (재현 사례) | **FAIL** | PASS |
| 2 | 큰 수량의 쪼갠 매도 300건 (결정적 표본) | **FAIL** | PASS |
| 3 | 진짜 초과 매도(+1e-6)는 여전히 `HALT` | PASS | PASS |
| 4 | 한 번에 전량 매도는 그대로 `ALLOW` | PASS | PASS |
| 5 | 원장과 일치하는 이력 1,200건(수량 규모 6단계)은 절대 `INVALID_REQUEST`가 아니다 | **FAIL** | PASS |
| 6 | 단조 안전: 진짜 초과 매도(+1e-8, 2e-8, 1e-6, 0.5, 600건)는 새 코드에서도 모두 `INVALID_REQUEST` | PASS | PASS |
| 7 | 경계: 보유 수량 = `ALLOW`, 보유 수량 + 1e-8(원장 한 단계) = `HALT` | PASS | PASS |
| 8 | NaN, 무한대, 음수 체결 수량은 `ALLOW`가 되지 않는다 | PASS | PASS |
| 9 | 중복 매도 체결은 초과 매도로 `ALLOW`가 아니다 (중복 매수는 원본과 같은 동작) | PASS | PASS |
| 10 | 순서가 뒤섞인 체결은 시각순으로 재생, 매수보다 앞선 매도는 `INVALID_REQUEST` | PASS | PASS |
| 11 | 재시작 복구: 같은 이력에 새 게이트 인스턴스를 만들어도 같은 결정 | PASS | PASS |

해석: 실패는 정확히 결함 사례(1, 2, 5) 세 개에서만 난다. 나머지 8개(fail-closed 의미)는 원본에서도 통과해서 **변경이 안전 쪽 의미를 약하게 하지 않았다**는 증거다. 5번의 표본에서 원본이 잘못 막은 이력이 실제로 있음을 테스트가 직접 확인한다.

함께 돌린 기존 테스트: 일 손실 연속(`cloud-paper-daily-loss-streak`), 라이브 상태 위험 게이트(`paper-risk-gate-live-state`), 취소 체결 위험(`cloud-paper-cancelled-fill-risk`), 위험 한도 스케일(`paper-risk-limit-scaling`), 프로덕션 E2E(`cloud-paper-production-e2e`), 위험 배선(`cloud-runtime-canonical-risk-wiring`).
- 개발 세션 로컬(소스 diff 직후): 위 4개 + 새 테스트 = 29/29 통과.
- **독립 VALIDATOR(세션 `NUSA_AGENT_ROLE=validator`, 대상 SHA `408a29d41ca0fe4ea420e30cdf2732e91c793616`, PR #2999 리뷰 댓글)**: 새 테스트 + 위 6개 = **42/42 통과**. 원본 소스에서는 새 테스트 11개 중 8 통과·3 실패(결함 사례 1, 2, 5). 자체 반례 4,500건에서 잘못 막은 것 0건(원본은 같은 방법으로 1,500건 중 840건), 진짜 초과 매도(+1e-8) 1,200건은 모두 여전히 `HALT`. 판정 **PASS_WITH_NOTES**, P0·P1 없음.
- 이 숫자들은 위 SHA 기준이다. 핀을 옮긴 최종 SHA에서는 전체 필수 CI(Node 24 포함)와 독립 검증을 다시 해야 한다.

## 4. 독립 검토 결과 (회수, 판정은 이 문서의 몫이 아님)
비작성자 세션의 `/grill-me` 검토(COMMENT, 승인 아님, 대상 `0550272`): **P0 없음, P1 없음, P2 2개**.
- P2-1 (경계 테스트): 이 문서의 테스트 7번이 +1e-8 경계를 추가해 처리했다.
- P2-2 (평균 진입가는 원시 부동소수점): 원본부터 있던 성질이고 `NaN`을 만들 수 없다. 손익이 약 1e-8 상대 오차로 흔들려 본전 매도의 부호가 뒤집힐 수 있는 정도다. 이 PR의 범위가 아니다. **미처리 잔여 위험으로 기록한다.**
- 같은 불일치가 있는 다른 곳 (이 PR은 고치지 않는다, 별도 작업): `paperTodayRealized.ts`(오늘 손익과 한도 도달 시각, 표시용: 쪼갠 매도 뒤에는 "알 수 없음"으로 보일 수 있음), `paperLossAttribution.ts`(NaN은 아니지만 정렬 규칙이 약간 다름).

## 5. 확인하지 못한 것 (잔여 위험)
- **서버의 실제 체결 기록을 읽지 못했다.** 원인은 증상(2026-11-04 16:05:18 KST의 쪼갠 매도 체결 2건 직후부터 7,379건 매수가 `INVALID_REQUEST`)과 실제 게이트 코드로 한 재현에서 세웠다. 릴리스 뒤 읽기 전용 확인으로 막힘이 사라지는지 보기 전에는 확정이 아니다.
- 서버 기록에서 `state.fills`가 잘렸거나 누락되었다면 이 수정과 무관하게 초과 매도 검사가 걸릴 수 있다.
- `check-runtime`, `validate:full`은 Node 24 전용이라 CI에 맡긴다. 새 SHA의 전체 필수 CI는 아직 돌지 않았다.
- 평균 진입가 부동소수점 잔여 위험(위 P2-2).

## 6. 남은 절차 (오너 지시의 순서)
1. [이 문서] 증거 작성 완료. **독립 VALIDATOR**가 새 SHA에서 소스 diff·테스트·이 문서의 주장을 다시 검증한다 (이 문서를 쓴 세션과 다른 세션).
2. 정식 검증이 **성공한 경우에만**, 지정된 절차로 pin 갱신을 검토한다. 선례와 같은 모양의 제안 (**적용하지 않았다**):
   - `EXPECTED_RISK_BLOB` 와 `MODULE_QUALIFICATION_SOURCE_BLOB_BY_STAGE_V1.RISK` 를 같은 커밋에서 함께 `2174d4e62e6a402cb239719e1a25126069cfaf36`(단, 최종 소스 blob이 달라지면 그 값)로 옮긴다.
   - 자격 상태(criteria status)는 바꾸지 않는다. Level-10 주장을 하지 않는다.
   - 소스 변경 커밋과 pin 이동 커밋을 분리한다 (pin은 "커밋된 소스의 blob"을 읽는다).
3. 변경된 SHA에서 전체 필수 CI와 독립 검증을 다시 수행한다.
4. Audit / Release 판단을 기다린다. 병합과 서버 릴리스는 그 뒤 오너 몫이다.

## 7. 지켜야 할 것
- 검증이 끝나기 전까지 서버의 기존 매수 차단을 우회하지 않는다 (설정·환경 변경, 체결 기록 수정·삭제, 한도 변경 모두 하지 않는다).
- 어떤 pin도 CI를 통과시키려고 옮기지 않는다.
