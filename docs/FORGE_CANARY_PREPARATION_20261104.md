# 누사포지 통제된 PAPER 카나리 준비서 (실행하지 않음, 2026-11-04)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY, FAIL_CLOSED.
이 문서는 준비서다. 카나리를 **실행하지 않고**, 어떤 동작도 바꾸지 않는다. 실행은 아래 "실행 전 승인 조건"이 모두 충족된 뒤 오너가 따로 승인한다.
이 작업은 정본 이슈 #1851(ChatGPT 구현)에 붙는 준비 기록이다. 새 구현을 만들지 않고, 기존 `docs/FORGE_STATUS_20261103.md`의 선택지 B를 구체화한다.

## 오너 결정 (2026-11-04)
세 선택지(기다림 / 통제된 시험용 회귀 / 현 상태 유지) 중 **통제된 PAPER 카나리 준비**를 선택했다. 실제 실행은 별도 안전 검증 후 승인한다. 카나리는 PAPER_ONLY, 격리 환경, 제한된 자원, 명시적 중단 조건, 기존 Risk·Security 게이트 유지가 필수다. 합성 증거를 실제 양성 증명으로 쓰지 않는다. 진짜 Sigstore와 실제 source identity를 확인할 수 있어야 한다. 카나리 결과가 없으면 양성 증명은 **미검증**으로 둔다.

## 무엇이 "진짜 양성 증명"인가 (코드로 확인한 것)
- `.github/workflows/ci.yml`의 `causal-regression-contract`는 보호된 `main`의 `push`에서만 돈다. `scripts/causal-regression-observe.js`가 실제 구현(`apps/autopilot/src/repairableWorkflowRun.ts`)을 계약(`apps/autopilot/src/causalRegressionContract.ts`, `REPAIRABLE_WORKFLOW_POLICY_V1`)과 비교해 `MATCH` 또는 `OBSERVED_MISMATCH`를 낸다.
- `attest-causal-regression`은 같은 실행에서 `OBSERVED_MISMATCH`일 때만 돌고, 정확한 source identity(저장소·`GITHUB_SHA`·run id·attempt·`workflow_ref`·`refs/heads/main`·job 이름)를 검증한 뒤 Sigstore 증명서를 낸다.
- 지금은 구현이 계약과 일치(`MATCH`)해서 증명서가 만들어지지 않는다. 그래서 양성 경로는 한 번도 검증되지 않았다.
- #2994의 격리 하네스(`causal-verification*.yml`)는 실행 중에 만든 시험용 복사본의 불일치를 증명한다. 증명 체인을 점검하는 데는 쓸모가 있지만, 실제 저장소 회귀가 아니므로 **양성 증명으로 세지 않는다** (같은 문장이 #2994 검토 댓글에 있다).

## 격리 저장소는 안 된다
다른 저장소나 포크의 `main`에서 만든 증명서는 source identity가 `cinamoncandy/NUSA`가 아니므로 검증기가 거부한다. 요건("실제 source identity")을 채우지 못한다. 그래서 카나리는 이 저장소의 보호된 `main`에서 한 번 일어나야 하고, "격리"는 **저장소가 아니라 영향 범위**(PAPER 전용, 서버·Oracle·비밀 값 접근 없음, 한 번만, 짧은 시간)로 확보한다.

## 카나리 설계 (제안)
1. **무엇을 어긋나게 하나: 좁히기만 허용한다.** 계약 쪽은 두고, 구현 `repairableWorkflowRun.ts`의 정책 값 하나를 계약과 다르게 바꾼 커밋 `C`를 main에 한 번 넣는다. 변경은 **자율개발이 복구 대상으로 보는 범위를 좁히는 방향만** 허용한다. 예: `REPAIRABLE_CONCLUSIONS`에서 `timed_out`을 뺀다(계약 사례 `main-ci-timeout`이 `true`를 기대하므로 `OBSERVED_MISMATCH`가 난다). 좁히기만 하므로 자율개발에 새 권한을 주지 않는다.
   **금지:** `REPAIRABLE_WORKFLOW_NAMES`에 항목을 **추가**하는 것(예: Audit·Release 워크플로)은 하지 않는다. 범위를 넓혀 빨간 main에서 자율개발이 그 워크플로를 복구 대상으로 집을 수 있고, `repairableWorkflowRun.ts` 머리말의 2026-10-12 사고(한 실패가 11번 재배정됨)를 되풀이할 수 있다.
   변경 이유와 되돌릴 커밋 `R`을 같은 PR 본문에 적는다.
