# 실거래 준비 격차 점검 (2026-10-31, 읽기 전용)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false. 이 문서는 점검 기록이며 어떤 권한도 만들지 않는다.
기준: `apps/cloud/src/liveReadinessGate.ts`의 12개 관문, `docs/LIVE_READINESS_RUNBOOK.md`.

## 결론
실거래는 열 수 없다. 코드 구멍보다 **증거가 아직 없는 것**이 막고 있다. 위험 한도·관문 기준·임계값은 이 점검에서 바꾸지 않았다.

## 관문별 상태
| 관문 | 상태 | 근거 |
|---|---|---|
| PAPER_AUTO_LEARNING_NOT_STABLE | 막힘 | 새 서버는 며칠분 데이터, 홀드아웃 통과 후보 0 |
| SHADOW_REPLAY_EVIDENCE_MISSING | 확인 못 함 | 시장 미세구조 SHADOW 로그는 있으나 실거래용 판단 경로 재현 증거 미확인 |
| REAL_ACCOUNT_READ_ONLY_UNHEALTHY | 확인 못 함 | 코드 있음, 새 서버 실제 상태 미확인 |
| GOVERNANCE_NOT_APPROVED | 미완료 | 자율개발 L1 PARTIAL (#1851 / PR #2961) |
| TRADE_PERMISSION / RISK_AUTHORITY | 확인 못 함 | 코드 있음, 실제 전략 통과 기록 없음 |
| 대사·킬스위치·멱등성·거래소 장애 테스트 | 확인 못 함 | 코드·테스트 있음, 서버 환경 통과 증거 미확인 |
| REQUIRED_CI_NOT_GREEN | 진행 중 | PR별 통과, 병합마다 재확인 필요 |
| WITHDRAWAL_OR_TRANSFER_PATH_PRESENT | 통과(설계) | 출금·이체 경로 없음 |
| 위험 한도 값 | 소유자 설정 | 형식 검사만 코드에 있음 |
| 환경·계좌 지문, 활성화 임대 | 소유자 몫 | 소유자 직접 생성 전에는 없는 게 정상 |

## 실제 문제
1. 전략 증거 부족: 홀드아웃을 통과한 후보가 없다.
2. 호가 연구는 INSUFFICIENT_DATA로 닫혔다 (커버리지 90% 미달). 호가 기반 전략은 근거가 없다.
3. 학습 사이클이 돌지 않는다. `candidateFunnel`(PR #2965) 배포 후 값으로 원인(데이터 부족/과적합)을 구분한다.

## 하지 않은 것
- 전략을 새로 만들지 않았다. 전략은 사전 등록 → 홀드아웃 연구 경로로만 나온다.
- 어떤 임계값·한도도 바꾸지 않았다.

## 다음
배포 후 진단으로 SHADOW·실계좌 읽기·안정성의 실제 값을 읽고 이 표의 "확인 못 함"을 채운다.
