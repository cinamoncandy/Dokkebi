# 누사포지: 스스로 코드를 고쳐 운영에 반영하는 단계까지의 길 (2026-11-11)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY. 이 문서는 어떤 동작도 바꾸지 않는다.
모든 병합은 지금처럼 Audit와 Release 경로(브랜치 보호, CI, nusa-release-authority App)로만 한다. 이 길의 어느 단계도 그 경로를 우회하거나 한도, 위험, 자본, 권한을 바꾸지 않는다.

## 출발점 (2026-11-11 확인)
- L1 검증 증거는 통과·수락됐다 (9번째 시도, 소유자 수락, 독립 검토 수락). 통제된 시험 한 번이며 운영 사용은 아니다.
- `productionExecutionSpine.ts`(140줄)는 상태를 `CODING_DISPATCHED`까지만 올린다. 그 뒤 상태는 한 번도 들어가지 않는다.
- `apps/autopilot/src/unwiredControlPlaneDebt.ts`의 연결 안 된 함수는 33개다. 이 장부는 "늘면 실패, 연결하고 안 지워도 실패"라서 줄이는 diff가 곧 작업 기록이다.

## 33개를 일의 순서로 묶으면
| 단계 | 내용 | 장부 항목 수 | 선행 조건 |
|---|---|---|---|
| 1 | 실행 상태 기계의 나머지: 보류 걸기·풀기, 병합 준비 승인, 중복 판정, 만료 임대 복구, 제어 평면 보류 해제 | 6 (autonomousExecutionState 5 + executionCoordinator 1) | 2단계의 실행 결과 흐름 |
| 2 | 작업자 실행기(#2117): 작업 입장·임대·시작·완료·갱신, 처리량 평가 | 6 (worktreeWorkerPool 5 + workerThroughputEvidence 1) | 격리된 샌드박스(L1에서 검증됨) 위에서만, 처음엔 부수 효과 없이 |
| 3 | 무엇을 고칠지 정하기: 기회 계획·순위, 진화 선택·순위·검증·승급·차단기 | 14 (opportunityPlanner 2 + evolve* 12) | 1~2단계 |
| 4 | 외부 호출 보호와 되먹임: 공급자 백프레셔, 결과 평가, 소유자 이슈 초안 | 7 (providerBackpressure 5 + outcomeFeedback 1 + referenceIntelligenceIssueHandoff 1) | 2단계 |
| 5 | 진짜 실패 하나로 처음부터 끝까지 한 번: PR 생성, CI, 감사, 병합 준비 | 0 (증거) | 1~4단계, 소유자가 시험 방식 선택(FORGE_STATUS_20261103.md의 A/B) |
| 6 | L2 보류 해제 여부 | 0 (결정) | 5단계 증거, 소유자 결정 |

## 지키는 규칙
- 한 단계는 한 브랜치와 한 PR. 장부를 줄이는 diff가 기록이다. 코드와 워크플로 PR은 비작성자 검토 전까지 초안.
- 연결할 호출처가 정직하지 않으면 연결하지 않는다 (가짜 측정값, 가짜 증거로 채우지 않는다).
- 자율 수정은 PR을 만드는 데서 끝난다. 병합과 배포는 사람이 정한 Audit와 Release 경로가 한다. 제가(작성자) 병합하지 않는다.
- 5단계의 시험은 main을 일부러 빨갛게 만들 수 있으므로 거버넌스를 거치고, 소유자가 방식을 고른다.

## 하지 않는 것
- 안전 플래그, 한도, 임계값, 위험, 자본을 바꾸지 않는다.
- 단계를 건너뛰어 한꺼번에 33개를 연결하지 않는다 (장부 머리말이 "옳아 보이지만 잘못된 방법"이라고 적고 있다).

## 확인하지 못한 것
- #2117, #1851 이슈의 현재 상태와 담당 (이 환경에서 GitHub 이슈 조회가 막혀 있다). 구현 담당 조율이 필요하다.
- 33개 각각의 호출처 설계는 읽지 않았다. 1단계 PR 때 항목별로 읽는다.

## 이 문서 다음 작업
1. 1단계의 설계 점검: `autonomousExecutionState.ts`의 5개가 어떤 호출처에서 정직하게 쓰이는지, 지금 실행 척추 뒤에 붙일 수 있는 최소 지점이 있는지.
2. 없다면 2단계(실행기)의 가장 작은 조각부터: 부수 효과 없는 `createWorkerPoolState` 호출처.