2. **미리 만들어 둘 것.** `R`(되돌리기)을 `C`와 같은 PR 시점에 만들어 두고 병합하지 않은 채 대기시킨다. 되돌리기가 준비되지 않았으면 `C`는 병합하지 않는다.
3. **main CI가 빨개지는 것은 확정이다.** `scripts/causal-regression-observe.js`가 `OBSERVED_MISMATCH`이면 종료 코드 1로 끝나서 `causal-regression-contract` 작업, 그리고 그것을 포함한 `CI`가 다른 테스트와 무관하게 빨개진다. 덧붙여 `repairableWorkflowRun.test.ts`, `causalRegressionContract.test.ts`, `tests/causal-regression-observe.test.js`도 실패할 가능성이 크다. 이 구간을 숨기거나 테스트를 고치거나 끄지 않는다. 구간의 상한을 정해 두고(아래 중단 조건), 그 안에 `R`을 병합한다.
   **구간 동안 다른 병합을 얼린다.** `attest-causal-regression`은 불일치가 남아 있는 동안 main으로 들어오는 모든 push마다 새 증명서를 만든다. `C`와 `R` 사이에 다른 PR을 main에 병합하지 않는다. PR의 필수 검사와 병합 대기열이 영향을 받는지는 확인하지 못했다.
