# 누사포지(자율개발) 현재 상태와 다음 순서 (읽기 전용 정리, 2026-11-03)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY. 이 문서는 어떤 동작도 바꾸지 않는다. 확인한 것만 적고, 확인하지 못한 것은 따로 적는다.

## 한 줄 결론
자율개발 흐름은 "행복한 경로"만 연결되어 있고 대부분의 안전장치와 상태 기계는 아직 연결되어 있지 않다. L1(워크플로 실패를 믿을 수 있는 증거로 분류해서 코딩을 시작하는 경로)의 마지막 고리는 아직 코드가 없다. 그래서 지금 필요한 건 시험용 회귀를 넣는 일이 아니라 그 고리를 먼저 만드는 일이다.

## 확인한 것 (코드)
1. **#2961(Gate A)은 main에 들어갔다.** 워크플로 실패로 코딩을 시작하려는 요청은 예약 승인과 `/coding/execute|propose|publish`에서 모두 거절된다. 보호된 main의 CI에서 `causal-regression-contract`가 push마다 돌고 `MATCH`로 끝난다 (`e1fd3ea93`, `dc9e47585` 두 번 확인). 증명서를 만드는 `attest-causal-regression`은 불일치가 있을 때만 돌아서 지금까지 건너뛰었다.
2. **`CODE_ACTIONABLE`과 `REPOSITORY_CODE_REGRESSION`을 만들어 내는 코드가 저장소에 없다.** 두 이름은 주석과 문서에만 나온다 (`sigstoreCausalAttestation.ts`: "this is not a causal receipt, … or CODE_ACTIONABLE", `unwiredControlPlaneDebt.ts`). Sigstore 검증, 출처 실행 확인, 한 번만 쓸 수 있는 클레임까지는 있고, 그것들을 하나로 묶어 분류를 내리는 인과 검증기와 승인(`admission`)은 없다.
3. **연결 안 된 제어 평면 함수가 35개다** (`apps/autopilot/src/unwiredControlPlaneDebt.ts`, 19개 파일). 저장소가 스스로 "숫자가 늘지 않게 막는 장부"로 관리한다. 예: 실행 상태 기계의 보류·복구·중복 판정·병합 준비 승인 5개, 작업자 풀 5개, 공급자 역압 5개, 인과 클레임의 `dispatchWithCausalBinding`·`verifyClaimedCausalDispatch` 2개.
4. **실행 척추(`productionExecutionSpine.ts`, 140줄)는 상태를 `CODING_DISPATCHED`까지만 올리고 끝난다.** 그 뒤 상태는 들어가지 않는다. 장부의 설명은 "연결된 것은 행복한 경로이고, 연결 안 된 것은 모든 안전장치"다. 병합 보류·감사·릴리스는 이 모듈이 아니라 브랜치 보호, CI 워크플로, 릴리스 권한 앱이 강제한다고 적혀 있다.

## 지금 막힌 곳
- 양의 경로(증명서가 진짜면 `CODE_ACTIONABLE`) 검증은 **실제 보호된 main에서 계약이 어긋날 때만 증명서가 생긴다**. 지금은 일치(`MATCH`)라서 만들어질 일이 없다.
- 그 증명서를 받아 분류와 승인으로 바꾸는 코드가 아직 없으므로, 증명서가 생겨도 닫힌 채로 남는다. 장부도 "진짜 생산자의 양의 사례가 생기기 전에는 연결하지 않는다"고 적고 있다.

## 순서 (제안)
1. 인과 검증기를 설계한다: 암호 검증 + 출처·게시자 실행 + 산출물 + 재사용 방지 + 계약 지문이 모두 통과하고 분류가 정확히 `REPOSITORY_CODE_REGRESSION`일 때만 `CODE_ACTIONABLE`. 하나라도 불가·불일치면 거절. 새 제어 평면을 만들지 않고 기존 CodingRunner·대기열을 쓴다.
2. 가짜가 아닌 증명서를 만드는 방법을 소유자가 정한다 (아래 선택지). 시험용 회귀는 main을 일부러 빨갛게 만들기 때문에 거버넌스를 거친다.
3. 연결 안 된 35개 중 `CODE_ACTIONABLE` 경로에 필요한 것(`dispatchWithCausalBinding`, `verifyClaimedCausalDispatch`)만 그 뒤에 연결한다. 나머지는 장부에서 줄이는 diff가 곧 기록이다.

## 선택지 (소유자 결정)
- A. 진짜 회귀가 생길 때까지 기다린다. 가장 안전하나 기간을 모른다.
- B. 통제된 시험용 회귀를 거버넌스(독립 검토, 감사, 릴리스)를 거쳐 main에 한 번 넣고 바로 되돌린다. 그 사이 main CI가 빨갛다. 이 기간 동안 자율개발이 그 실패를 실제로 고치려 들 수 있어서, 그 동작을 허용하는지도 같이 정해야 한다.
- C. 지금 상태(L1 PARTIAL, L2 HOLD)를 유지한다.

## 조율 필요
이 작업(#1851)은 이미 ChatGPT가 구현을 맡은 정본 작업이다. 새로 만들거나 제3의 구현을 두지 않는다. 검증기 설계서를 쓰더라도 기존 이슈·인계 기록에 붙이고, 구현 담당을 먼저 정한다.

## 확인하지 못한 것
- 35개 장부 항목 각각이 왜 연결되지 않았는지(소유 이슈 #2117 등)는 주석 요약만 읽었다.
- 진짜 보호된 main에서 `attest-causal-regression`이 한 번이라도 돈 적이 있는지는 마지막 두 push만 봤다.
- 인과 검증기의 사전 설계가 #1851 인계 기록 안에 따로 있는지는 읽지 않았다.

## 2026-11-06 갱신 (KST, main `ecdf774`, 코드 읽기만 한 결과)
위 2번("`CODE_ACTIONABLE`을 만들어 내는 코드가 없다")은 더 이상 맞지 않는다. #2992와 #2994가 병합되어 main에 다음이 있다.
- `causalRegressionAdmission.ts`: 인과 승인 영수증을 만들고 구조·유효성을 검사한다(`createCausalAdmissionReceipt`, `isValidCausalAdmissionReceipt`). 격리 검증 판정(`classifyIsolatedCausalVerification`)과 고정된 생산자 지문도 있다.
- `causalDispatchBinding.ts`: 디스패치에 인과 바인딩을 붙이고(`dispatchWithCausalBinding`), 일회용 클레임과 검증(`claimVerifiedCausalDispatch`, `verifyClaimedCausalDispatch`)을 한다.
- `causalAdmissionAuthorization.ts`, `causalProposalReceipt.ts`, `causalRepairPatch.ts`: 승인, 제안 영수증, 수리 대상 한 파일로 제한된 패치.
- 격리 검증 경로(`causal-verification*.yml`)는 증명 체인을 점검하는 장치이고 **양성 증명으로 세지 않는다**. 이 경로는 `NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED=true`일 때만 열린다.

**여전히 확인되지 않은 것 (L1 PARTIAL 유지):** 실제 보호된 main에서 어긋난 계약이 만든 진짜 증명서, 그것을 소비 검증기가 받아 `CODE_ACTIONABLE`로 승인하는 운영 환경 증거, 그리고 양성 CodingRunner 종단 동작. 이는 카나리(`FORGE_CANARY_PREPARATION_20261104.md`)로만 확인할 수 있고, 카나리는 승인·실행되지 않았다. L2는 HOLD다.

이 갱신은 코드를 읽어 이름과 역할을 적은 것이며, 동작을 실행해서 확인한 것이 아니다.
