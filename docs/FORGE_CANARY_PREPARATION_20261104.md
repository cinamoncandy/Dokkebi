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

> **대체됨 (2026-11-06):** 이 절의 "재실행 금지", "증명서 두 번 이상", "창 동안 Audit 요청 금지"와 성공 기준은 아래 "C′ 독립 검토 결과와 계획 수정"과 "오너 결정" 절로 대체되었다(증명서 최대 3개 허용, 중단 조건 3 변경, `R`만 Audit 예외, 성공 기준 축소). 충돌하면 아래 절이 우선한다.
- PAPER_ONLY / ZERO_AUTHORITY / FAIL_CLOSED 유지. LIVE 활성화, 운영 서버 변경, 비밀 값 사용 없음.
- 한 번만 한다. **같은 실행의 작업 재실행(re-run)도 금지**한다(`run_attempt`가 바뀌면 다른 산출물과 다른 증명서가 생긴다). 검증기의 "한 번만 소비" 주장은 카나리가 쓰고 나면 다시 쓸 수 없다. 증명서 보존 기간은 기존 설정(7일)을 유지한다.
- **자율개발이 그 빨간 main을 집지 않는지 먼저 확인한다.** 빨간 main `CI`는 `isRepairableMainWorkflowFailure`가 고르는 형태(이름 `CI`, 결론 실패, `main`, `push`)와 정확히 같다. `scheduledRuntime`, `dispatchPlanner`, `autopilot-dispatch-retry.js`가 이를 소비한다. 문서가 기대는 Gate A(#2961)는 거절 장치일 뿐 예방 장치가 아니다. 창을 열기 전에 이 실행 모양에 대한 Gate A 거절과 재배정 재시도 동작을 확인하고, 창 동안 지켜볼 담당자를 이름으로 정한다. 확인을 위해 Autopilot의 게이트를 바꾸지 않는다.
- 기존 Risk·Security 게이트와 필수 승인 절차 유지. 게이트 약화·테스트 비활성화·핀 값 수정 없음.
- 합성 증거 금지: 시험 데이터를 만들어 붙이지 않는다. 증명서는 실제 CI 실행에서 나온 것만 쓴다.
- 독립(비작성자) 검토, Audit, Release 게이트를 통과한 뒤에만 `C`를 병합한다.

## 명시적 중단 조건 (하나라도 해당하면 즉시 `R` 병합 후 중단)

> **대체됨 (2026-11-06):** 이 절의 "재실행 금지", "증명서 두 번 이상", "창 동안 Audit 요청 금지"와 성공 기준은 아래 "C′ 독립 검토 결과와 계획 수정"과 "오너 결정" 절로 대체되었다(증명서 최대 3개 허용, 중단 조건 3 변경, `R`만 Audit 예외, 성공 기준 축소). 충돌하면 아래 절이 우선한다.
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

## 창 제안 (2026-11-06 KST, 오너 위임으로 Claude가 제안 — 확정 아님)
오너가 날짜·시간·중단 기준을 Claude에게 맡겼다. 아래는 **제안**이며 오너의 명시적 실행 승인이 있어야만 효력이 생긴다. 승인 전에는 실행하지 않는다.
- **창:** 2026-11-07(토) 10:00–11:00 KST. 오너가 깨어 있고 바로 중단할 수 있는 낮 시간이며, 일 경계(00:00 KST)와 멀다. 자동 예약은 걸지 않는다.
- **중단 한도:** 60분. 60분이 지나면 `R`(역적용)로 되돌리는 PR을 준비하고, 오너가 중단을 결정한다.
- **중단 책임자:** 오너 본인. **감시자:** Claude(읽기 전용).
- **시작 직전 재확인(모두 통과해야 시작):** main 최신 blob `865c7fb4…` 불변, `autopilot-codex-coding.yml` 비활성, 서버 매수·학습 정상, 열린 P0 없음, 보호된 main이 이미 빨갛지 않음.
- 하나라도 어긋나면 창을 취소하고 다음 후보(2026-11-08 같은 시간)로 미룬다.

## 창 동의와 새 main 재확인 (2026-11-06 KST, 읽기 전용, main `ecdf774`)
- **창 동의:** 오너가 위 제안(2026-11-07 10:00–11:00 KST, 60분 한도)에 "그렇게 해"라고 답했다. 시작은 오너가 그 시각에 "시작"이라고 말할 때만이며, 그 전에는 아무것도 바꾸지 않는다. 자동 예약은 없다.
- **Draft-only 재분석(P2-2):** 자율 패치 게시기를 부르는 곳은 `worker.ts` 한 곳이고 게시기는 계속 `draft: true`다. #2994의 격리 검증 경로는 `NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED=true`일 때만 열리고, 그 워크플로(`causal-verification*.yml`)에는 PR 생성이 없다.
- **다른 PR 생성자:** `Autopilot Codex Coding`은 여전히 `disabled_manually`. `Oracle Codex Dev Runner`는 수동 실행(`workflow_dispatch`)뿐이고 PR 생성 단계가 없다.
- **미충족(남음):** 실제 빨간 main에서의 Gate A 라이브 동작은 실행해 보기 전에는 확정할 수 없다. 오너의 브랜치 보호·병합 대기열 확인, 시작 직전 재확인, 오너의 "시작" 지시.

## 브랜치 보호 확인과 C′ (2026-11-06 KST, 오너가 보낸 설정 캡처 기준)

> **대체됨 (2026-11-06):** 이 절의 "재실행 금지", "증명서 두 번 이상", "창 동안 Audit 요청 금지"와 성공 기준은 아래 "C′ 독립 검토 결과와 계획 수정"과 "오너 결정" 절로 대체되었다(증명서 최대 3개 허용, 중단 조건 3 변경, `R`만 Audit 예외, 성공 기준 축소). 충돌하면 아래 절이 우선한다.
**확인한 설정(`main` 규칙):** PR 필수, 새 커밋 시 승인 무효화, 상태 체크 필수(필수 체크는 `nusa/release-authorized` 하나), 병합 전 최신 main 필수, 대화 해결 필수, 우회 금지(관리자 포함). 강제 푸시·삭제는 꺼짐. 병합 대기열은 이 화면에 없다. 룰셋 화면(2026-11-06, 오너 캡처)에는 룰셋이 하나도 없다("You haven't created any rulesets"). 따라서 병합 대기열은 설정되어 있지 않다.

**발견한 문제:** 위 설정에서는 PR CI가 빨간 변경(원래의 `C`)은 `release-authorized`를 받지 못하고 우회도 막혀 있어 main에 들어갈 수 없다. 보호 설정을 풀어서 해결하지 않는다.

**해결안 C′ (PR #3005, DO NOT MERGE 초안):** `C`와 함께 실패하던 테스트 3개를 새 동작에 맞게 고친다(`timed_out`은 복구 대상 아님, 계약 관찰은 `OBSERVED_MISMATCH`). PR CI는 초록이라 Audit를 통과할 수 있고, PR에서 돌지 않는 `causal-regression-contract`가 main 푸시에서만 불일치를 관찰해 빨개진다. 복구 대상을 넓히지 않고 좁히기만 한다. 로컬에서 main `ecdf774`에 적용해 자율개발·인과 계열 975개 모두 통과, 불일치 관찰은 `main-ci-timeout`(기대 true, 실제 false)이다. 되돌리기 `R`은 병합 커밋의 `git revert`다.

**C′의 병합 경로는 정식이다:** 병합은 Audit와 봇을 거치는 일반 경로뿐이다. 이 병합 자체가 오너의 명시적 카나리 승인 뒤에만 일어나며, 그전에는 초안으로 둔다.

**병합 동결 보강:** 필수 체크가 PR 단위라서 main이 빨개져도 다른 PR 병합이 자동으로 막히지는 않는다. 창 동안 Audit 요청과 초안 해제를 하지 않는다. 병합 전 최신 main 필수 규칙 때문에 빨간 main을 합친 PR은 대부분 CI가 빨개져 막힌다(보조 효과, 보장은 아니다).

**미충족(추가):** C′의 독립 검토, 위 시작 직전 재확인, 오너의 "시작".

## C′ 독립 검토 결과와 계획 수정 (2026-11-06 KST, PR #3005 검토 `5796723397`, 판정 PASS_WITH_NOTES, P0 없음, P1 2건)
코드 diff는 주장대로 안전하다(한 줄 좁히기, 테스트 3건은 범위가 한정된 정당한 변경, 975/975 통과). 그러나 계획 자체에 두 가지 사실이 빠져 있었고, 이 문서의 이전 서술 중 해당 부분은 **이 절로 대체한다.**

**P1-1. 이 `C′`로는 `CODE_ACTIONABLE`이 나올 수 없을 가능성이 매우 높다.** 불일치 사례는 `main-ci-timeout`인데, 승인 단계는 이 사례에 원본 실행 결론이 `timed_out`이기를 요구한다(`causalRegressionAdmission.ts:149-150`, 구조 검사 `:201-202`). 카나리의 실제 원본 실행은 `failure`이므로 `CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT`로 거절될 가능성이 크다(라이브로는 미확인). 더 닫힌 쪽의 결과라 위험은 아니지만, 이전 "성공" 정의와 "초안 PR 한 건은 예상된 양성 경로 증거"는 이 `C′`로는 성립하지 않는다.
- **수정된 성공 기준(오너 확인 필요):** main 푸시에서 불일치 관찰 → 증명서 생성 → Sigstore 서명 → 정확한 source identity 검증까지를 확인하고, 승인 단계가 닫힌 채 거절하는 것까지를 "관찰된 안전한 결과"로 기록한다. 진짜 `CODE_ACTIONABLE`(양성 종단 경로)은 이 카나리로 **증명하지 못한다.**
- 대안 후보(권하지 않음, 별도 검토 필요): `failure` 사례를 어긋나게 하는 다른 좁히기. 단 `failure`를 복구 대상에서 빼면 빨간 main이 복구 대상에서 빠진다.

**P1-2. Release가 실패한 main CI를 자동으로 재실행한다.** 병합 뒤 Release의 post-merge 단계가 정확한 main CI 성공을 최대 약 13분 기다리며 실패 시 `rerun-failed-jobs`를 봇이 호출한다(`autopilot-deterministic-audit-release.yml:474-519`, 3회째 재시도 소진 시 `exit 1`). 그래서 `causal-regression-contract`가 계속 실패하고 `attest-causal-regression`이 다시 돌아 **증명서가 최대 3개**(`run_attempt` 1~3) 생길 수 있다. 이전 필수 조건 "재실행 금지"와 중단 조건 3("증명서가 두 번 이상")은 **병합 뒤 약 10분 안에 자동으로 충족**된다.
- **수정:** "한 번만"은 "봇의 자동 재실행으로 증명서 최대 3개는 정상"으로 고친다. 원본 시도(attempt 1)와 재시도 산출물을 구분해 함께 보존한다(7일 보존 기간 안에 내려받아 해시 기록). 중단 조건 3은 "4개째 또는 서로 다른 source identity"로 바꾼다. 이 허용 범위는 오너가 알고 승인해야 한다. Release 실행이 빨갛게 끝나고 이후 배포 단계가 건너뛰어지는 흔적이 남는다(Release/HOLD 상태에 남는 영향은 미확인).

**P2.** (a) 병합 동결 규칙은 `R` 자신과 충돌한다: 우회가 막혀 있어 `R`은 초안 해제 + Audit가 유일한 길이므로 "창 동안 Audit 요청 금지"에 `R`의 예외를 명시한다. 빨간 main이 Audit를 막는지는 코드에서 찾지 못했고 미확인이다. (b) 세 번째 테스트는 `status`만 확인하므로 `caseId: main-ci-timeout`, `expected: true`, `observed: false`까지 고정하는 편이 낫다(PR #3005에 반영 예정). (c) PR CI에서 "실제 구현이 계약과 일치한다"는 단언이 사라지므로 `R` 전까지 그 일치는 main 푸시 작업 하나만 지킨다(의도된 것). (d) 배포: 빨간 main에서는 Deploy/Promote가 나가지 않는다(`deployment-convergence-watchdog.yml:130-136`), 비초안 PR은 생기지 않는다(`autopilot-codex-coding.yml`은 `disabled_manually`).

**현재 상태:** 시작 승인 요청이 있었으나 위 P1 때문에 **시작하지 않았다.** 오너가 수정된 성공 기준과 증명서 최대 3개 허용을 확인하고, 창 시각을 다시 정하기 전에는 실행하지 않는다.

## 오너 결정 (2026-11-06 KST): Claude의 추천을 따른다
- **성공 기준 수정을 받아들인다:** main 푸시에서 불일치 관찰 → 증명서 생성 → Sigstore 서명 → 정확한 source identity 검증, 그리고 승인 단계의 닫힌 거절까지를 이 카나리의 목표로 한다. 진짜 `CODE_ACTIONABLE`(양성 종단 경로)은 이 카나리의 목표가 아니며, 증명되었다고 쓰지 않는다. L1은 이 카나리 뒤에도 PARTIAL이다.
- **Release의 자동 재실행을 허용한다:** 증명서 최대 3개(`run_attempt` 1~3)와 Release 실행이 빨갛게 끝나는 흔적을 허용한다. 중단 조건 3은 "4개째 증명서, 서로 다른 source identity, 비초안 PR 생성, 배포·서버 영향"으로 바꾼다.
- **`R` 예외:** 창 동안 Audit 요청 금지에서 `R`(되돌리기) PR만 예외다.
- **C′ 보강(검토 P2):** 세 번째 테스트가 `caseId: main-ci-timeout, expected: true, observed: false`까지 고정한다(PR #3005, 위 커밋). 변경분은 테스트 단언 한 줄이고, 시작 전에 이 변경분만 짧게 재검토한다.
- **창은 아직 확정되지 않았다.** 시작 조건: ① #2973 병합 완료(병합 동결과 겹치지 않게), ② C′ 변경분 재검토 통과, ③ 시작 직전 재확인 통과, ④ 오너의 그 시각 "시작" 지시. 후보는 2026-11-07(토) 10:00 KST, 조건이 안 맞으면 2026-11-08(일) 10:00 KST.

## 창 확정과 예약 (2026-11-06 KST, 오너 지시: "그 시간으로 예약하고 시작해")
- **창:** 2026-11-07(토) 10:00 KST 시작, 병합 뒤 60분 한도. 오너가 중단 책임자이며 그 시간에 연락이 닿아야 한다.
- **예약:** 그 시각에 Claude 세션에 시작 알림이 한 번 들어간다(예약 `trig_01BM6RRaf2MSuY37myUSra2A`). 알림을 받으면 먼저 시작 직전 재확인(대상 파일 blob `865c7fb4…`, `Autopilot Codex Coding` 비활성, main이 이미 빨갛지 않음과 진행 중인 다른 병합 없음, 서버 정상, 열린 P0 없음, #3005가 초안 그대로)을 하고, **하나라도 어긋나면 아무것도 하지 않고 취소**한 뒤 2026-11-08 10:00 KST를 제안한다.
- **재확인이 모두 통과하면:** #3005에 main을 합치고(Audit는 기준 main이 같아야 한다) 새 CI가 초록인지 확인한 뒤 초안을 해제해 Audit를 시작한다. 오너가 시작을 미리 승인했으므로 그 시각의 별도 "시작" 지시는 필요 없지만, 오너는 언제든 중단을 지시할 수 있다.
- **변하지 않는 것:** 병합은 봇만 한다. 보호 설정·워크플로·게이트·서버는 건드리지 않는다. 창 동안 `R`을 제외한 다른 PR의 초안 해제와 Audit 요청을 하지 않는다. 성공 기준은 "오너 결정" 절의 축소된 기준이며 진짜 `CODE_ACTIONABLE`은 주장하지 않는다. L1은 PARTIAL이다.

## 2026-11-07 10:20 KST: 시작 시도와 중단 (카나리는 main에 들어가지 않았다)
- 10:01 재확인에서 "열린 P0 없음"이 걸렸다(#2770, #2589는 오래된 추적 이슈). 오너가 "알고 있고 막지 않는다"고 선택해 진행했다.
- 10:09 `#3005`를 초안 해제해 Audit를 시작했으나 Audit가 `EXACT_HEAD_PAPER_AUDIT_REJECTED:RUNTIME_SAFETY_SMOKE_NOT_PASS`로 거절했다. PR 단계 CI 확인은 모두 성공이었고, 거절 근거는 `wo-0059-actual-paper-runtime.yml`이 만든 증거 파일의 `runtime_observation.status=INCOMPLETE`, `stop_reason=EVENT_EVIDENCE_TRUNCATED`(60초 동안 결정 이벤트 73건, 거래가 활발한 시장 KRW-CYBER)였다. 같은 검사가 #3006 head(`9c3514e`)에서는 PASS(13건, KRW-SOL)였다.
- 해석(추정, 두 증거 파일 비교): 활발한 시장이 뽑히면 이벤트 증거가 한도를 넘어 잘려 어떤 PR이든 Audit에서 떨어질 수 있는 증거 설계의 허점이다. 카나리 변경과는 무관하다.
- 조치: `#3005`는 다시 초안으로 되돌렸다. main·서버·코드는 바뀌지 않았고 병합이 없었으므로 60분 시계는 시작되지 않았다.
- 오너 결정: 증거 잘림 문제를 먼저 고친 뒤 카나리를 한다(재실행으로 우연히 통과시키지 않는다). 새 창은 그 수정이 병합되고 Audit가 정상으로 돌아온 뒤 오너와 다시 정한다.

## 카나리 결과 (2026-11-07 KST, 실행 완료·되돌림 완료)
**한 줄:** 실제 보호된 main에서 계약 불일치를 관찰했고, 첫 시도에서 Sigstore 증명서가 생성·서명되었다. 증명서 묶음 파일은 올라가지 않았고, 소비 검증기 승인·거절 단계는 관찰하지 못했다. L1은 PARTIAL이다. `CODE_ACTIONABLE`은 주장하지 않는다.

### 타임라인 (KST)
| 시각 | 사건 |
|---|---|
| 10:01 | 시작 직전 재확인에서 "열린 P0 없음"이 걸렸다(#2770, #2589). 오너가 막지 않기로 결정. |
| 10:09 | `#3005` 초안 해제 → Audit 거절(`RUNTIME_SAFETY_SMOKE_NOT_PASS`, 증거 잘림). 초안으로 되돌림. 병합 없음. |
| 12:00 | `#3010`(증거 연속성 수정)이 봇을 통해 병합(독립 검증 PASS_WITH_NOTES 후). |
| 12:12 | PAPER 증거가 `PAPER_ORDERBOOK_UNRECONCILED`로 12ms 만에 실패 → 오너 승인으로 정확히 1회 재실행 → 통과. |
| 13:01 | 재확인 통과, `#3005` 초안 해제, Audit 통과. |
| 13:02:56 | 봇이 `#3005`를 병합(`96e8b8b`). 60분 감시 시작. |
| 13:03~13:12 | main CI(run `42336691050`) 시도 1~3: `causal-regression-contract` 실패(`OBSERVED_MISMATCH`), Release가 실패 작업을 자동 재실행. |
| 13:33 | 다른 PR `#3011`이 병합되어 두 번째 main CI(run `42338949247`, 다른 sha) 시도 1~3이 같은 패턴으로 실패. |
| 14:00 | 감시 종료, 되돌리기 PR `#3012`(R) 준비. |
| 14:04 | R의 CI 중 Cloudflare 점검(`preflight`)이 실패하고 P0 `#1461`이 갱신되어 Release가 직렬화됨. |
| 14:35 | 오너 승인으로 R 본문에 `Resolves #1461` 추가. |
| 14:52 | 봇이 R을 병합(`3241c52`). 대상 blob이 `865c7fb4…`로 복원. 새 main CI 성공, Cloudflare 배포 2건 성공. |
빨간 main이었던 시간은 약 1시간 50분(13:03~14:52).

### 관찰된 것 (사실)
- 불일치: `REPAIRABLE_WORKFLOW_POLICY_V1`, 사례 `main-ci-timeout`, 기대 true, 관찰 false. 영수증의 source는 `cinamoncandy/NUSA`, `ci.yml@refs/heads/main`, push, job `causal-regression-contract`, sha `96e8b8b…`, run `42336691050`, attempt 1.
- 서명: Sigstore Public Good 인증서로 `receipt.json`(sha256 `a20ff04d…`)에 대한 증명서를 만들고 Rekor(logIndex 3729194207)와 GitHub 증명서(64763526)에 올렸다.
- 영수증 해시(앞 16자): run `42336691050` 시도 1/2/3 = `a20ff04da084af76` / `5177886e8de44d86` / `d8ccf9ffe12e2526`; run `42338949247` 시도 1/2/3 = `f2636d773306963c` / `1392ca911a266f77` / `1c8e89dd3bb0e996`. 보관 산출물 이름은 `nusa-causal-repairable-v1-1..3`이다.
- 비초안 자율 PR, 배포, 서버·Oracle 영향은 없었다.

### 확인하지 못한 것
- `nusa-causal-attestation-N` 산출물이 없다: 증명서 묶음 업로드 단계(`Upload signed observation bundle`)가 3번 모두 "`artifacts/causal-regression/attestation.json` 없음"으로 실패했다. 그래서 소비 검증기가 받을 묶음이 없다. 원인은 아직 읽지 못했다(별도 작업).
- 소비 검증기 승인·거절(`CODE_ACTIONABLE` 또는 닫힌 거절), 라이브 Gate A, 시도 2·3의 개별 서명은 확인하지 못했다.

### 새로 알게 된 설계 허점과 교훈
1. **빨간 main이 정상 경로로 복구되지 않는 연쇄:** main CI 실패 → 배포 없음 → Cloudflare 점검 실패 → P0 `#1461` 갱신 → Release 직렬화(`NO_ACTION Release serialized before Audit`). PR 본문의 `Resolves #<P0>`라는 설계된 통과 규칙으로만 풀렸다. 다음 카나리 전에 이 경로를 계획서에 적거나 구조를 개선해야 한다.
2. **P0 확인은 라벨이 아니라 제목(`P0:`)과 `Refs #903` 본문으로 해야 한다.** 이번 사전 확인은 라벨만 봐서 `#1461`을 놓쳤다.
3. **창 동안 다른 PR이 병합될 수 있다.** 필수 체크가 PR 단위라서 막을 수 없었다(`#3011`). 동결은 오너·ChatGPT 쪽 합의가 필요하다.
4. **PAPER 런타임 증거는 시작 시점에 불안정하다**(`PAPER_ORDERBOOK_UNRECONCILED`, 12ms 실패 1회). 증거 이벤트 잘림은 `#3010`으로 고쳐졌다.
5. **Release의 자동 재실행**은 예상대로 증명서 시도를 3개로 늘렸다.
6. **Audit는 같은 head·같은 CI 실행에 대해 한 번만 인정**한다. 본문만 고쳐서는 재시작되지 않는다(빈 커밋은 쓰지 않았다).

### 다음 후보
증명서 묶음 업로드 실패 원인 분석과 수정, 소비 검증기 경로 재시도, 빨간 main 복구 경로 개선.

## 다음 카나리 계획 초안 (2026-11-07 KST, 오너 결정: #3013은 다음 카나리와 한 묶음으로 본다, 일정 미정)
첫 카나리가 남긴 것(증명서 묶음 업로드 실패, 빨간 main 복구 연쇄, 창 중 다른 병합, P0 확인 누락)을 반영한 계획이다. 일정과 승인은 아직 없다.

**목표(변경 없음):** 보호된 main 푸시에서 불일치 관찰 → 증명서 생성·서명 → **서명 묶음 산출물 보존(`nusa-causal-attestation-N`)** → 브리지가 서버로 전달 → 서버 검증과 승인의 닫힌 거절 또는 `CODE_ACTIONABLE` 여부 관찰. 마지막 두 단계가 이번의 새 관찰 대상이다. L1은 이 결과가 나와도 오너와 독립 검토 전에는 COMPLETE로 쓰지 않는다.

**사전 조건 (모두 충족해야 창을 연다)**
1. `#3013`(묶음 경로 수정)이 독립 검토(PASS_WITH_NOTES, 완료)를 거쳐 **창 전에** 병합되어 있다. 병합 자체로는 main이 빨개지지 않는다. 오너가 "병합 뒤 첫 main 푸시 실패가 `CODE_ACTIONABLE` 경로로 들어간다"는 점을 알고 승인한다.
2. 창 동안 다른 PR의 병합을 하지 않기로 오너와 ChatGPT가 합의한다(필수 체크가 PR 단위라 시스템이 막지 못한다). 창 직전에 열린 PR, 진행 중인 Audit를 모두 비운다.
3. **P0 확인은 제목과 본문 기준으로 한다:** 제목이 `P0:`로 시작하고 본문에 `Refs #903`이 있는 열린 이슈(Release 직렬화 대상, 예: #1461)와 `P0` 라벨 이슈를 모두 센다. 열려 있으면 오너가 알고 있는지 확인한다.
4. 카나리 변경(C′)을 새 PR로 다시 올린다(첫 카나리의 되돌림을 다시 되돌리는 것은 금지하지 않지만 새 PR, 새 작업 지시서, 새 독립 검토가 필요하다). 테스트 3개 조정, 한 줄 좁히기, PR CI 초록, PAPER 증거 PASS(재실행은 오너 승인 1회까지).
5. 오너가 60분 동안 연락 가능하고 중단 책임자임을 확인한다.

**창 안에서 달라진 점**
- 빨간 main 복구 경로를 미리 적는다: main CI 실패 → 배포 없음 → Cloudflare 점검 실패 → P0 `#1461` 갱신 → Release 직렬화. R(되돌리기) PR 본문에 `Resolves #<해당 P0>`를 처음부터 넣는다. R PR은 병합 직후 바로 만들어 CI와 증거를 받는다.
- 병합 뒤 감시 항목에 추가: `nusa-causal-attestation-N` 산출물 존재와 해시, 브리지의 서버 전달 로그(읽기 전용), 서버의 인과 승인 판정. 승인(`CODE_ACTIONABLE`)이 나오면 그 즉시 R과 중단을 오너에게 여쭙는다. 초안 PR이 만들어지면 자동 병합이 없음을 확인한다.
- Audit는 같은 head·같은 CI 실행에 한 번만 인정되므로, 되돌리기 PR 본문은 처음부터 완성해서 연다.
- 서버 점검은 창 직전, 병합 직후 한 번, 종료 후 한 번 읽는다.

**아직 오너가 정할 것:** 창 날짜·시각(KST), #3013을 창 며칠 전에 병합할지, 창 중 병합 금지 합의 방식, 중단 한도(제안 60분).