4. **증명서가 나오면.** `attest-causal-regression`이 낸 증명서와 같은 실행의 receipt를 보존한다(삭제하지 않는다). 두 산출물의 보존 기간은 `retention-days: 7`이라 그 뒤에는 사라진다. 그래서 **창 안에** `receipt.json`과 `attestation.json`을 내려받아 해시를 계산해 결과 기록에 적는다. 소비 쪽 검증기(#2994)는 이 창 안에서 돌려야 하고, 그때까지 main에 병합되어 있어야 한다. 소비 쪽 검증기(#1851/#2994에서 구현 중)가 증명서를 받아 암호 검증, 출처·게시자 실행, 산출물, 재사용 방지, 계약 지문을 모두 통과시키는지 본다.
5. **자율개발은 닫힌 채로.** 카나리 동안 `CODE_ACTIONABLE`을 받아 코딩을 시작하는 경로는 열지 않는다. 증명서의 검증과 분류까지만 확인하고, 코딩 실행·게시·병합은 계속 거절 상태(Gate A, #2961)다. 이 확인에는 코딩 실행이 필요 없다.

## 필수 조건 (카나리 기간 내내)
- PAPER_ONLY / ZERO_AUTHORITY / FAIL_CLOSED 유지. LIVE 활성화, 운영 서버 변경, 비밀 값 사용 없음.
- 한 번만 한다. **같은 실행의 작업 재실행(re-run)도 금지**한다(`run_attempt`가 바뀌면 다른 산출물과 다른 증명서가 생긴다). 검증기의 "한 번만 소비" 주장은 카나리가 쓰고 나면 다시 쓸 수 없다. 증명서 보존 기간은 기존 설정(7일)을 유지한다.
- **자율개발이 그 빨간 main을 집지 않는지 먼저 확인한다.** 빨간 main `CI`는 `isRepairableMainWorkflowFailure`가 고르는 형태(이름 `CI`, 결론 실패, `main`, `push`)와 정확히 같다. `scheduledRuntime`, `dispatchPlanner`, `autopilot-dispatch-retry.js`가 이를 소비한다. 문서가 기대는 Gate A(#2961)는 거절 장치일 뿐 예방 장치가 아니다. 창을 열기 전에 이 실행 모양에 대한 Gate A 거절과 재배정 재시도 동작을 확인하고, 창 동안 지켜볼 담당자를 이름으로 정한다. 확인을 위해 Autopilot의 게이트를 바꾸지 않는다.
- 기존 Risk·Security 게이트와 필수 승인 절차 유지. 게이트 약화·테스트 비활성화·핀 값 수정 없음.
- 합성 증거 금지: 시험 데이터를 만들어 붙이지 않는다. 증명서는 실제 CI 실행에서 나온 것만 쓴다.
- 독립(비작성자) 검토, Audit, Release 게이트를 통과한 뒤에만 `C`를 병합한다.

## 명시적 중단 조건 (하나라도 해당하면 즉시 `R` 병합 후 중단)
1. main CI가 빨간 구간이 정한 상한(제안: 병합 후 60분)을 넘길 때.
2. `C`와 무관한 검사(보안 게이트, 다른 테스트, 서버 배포 관련)가 실패할 때.
3. `OBSERVED_MISMATCH`가 아니거나, **카나리 커밋 `C`의 실행에서** 증명서가 두 번 이상 만들어질 때(예상 밖 동작). 다른 병합 때문에 생기는 증명서는 위 병합 동결로 막는다.
4. 증명서의 source identity가 기대와 하나라도 다를 때.
5. 자율개발이 올린 **초안이 아닌** PR이 생기거나, 그 PR이 자동으로 감사·병합 경로에 들어서려는 징후가 보일 때. (초안 PR 한 건 자체는 예상된 양성 경로 증거이며 중단 사유가 아니다. 위 "승인 이후 경로" 참조.)
6. 다른 개발자의 PR이 이 빨간 main 때문에 막힐 때(오너 판단으로 연장 가능).

## C와 R 준비 결과 (2026-11-06, 병합·실행 안 함, 로컬 검증)
기준: main `185c52c22`. 대상 파일 `apps/autopilot/src/repairableWorkflowRun.ts`의 원본 git blob `865c7fb4f3a3669511acae08135853337545d70f`.

**`C` (한 줄, 복구 대상 범위를 좁히기만 한다):**
```diff
-const REPAIRABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);
+const REPAIRABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure"]);
```
- 깨끗하게 적용된다(`git apply --check`). `C`를 적용한 blob은 `c7fa7a8ded991b7d7d9e431adbe73ee6712ab2e0`.
- 이 변경은 어떤 입력도 새로 복구 대상으로 만들지 않는다(`timed_out`을 제외할 뿐). 자율개발의 권한을 넓히지 않는다.

**`R` (되돌리기):** `C`의 역적용(`git apply -R`, 병합 뒤에는 `git revert`)이 blob을 `865c7fb4f3a3669511acae08135853337545d70f`로 정확히 되돌린다. 원본과 비트 단위로 같음을 확인했다.

**불일치 관찰:** `C`를 적용하고 `observeRepairableWorkflowContract(isRepairableMainWorkflowFailure)`를 실행하면 `OBSERVED_MISMATCH`, 사례 `main-ci-timeout`(기대 `true`, 실제 `false`)이다. 이 확인은 함수만 돌린 것이고 영수증이나 GitHub 신원은 만들지 않았다. 실제 영수증은 보호된 main의 `push`에서만 만들어진다.

**함께 실패하는 기존 테스트 (자율개발 전체 + 인과·자율개발 계열 957개 중 정확히 3개):**
1. `the current repository predicate satisfies the fixed observation contract`
2. `canonical code checks that failed on main are repair targets`
3. `producer observes the actual predicate and binds fixed contract fingerprints`
이 테스트들은 고치거나 끄지 않는다. 빨간 main은 의도된 것이고 `R`로 사라진다.

**주의:** 이 값들은 main `185c52c22` 기준이다. `repairableWorkflowRun.ts`가 그 사이 바뀌면 blob 값과 패치를 다시 만들어 다시 검토해야 한다. 이 준비는 **실행 승인이 아니다**(위 "실행 전 승인 조건" 3~5번과 #2994 병합이 남아 있다).

## 판정
- **성공:** 같은 실행의 증명서 + 독립 검증기가 모든 항목을 통과하고, 분류가 정확히 `REPOSITORY_CODE_REGRESSION`이며, 되돌린 뒤 main CI가 다시 초록.
- **실패 또는 중단:** 양성 증명은 **미검증**으로 남긴다. 실패 원인과 보존한 로그를 기록한다.
- 결과 기록이 없으면 양성 증명은 미검증이다.

## 실행 전 승인 조건 (모두 아직 충족되지 않음)
1. #2994(또는 후속)가 병합되어 소비 쪽 검증기가 main에 있다. **현재 미충족:** 초안이고 main보다 뒤처져 있으며, 열린 P2 리뷰 스레드 2건(`PRRT_kwDOTUbne86y_bHe`, `PRRT_kwDOTUbne86y_bHi`)의 공식 처리가 남아 있고, 적격 비작성자 검토자가 없어 `BLOCKED_VALIDATOR_INDEPENDENCE` 상태다.
2. `R`이 준비되어 있고 `C`와 같은 시점에 검토되었다. **현재 부분 충족:** `C`와 `R`을 준비하고 로컬에서 검증했다(아래 "C와 R 준비 결과"). 아직 **독립 검토를 받지 않았고**, 병합하지 않은 패치 상태다.
3. 빨간 main에서 Gate A 거절과 재배정 재시도 동작을 확인했고, 창 동안 지켜볼 담당자가 이름으로 정해졌다. **현재 부분 충족:**
   - **코드 수준 확인됨 (2026-11-05, main `185c52c22`, 읽기 전용):** 빨간 main `CI`(이름 `CI`, 실패, `main`, `push`)는 `scheduledRuntime.ts`가 복구 대상으로 집지만, 그 뒤 세 겹이 막는다.
     (1) 스케줄러: `scheduledEvolutionCoding.ts`가 실패 신호가 있는 `REPOSITORY_AUTOPILOT` 요청을 `workflow-failure-causal-evidence-unverified`로 **중단(ABSTAINED)** 한다. 임대 획득과 코딩 배정 **이전**이다.
     (2) 워커: `worker.ts`의 코딩 라우트는 워크플로 실패 사유(`isWorkflowFailureCodingReason`)에 인과 승인이 없으면 `409 CAUSAL_ACTIONABILITY_UNVERIFIED`로 거절한다.
     (3) 러너: `codingRunner.ts`가 인과 출처 신원이 맞지 않으면 `CODING_RUNNER_CAUSAL_SOURCE_IDENTITY_INVALID`로 거절한다. 재시도 스크립트(`autopilot-dispatch-retry.js`)는 `CODING_PROPOSAL_FAILED_CLOSED`를 재시도하지 않는 "조치 없음" 코드로 다루고 시도 횟수는 실행당 3회로 제한된다.
   - 이를 보호하는 테스트 130개가 통과했다(`causalAdmissionAuthorization`, `worker`, `scheduledEvolutionCoding`, `scheduledRuntime.failureRouting`, `codingRunner`, `repairableWorkflowRun`; main `185c52c22`를 빌드해 실행).
   - **아직 미충족:** 실제 빨간 main에서의 **라이브 동작 확인**과, 창 동안 지켜볼 **담당자의 이름 지정**. 확인을 위해 Autopilot 게이트를 바꾸지 않는다. 카나리가 만든 진짜 증명서를 소비 검증기가 받아 승인하는 경로(#2994)가 열리면 그 승인은 그 정확한 실패 실행에 대한 것이므로, 창 동안 `CODE_ACTIONABLE` 소비를 막는 중단 조건 5번이 계속 유효하다.
4. 이 준비서에 대한 독립 검토가 끝났다. (2026-11-04 비작성자 검토 완료, P1 2건을 이 개정에서 반영함.)
5. 오너가 날짜와 시간대(한국시간), 중단 상한을 정해 명시적으로 승인했다. **현재 부분 충족:** 60분 **중단 책임자는 오너 본인**으로 정해졌다(2026-11-06). 감시 담당은 Claude(읽기 전용: 창 동안 main CI, 증명서 생성 횟수, 자율개발 동작을 점검하고 중단 조건이 보이면 알리는 것까지만 한다. `R` 병합·승인·게이트 변경은 하지 않는다). **날짜·시간대·중단 상한은 아직 미정**이다.

## 코딩 보류 장치 조사 (2026-11-06, 읽기 전용, main `185c52c22`)
독립 검토(PR #2998)가 "빨간 main 동안 코딩을 막는 **구체적 장치**를 창 전에 확인하라"고 지적했다(P1). 조사 결과:
- **전용 "자율개발 일시정지" 스위치는 코드에 없다.** `wrangler.jsonc`의 `NUSA_AUTOPILOT_ZERO_CREDIT_MODE=true`는 유료 추론만 막고 코딩 자체를 막지 않는다.
- **`NUSA_GLOBAL_RELEASE_FREEZE`는 보류 장치로 쓰면 안 된다.** 켜면 `worker.ts`가 **Audit와 Release를 모두 거절**(`GLOBAL_RELEASE_FREEZE_ACTIVE`)하므로 `R`을 봇으로 병합하는 길까지 막힌다.
- **PR 단위 보류(HOLD 라벨, 초안)는 PR 실행용이다.** main의 실패 실행에는 적용되지 않는다.
- 현재 main에서 빨간 main `CI`를 막는 것은 위 "필수 조건"에 적은 **구조적 3겹**(스케줄러 중단, 워커 409, 러너 신원 거절)이다. 이는 인과 승인이 **없을 때** 막는 장치다.
- **승인 이후 경로 (2026-11-06 코드로 확정, main `185c52c22`):** `autopilot-github-event-bridge.yml`이 빨간 main `CI`(push, main)에서 같은 실행의 증명서를 `dispatch-github-event-to-autopilot.mjs`로 웹훅 본문(`nusa_causal_attestation_bundle`)에 실어 보낸다. #2994의 소비 검증기가 main에 있으면 진짜 증명서로 승인이 열릴 수 있다. 그 뒤 `worker.ts`의 `/coding/propose`는 AI 제안을 만들고, `/coding/publish`는 승인된 경우 **고정된 수리 대상 파일 하나**(`CAUSAL_REPAIR_TARGET`)에 대해서만 검증된 패치를 게시한다(파일 수·경로 불일치는 `CAUSAL_REPAIR_TARGET_MISMATCH`로 거절).
- **인과 승인 경로의 게시는 항상 초안(Draft)이다.** ("자율 시스템 전체가 비초안 PR을 절대 만들지 못한다"는 뜻이 아니다. 아래 "다른 자율 PR 생성자" 참조.) `githubValidatedPatchPublisher.ts`는 `draft: true`로만 PR을 만들고("Autonomous publication is always Draft. Ready-for-review requires a separate, explicit control-plane transition") 이 불변 조건은 테스트(`githubValidatedPatchPublisher.test.ts`: "autonomous publication must remain Draft")로 보호된다(관련 17개 통과). `apps/autopilot`에는 초안을 해제하는 코드가 없다. 따라서 **카나리의 최악의 결과는 자율개발이 올린 초안 PR 한 건**이다. 자동 병합은 일어나지 않는다. 감사와 릴리스는 비초안 PR만 진행시킨다(sticky HOLD #1876).
- **그러므로 전용 보류 스위치를 새로 만들지 않는다.** 초안 불변 조건이 보류 장치다. 대신 창 동안 다음 규칙을 둔다.
  1. 자율개발이 올린 초안 PR은 **카나리가 양성 경로를 실제로 통과했다는 증거**이지 실패가 아니다. 읽고 기록하되 **초안을 해제하지 않고 병합하지 않는다.** `ready_for_review` 이벤트는 감사 경로를 시작시키므로(`index.ts`의 PR_CHANGED 처리), 오너를 포함해 아무도 그 PR을 초안 해제하지 않는다.
  2. `R`이 병합되면 그 초안 PR은 오너가 닫는다(결과 기록에 번호를 적는다). 자율개발은 같은 실행에 대해 중복 PR을 만들지 않는다(`existingPulls` 검사로 확인).
  3. 초안이 아닌 PR이나 자동 병합 징후가 보이면 **즉시 중단 조건**이다(원인은 불변 조건 위반이다).
- **다른 자율 PR 생성자 (독립 검증 P1-1, 2026-11-06 확인):** `.github/workflows/autopilot-codex-coding.yml`(시간당 cron + `pull_request_target`)은 오너의 **백로그 이슈**를 구현해 `gh pr create`를 `--draft` **없이** 개인 토큰(`NUSA_AUTOPILOT_GITHUB_TOKEN`)으로 연다. 빨간 main이나 인과 승인과는 무관한 별도 경로이고, 그 PR도 CI·Audit·Release를 통과해야 병합된다. 이 워크플로는 **지금 GitHub에서 `disabled_manually`**(2026-10-12 이후, 마지막 실행 2026-10-12)이며 해당 접두어(`autopilot/codex/`)의 PR도 없다(읽기 전용 확인). 창 안에 켜져 있으면 병합 동결(위 3번)을 깰 수 있으므로 **창 시작 직전에 `disabled_manually` 상태를 다시 확인하고, 창 동안 감시 대상에 넣는다.** 켜져 있으면 오너가 창 동안 끈다(저장소 설정 변경은 오너 몫이다).
- **초안 PR의 내용은 대상 파일 안에서는 제한이 없다 (P2-1).** 변경은 `repairableWorkflowRun.ts` 한 파일로만 갇히지만(엄격한 한 파일 diff, 헤더 경로 일치, 서명된 제안 영수증), 그 파일 안의 어떤 줄이든 바꿀 수 있다(분류기 자체 포함). 병합하지 않는 초안으로는 무해하다. 위 규칙 1이 이를 막는다(절대 병합하지 않는다).
- **#2994 병합 뒤 재확인 (P2-2):** #2994는 패치 적용기의 간격 검사를 느슨하게 하지만(파일 한 개 제한은 그대로) 새 검증 경로는 기본 꺼져 있고(`NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED`) 게시기를 부르지 않는다. 창 전에 병합된 main에서 이 분석을 다시 확인한다.
- **용어 (P2-3):** 감사를 시작시키는 것은 `ready_for_review` 이벤트만이 아니다. 초안이 아닌 PR이 `opened`/`synchronize` 이벤트에서 CI 통과하면 `PR_CI_SUCCEEDED`로 감사로 간다. 초안은 감사 경로가 네 군데에서 독립적으로 거절한다(`githubExecutor.ts`의 `github-executor-pr-draft-hold-active`, 감사·릴리스 워크플로의 `draft=true → applicable=false`, 병합 직전 `draft=false` 단언, 실행 소비자의 초안 검사).
- **독립 검증 (2026-11-06, PR #2998 리뷰, 대상 `bef962d`): HOLDS_WITH_NOTES.** 승인 경로에 한해 주장이 성립한다. 코드 전체에서 `ready_for_review` 전환, 자동 병합, 병합 호출은 감사·릴리스 워크플로의 병합 한 곳뿐이다. 자율개발 테스트 265개 통과. 저장소만으로는 확인할 수 없는 것: 실제 브랜치 보호·룰셋·우회 주체, 저장소 자동 병합 설정, 병합 대기열, 토큰 권한 범위, Cloudflare 시크릿.
- 이 확인은 코드와 테스트 수준이다. 실제 소비 검증기(#2994)가 main에 들어간 뒤 같은 경로가 어떻게 동작하는지, Workers AI 호출(`ZERO_CREDIT_MODE=true`로 유료 추론은 막힘)이 이 경로에서 어디까지 가는지는 **실행해 보기 전에는 확정할 수 없다.**

## 확인하지 못한 것
- 빨강 자체는 확정(위 3번)이고, `C`를 넣었을 때 함께 실패하는 기존 테스트는 3개로 확인했다(위 "C와 R 준비 결과"). 다만 GitHub Actions의 보호된 main에서 실제 CI가 어떻게 빨개지는지는 로컬에서 재현할 수 없다.
- 병합 대기열과 PR 필수 검사가 빨간 main에서 어떻게 동작하는지는 확인하지 못했다.
- `attest-causal-regression`의 증명서를 소비하는 검증기가 #2994 안에서 어디까지 구현되었는지 전부 읽지는 않았다.
- 진짜 Sigstore 검증(Fulcio·Rekor)을 이 샌드박스에서는 돌릴 수 없다. 실제 GitHub 실행에서만 확인된다.
- 카나리 동안 다른 PR이 받는 영향의 크기는 추정하지 않았다.

## #2994 병합 뒤 상태 (2026-11-06 13:14 KST 병합, main `ecdf774`, 읽기 전용)
- #2994는 Audit PASS 뒤 `nusa-release-authority[bot]`이 병합했다. 위 "실행 전 승인 조건" 1번은 **충족**으로 바뀐다. 열린 스레드 2건은 해결되어 있었다.
- 새 main에서 `repairableWorkflowRun.ts`의 blob은 그대로 `865c7fb4…`이고 자율 패치 게시는 여전히 `draft: true`다.
- `C`는 깨끗하게 적용되고(`c7fa7a8d…`), `R`(역적용)은 `865c7fb4…`로 정확히 되돌린다. `C`를 적용하면 `causalRegressionContract`와 `repairableWorkflowRun` 테스트가 각각 의도대로 1개씩 실패한다.
- **아직 미충족:** 새 main에서의 실제 디스패치(Gate A) 라이브 동작 확인, 새 소비 검증기 경로의 Draft-only 재분석(P2-2), 이름 지정된 감시자, 오너가 정할 날짜·시간대(KST)와 중단 한도, `autopilot-codex-coding.yml` 비활성 재확인. 이 문서는 실행 승인이 아니다.
