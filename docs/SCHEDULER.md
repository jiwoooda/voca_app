# 복습 일정 계산 설정

- 라이브러리: `ts-fsrs` **5.4.2** (FSRS-6, 버전 고정, lockfile 포함)
- 계산 위치: Supabase Edge Function `review` (서버 시각 사용). 브라우저가 보낸 상태값은 무시.

| 설정 | 값 | 비고 |
|---|---|---|
| 매개변수 `w` | 라이브러리 기본값 | 개인 최적화 없음 |
| `request_retention` | 사용자 설정 (기본 0.90) | 변경 시 이후 평가부터 적용 |
| `enable_short_term` | `true` | 라이브러리 기본 |
| `learning_steps` | `1m`, `10m` | 라이브러리 기본 |
| `relearning_steps` | `10m` | 라이브러리 기본 |
| `enable_fuzz` | `false` | 라이브러리 기본, 결과 재현 가능 |
| `maximum_interval` | 36500일 | 라이브러리 기본 |

- 라이브러리 결과에 별도 간격 규칙을 덧붙이지 않는다.
- ‘모름’ 카드를 즉시 반복하는 코드를 두지 않는다. 학습 단계에 따라 정해진 시각이 되면 다시 나온다.
- 예측 회상 확률: 한 번도 평가하지 않은 카드는 계산하지 않고 `null`.
- 경과 시간은 `last_review_at`과 서버 평가 시각의 실제 차이로 계산된다(놓친 날을 오답 처리하지 않음).
- 이벤트마다 `scheduler_version`, `parameters_snapshot`, `desired_retention`을 저장한다.
