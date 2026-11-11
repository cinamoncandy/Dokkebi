# 왜 포지는 아직 스스로 코드를 개발하지 못하나 (2026-11-11, 증거 정리)

Safety stays: PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, aiAuthority=ZERO_AUTHORITY. 이 문서는 어떤 동작도 바꾸지 않는다.

## 한 줄 결론
L1은 "검증기가 맞게 동작한다"까지만 증명했고, 그 실행은 결정론적 제안 어댑터와 빈 샌드박스를 썼다(`docs/FORGE_L1_VERIFICATION_RUNBOOK.md`). 스스로 코드를 쓰는 단계는 스위치 하나가 꺼져 있어서가 아니라, 켜도 쓸모 있는 코드가 나오지 않는 세 가지 이유 때문에 막혀 있다.

## 확인한 사실
1. **스위치는 소유자가 일부러 꺼 두었다.** `.github/workflows/autopilot-execution-consumer.yml`의 코딩 작업은 저장소 변수 `NUSA_AUTOPILOT_CODING_ENABLED`가 `'true'`일 때만 돈다. 2026-10-13 소유자 결정(`WO-AUTOPILOT-20261013-CODING-OFF`): Workers AI 엔진은 평생 12개 PR 중 1개만 병합됐고, 마지막 일주일은 119개 병합 PR 중 0개였다. 코드는 남겨 두어 되돌릴 수 있다.
2. **엔진이 낸 PR은 실질이 없었다.** 마지막 12개 PR(#1847~#2367) 중 병합은 #2294 하나다. #2294, #2295, #2367을 열어 보면 모두 같은 파일 `apps/autopilot/src/concurrencyAdvisor.ts`에 한 줄 추가(+1 -1)다. 나머지는 이미 병합된 작업의 중복이라 `SUPERSEDED`로 닫혔다. 즉 "일은 한 것처럼 보이지만 같은 한 줄을 반복"했다.
3. **무엇을 고칠지 고르는 부분이 연결되어 있지 않다.** 실행 봉투의 목표는 항상 "검증된 main 증거에서 가장 가치 있는 안전한 엔지니어링 개선을 이어간다"(`prepareProductionExecution`)이고, 기회 계획·순위(`opportunityPlanner.ts`)와 진화 선택·순위·승급(`evolve*.ts`)은 `unwiredControlPlaneDebt.ts`에서 호출처가 없다. 엔진은 구체적인 과제 없이 모호한 목표만 받았다.
4. **허용 범위가 좁다.** 같은 봉투가 `apps/autopilot/`, `.github/workflows/`, `scripts/`에 최대 12파일, `mutationAllowed=false`로 고정이다. 이는 안전 불변식이므로 독립 Validator 검토와 소유자 승인 없이는 바꾸지 않는다.

## 그래서 스위치만 켜면 어떻게 되나
같은 한 줄 PR이 다시 쏟아진다. 감사와 릴리스 경로가 막아 주므로 해는 없지만 쓸모도 없고, 비용만 든다(`NUSA_AUTOPILOT_ZERO_CREDIT_MODE=true`로 비용은 0에 가깝게 묶여 있으나 엔진 능력은 그대로다).

## 해결 순서 (스위치는 마지막)
1. **과제를 구체적으로 만든다.** 학습 폐루프의 막힘(`/health`의 `learningLoopVerdict`), 실패한 CI, 장부의 연결 안 된 함수처럼 **증거가 있는 일**을 기회 목록으로 만들고, 기회마다 "무엇이 참이어야 완료인가"를 시험으로 적는다. 이것이 `opportunityPlanner` 쪽 연결이다 (로드맵 3단계).
2. **중복과 무의미한 변경을 거른다.** 이미 병합된 작업과 겹치거나, 시험을 바꾸지 않는 변경은 PR 이전에 버린다 (`SUPERSEDED`로 닫히는 일을 앞에서 막는다).
3. **제안을 샌드박스에서 검증한 뒤에만 게시한다.** L1에서 검증된 격리 경로 위에서, 이번에는 결정론적 어댑터 대신 실제 제안을 만들고 그 제안에 대한 시험 통과를 영수증에 남긴다. 처음에는 PR 없이 영수증만 남기는 단계로 한다.
4. **코딩 엔진을 정한다.** Workers AI(무료, 능력 낮음) 대 더 강한 모델(비용). 이 선택은 소유자의 비용 정책이고 비밀 값(API 키)이 필요하다. 이 문서는 정하지 않는다.
5. **그 뒤에야** `NUSA_AUTOPILOT_CODING_ENABLED`를 켠다. 첫 켬은 초안 PR만, 하루 상한, 자동 병합 없음(병합은 Audit와 Release 경로)으로 시작한다.

## 소유자만 정할 수 있는 것
- 4번 코딩 엔진과 비용 한도, 필요한 비밀 값의 등록.
- `mutationAllowed=false`와 허용 범위(12파일)를 넓힐지.
- 저장소 변수 `NUSA_AUTOPILOT_CODING_ENABLED`는 저장소 설정이라 이 세션의 도구로는 바꿀 수 없다. 켜는 것은 소유자가 하거나, 켜는 PR이 아니라 변수 설정이다.

## 확인하지 못한 것
- 12개 PR이 왜 한 줄이었는지의 모델 쪽 원인(제안 프롬프트, 모델 품질)은 로그를 읽지 못했다.
- 10-13 이후 코딩 경로의 코드 변경으로 지금 결과가 달라졌는지.
