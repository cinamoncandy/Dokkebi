# 제안: 폐루프의 "후보 1개 배포" 조건이 기본 배분 정책으로는 만들어질 수 없다 (2026-11-12)

상태: **제안. 소유자 결정과 독립 검토 전에는 코드를 바꾸지 않는다.** 자격 심사(PBO, 비용, 파라미터, 경제적 우위, 사전등록 가설)는 어떤 선택지에서도 건드리지 않는다.

## 사실 (코드와 재현 근거)

1. 폐루프 부트스트랩이 PAPER에 배포하려면 `scripts/closed-learning-research-worker.js`의 `projectPaperDeployment`에서 League 배분 항목이 **정확히 1개**여야 한다 (`ALLOCATION_NOT_SINGLE_CANDIDATE` 이외의 경우).
2. 실제 연구 실행(`scripts/research-real-market-run.js`의 `buildResearchRunLeague` 호출)은 배분 정책을 지정하지 않아 **기본 정책**을 쓴다: 후보당 최대 0.4, 가족당 최대 0.5, 최대 5개, 증거 폭 최소 0.5.
3. 기본 정책에서 자격 통과 후보 수별 결과 (`tests/league-allocation-single-candidate-gap.test.js`로 고정):

| 자격 통과 후보 | 결과 |
|---|---|
| 0 | 거부 `NO_ALLOCATABLE_CANDIDATES` |
| 1 | 거부 `INSUFFICIENT_DIVERSIFICATION_CAPACITY` (후보 1개는 최대 40%라서 100%를 못 나눈다) |
| 2 | 거부 `INSUFFICIENT_DIVERSIFICATION_CAPACITY` |
| 3~5 | 항목 3~5개 → 워커가 `ALLOCATION_NOT_SINGLE_CANDIDATE`로 배포 불가 |
| 6 이상 | 항목 5개 → 같은 이유로 배포 불가 |

   **항목이 정확히 1개가 되는 경우가 없다.** 후보 품질과 무관하게 이 경로로는 배포 가능 판정이 나올 수 없다.
4. 소유자 기준선 전략은 `maximumCandidateWeight: 1, maximumCandidateCount: 1, maximumFamilyWeight: 1` 정책(`apps/cloud/src/ownerBaselinePaperStrategy.ts`)을 따로 써서 이 문제가 없다. 그 정책이면 후보가 4개여도 1순위 한 개만 항목이 된다.

## 지금 서버 상태와의 관계

2026-11-12 `/health`: `bootstrap=RESEARCH_NOT_DEPLOYABLE`, `bootstrapReasons=["NO_ALLOCATION_ADVISORY"]`, 연구 과적합률 95%. 이 이유만으로는 아래 둘을 구분할 수 없다.

- (가) 자격 통과 후보가 0개 (`NO_ALLOCATABLE_CANDIDATES`): 관문이 제 역할을 하는 중이며 풀 이유가 없다.
- (나) 후보 1~2개 (`INSUFFICIENT_DIVERSIFICATION_CAPACITY`): 위 구조적 불일치.

동반 변경(워커가 거부 코드를 `ALLOCATION_<코드>` 이유로 함께 내보냄)이 릴리스되면 둘을 구분해서 읽을 수 있다. **구분이 되기 전에는 아래 선택지를 실행하지 않는다.**

## 선택지

- **A. 연구 실행이 단일 후보 정책을 쓴다.** 폐루프용 League/배분 정책을 `{ maximumCandidateWeight: 1, maximumCandidateCount: 1, maximumFamilyWeight: 1 }`로 지정한다. 자격 통과 1순위 후보 한 개가 항목이 된다. 연구 결과의 "배분 권고"가 분산 배분이 아니라 1순위 집중이 되므로 **연구 산출물의 의미가 바뀐다.** 다른 소비처가 그 권고를 읽는지 먼저 조사해야 한다.
- **B. 워커가 다중 항목에서 1순위만 고른다.** 배분 결과는 그대로 두고, 워커가 `rank` 1위인 자격 통과 항목 하나를 배포 후보로 쓴다. 산출물은 안 바뀌지만, 워커 규칙이 "단일 배분"에서 "1순위 선택"으로 바뀌고 `researchWeight`의 의미가 달라진다.
- **C. 아무것도 바꾸지 않는다.** 자격 통과 후보가 3개 이상 나올 때까지 폐루프는 소유자 기준선만 돌린다. 이 경우에도 3개 이상이면 `ALLOCATION_NOT_SINGLE_CANDIDATE`로 막히므로 사실상 영구 대기다.

## 권고

1. 동반 변경을 릴리스해서 (가)와 (나)를 먼저 구분한다.
2. (가)면 아무것도 바꾸지 않는다. 후보를 만드는 일(호가 연구 2차 등)이 먼저다.
3. (나)나 3개 이상이면 **A와 B 중 하나를 소유자가 고른다.** 어느 쪽이든 자격 심사 기준과 PAPER_ONLY, `liveAuthority=NONE`, `aiAuthority=ZERO_AUTHORITY`는 그대로이고, 독립 검토를 먼저 받는다.

## 하지 않는 것

PBO, 비용, 파라미터, 경제적 우위 관문의 완화, 임계값, 위험 한도, 자본, 권한 변경. 배분 정책을 바꾸는 것은 연구 권고 가중치의 형태를 바꾸는 일이며 실행 권한과 무관하다.
