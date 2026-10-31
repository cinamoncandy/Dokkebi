# 설계: K-of-N 롤링 홀드아웃을 오케스트레이터에 연결 (설계만, 구현 전)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false. 연구 증거만 만든다. 통과 기준·임계값·일일 예산·위험 한도는 이 설계에서 바꾸지 않는다.
전제: 소유자가 N=3, K=2를 승인했다(2026-10-31). 부품은 PR #2973에 있다 (`researchRollingHoldout.ts`, `researchRollingRunner.ts`, 아직 어디서도 호출되지 않음).

## 읽고 확인한 연결 지점 (`researchExperimentOrchestrator.ts`)
- 한 tick마다 (변종 variant × 마켓)에 대해 `runResearchExperiment`를 한 번 호출한다 (`endCloseMs` = 그 마켓의 최신 종가 시각).
- 결과는 `VALIDATION_<결과>`, `HOLDOUT_<결과>` 또는 `holdoutNote`로 센다. 메타 학습의 `holdoutPasses`는 `HOLDOUT_CHALLENGER_BETTER` 개수에서 나온다 (`researchMetaLearning`의 runtime 항목).
- 세션의 `maxExperiments`와 `dailyBudgetPerVariant`는 `variant.runtime.runExperiment` 호출 수에 묶여 있다.
- 데이터셋 매니페스트는 마켓·봉 길이별 `latest(...)` 하나이고, 실행기는 `endCloseMs`가 그 범위 안인지 확인한다.

## 1. 그림자(shadow) 모드 먼저
- 새 환경 설정 `NUSA_RESEARCH_ROLLING_HOLDOUT` = `OFF`(기본) / `SHADOW` / `ENFORCE`.
- `SHADOW`: 기존 단일 홀드아웃 흐름은 **그대로** 돌고, 그 결과가 나온 같은 후보에 대해서만 롤링 검사를 추가로 돌려 `ROLLING_*` 카운터만 올린다. `HOLDOUT_*`, 메타 학습, 승급 후보에는 영향을 주지 않는다.
- `ENFORCE`는 소유자가 `SHADOW` 결과를 보고 따로 승인한 뒤에만 연다. `ENFORCE`에서는 롤링 PASS 1회를 `HOLDOUT_CHALLENGER_BETTER` 1회로, 롤링 FAIL을 `HOLDOUT_*` 불통과 1회로 센다 (구간별 개수가 아니라 후보당 1회).

## 2. 예산 계산 (소유자 결정 필요)
- 롤링 검사는 후보당 `runExperiment`를 최대 6번(검증 3 + 홀드아웃 3) 부른다.
- 선택지 A (추천): 후보당 1회로 센다. 일일 예산은 "시험한 후보 수"를 제한하는 다중 비교 통제 장치이기 때문이다. 같은 후보를 구간별로 다시 보는 것은 후보 수를 늘리지 않는다.
- 선택지 B: 호출 수로 센다. 하루에 시험할 수 있는 후보가 3~6분의 1로 줄어든다.
- 어느 쪽이든 예산 상한 값은 올리지 않는다.

## 3. 홀드아웃 사용 기록 (이미 안전하게 동작)
- 구간마다 서로 다른 `endCloseMs`를 쓰므로 홀드아웃 키(후보 설정 해시 + 마켓 + 봉 + 구간)가 달라서, 구간마다 따로 한 번씩만 쓴다.
- 같은 후보를 다음 날 다시 돌리면 구간이 하루 밀려서 이전 홀드아웃과 겹친다 → `HOLDOUT_OVERLAPS_USED` → 구간 결과 INSUFFICIENT → 롤링 결과 증거 부족. 즉 후보는 구간이 2일 이상 밀린 뒤에야 다시 시험된다. 기존 단일 홀드아웃과 같은 성질이다.

## 4. 카운터 이름
- 구간별: `ROLLING_FOLD_CHALLENGER_BETTER`, `ROLLING_FOLD_NOT_BETTER`, `ROLLING_FOLD_INSUFFICIENT`.
- 후보별: `ROLLING_PASS`, `ROLLING_FAIL`, `ROLLING_INSUFFICIENT_EVIDENCE`, 거절은 `ROLLING_REFUSED_<이유>`.
- 모두 기존 코드 형식(`^[A-Z][A-Z0-9_]{1,47}$`)을 따른다. 서로 다른 일반 키 개수 상한(`MAX_ORDINARY_COUNT_KEYS`)을 확인하고 필요하면 파생 키로 분류한다.

## 5. 이력 길이와 백필
- 구간이 겹치지 않으려면 N×(훈련+검증+홀드아웃) = 33일 + 하루 여유가 필요하다 (현재 백필 목표는 12일: `targetSpanMs`).
- 백필 목표를 `OFF`일 때는 지금 값, `SHADOW`/`ENFORCE`일 때만 `requiredHistoryMs(windows) + DAY`로 늘린다. 업비트 호출은 지금처럼 순차·간격·시간 제한·페이지 제한을 지킨다.
- 데이터셋 매니페스트는 33일 범위를 덮도록 만든다. 실행기의 범위 확인(`endCloseMs`가 매니페스트 범위 안)은 그대로다.
- 서버 부하(4 vCPU / 8 GB)와 업비트 속도 제한은 배포 전에 `SHADOW` 켠 날 진단으로 확인한다.

## 6. 안 바꾸는 것
- 통과 규칙, 임계값, 사전 등록(precommit) 절차, 일일 예산 상한, 위험 한도, 권한.
- `runResearchExperiment`(단일 구간 실행기). 롤링은 그것을 구간마다 호출할 뿐이다.

## 7. 검증 계획
- `OFF`에서 오케스트레이터의 결과가 지금과 완전히 같음을 기존 테스트로 고정.
- `SHADOW`에서 `HOLDOUT_*`·메타 학습 입력이 변하지 않음을 테스트로 고정.
- `ENFORCE`에서 롤링 PASS는 개별 통과가 2개 이상일 때만 `HOLDOUT_CHALLENGER_BETTER`가 됨 (이미 #2973에서 27가지 전수 확인).
- 데이터 부족 시 `ROLLING_REFUSED_*`가 되고 홀드아웃 기록은 하나도 남지 않음 (#2973에서 확인).
- 서버에서: `SHADOW` 1~2일 뒤 진단의 `ROLLING_*` 카운터를 읽는다.

## 소유자 결정
1. 예산 계산: A(후보당 1회, 추천) 또는 B(호출 수).
2. `SHADOW`를 먼저 켜고 며칠 지켜본 뒤 `ENFORCE`를 따로 승인하는 순서.
3. 33일+ 백필 허용(서버 부하 확인 포함).
4. 적용할 봉 길이(1m / 15m / 60m 중).

## 아직 확인하지 않은 것
- `MAX_ORDINARY_COUNT_KEYS` 값과 파생 키 분류 규칙의 정확한 한계.
- 매니페스트 갱신 시점과 33일 범위의 호환 (`datasetIdForMarket`의 `latest`).
- 실제 서버의 백필 소요 시간.
