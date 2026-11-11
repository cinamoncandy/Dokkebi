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
| 1 | 실행 상태 기계의 나머지(6개)를 **함수마다** 선택: 조정기가 같은 순수 로직을 쓰게 합치거나(진짜 연결), 중복 모델이면 지운다. 가짜 호출처로 장부 숫자만 줄이지 않는다 | 6 (autonomousExecutionState 5 + executionCoordinator 1) | 함수별 설계 점검(아래 정정 참고) |
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

## 정정 (2026-11-11, 1단계 설계 점검 결과)
처음 표의 1단계는 "6개 함수에 호출처를 붙인다"로 읽히지만, 코드를 읽어 보니 그렇게 하면 안 된다.
- 실제 상태 기록은 Durable Object 조정기 `apps/autopilot/src/executionCoordinator.ts`(1777줄)다. 이미 중복 방지, 임대와 만료 복구, 보류 걸기·풀기(`/control-plane-hold/apply|clear`)를 가진다.
- `autonomousExecutionState.ts`의 연결 안 된 5개(`applyExecutionHold`, `clearExecutionHold`, `authorizeMergeReady`, `isDuplicateExecution`, `recoverExpiredLease`)는 같은 일을 메모리에서 하는 평행 모델이다. 보류 이유 같은 타입(`ExecutionHold`)은 조정기와 공유한다.
- `reconcileCodingExecutionEvidence`는 이미 `index.ts`와 `worker.ts`에서 실제로 쓰이며 영수증을 `PR_OPEN`/`IMPLEMENTATION_BLOCKED`로 판정한다. 코딩 실행기(`worker.ts`)는 이미 PR을 게시한다(L1 영수증의 EXECUTION_ACCEPTED).
- 따라서 1단계는 함수마다 (a) 조정기의 중복 로직을 이 순수 함수로 바꿔 한 곳으로 합치거나 (b) 쓰이지 않는 중복을 지우는 일이다. 어느 쪽이든 운영 조정기를 건드리므로 함수 하나씩, 조정기 시험을 유지한 채, 독립 검토를 받으며 한다. 이 문서는 어느 쪽도 정하지 않는다.

## 소유자 결정이 필요한 한 지점 (코드는 아직 바꾸지 않음)
실행 봉투(`productionExecutionSpine.ts`의 `prepareProductionExecution`)는 `mutationAllowed: false`로 고정돼 있고 허용 범위도 `apps/autopilot/`, `.github/workflows/`, `scripts/`(최대 12파일)로 좁다. "스스로 코드를 고친다"를 일반 개선까지 넓히려면 이 고정값을 풀어야 하는데, 이는 안전 불변식을 완화하는 일이다. 어느 단계에서도 이 값을 임의로 바꾸지 않고, 독립 Validator 검토와 소유자 승인을 거쳐 별도 PR로만 한다.

## 1단계 함수별 처분안 (읽기 전용 점검, 코드 변경 없음)
`executionCoordinator.ts`와 `autonomousExecutionState.ts`를 나란히 읽은 결과다. 처분은 제안이며, 실행 전에 함수마다 독립 검토를 받는다.

| 함수 | 조정기에서 대응하는 것 | 제안 처분 |
|---|---|---|
| `applyExecutionHold`, `clearExecutionHold` | `/control-plane-hold/apply`, `/clear`가 같은 검사(충돌, 차단 중, 낡은 해제)를 인라인으로 한다. 오류 이름만 다르다(`CONTROL_PLANE_HOLD_*` 대 `AUTONOMOUS_EXECUTION_HOLD_*`). | **합치기 후보.** 검사 부분을 공유 순수 함수로 빼고, 조정기는 지금의 오류 이름을 그대로 돌려주는 어댑터로 둔다. 위험은 중간(호출자가 오류 이름에 의존). |
| `recoverExpiredLease` | `acquire`가 만료된 `LEASED`를 인라인으로 다시 잡게 한다(`leaseExpiresAt > now`이면 `LEASE_ACTIVE`). | 합쳐서 얻는 것이 적다. **중복 모델 삭제 후보.** |
| `isDuplicateExecution` | 조정기는 `dedupeKey` 하나로만 중복을 판단한다. 이 함수의 "같은 `cycleId` + `workItemId`"는 조정기에 없다. | **연결하지 않는다.** `dedupeKey`에 실행 시도 번호가 들어 있어 재실행은 일부러 다른 키를 받는다(`prepareProductionExecution`의 주석: 첫 시도와 충돌하면 영구히 굶는다). 이 기준을 붙이면 재실행이 막힌다. 삭제하거나, 의미를 정한 뒤 다시 쓴다. |
| `authorizeMergeReady` | 조정기에 `AUDIT` 상태가 없다. 병합 준비는 브랜치 보호와 감사 워크플로가 강제한다. | **지금은 호출처가 없다.** 상태가 `AUDIT`에 닿는 경로가 생기기 전에는 연결할 수 없다. 삭제 후보 또는 5단계 이후. |
| `clearPersistentControlPlaneHold` | 서버 경로는 있고(`apply`는 `index.ts`에서, `read`는 `worker.ts`에서 쓰인다) 이 클라이언트 함수만 호출처가 없다. | 보류를 거는 원인이 풀렸을 때 풀어 주는 **실행 주체가 아직 없다.** 사람이 풀 때까지 보류를 유지하는 쪽이 안전할 수 있다. 소유자 결정 필요. |

결론: 6개 중 지금 안전하게 줄일 수 있는 것은 보류 걸기·풀기 한 쌍(합치기)과 삭제 후보 두 개(`recoverExpiredLease`, `isDuplicateExecution`)뿐이다. 나머지 둘은 호출처가 생길 때까지 장부에 남긴다. 장부 숫자를 줄이는 것이 목적이 아니다.
